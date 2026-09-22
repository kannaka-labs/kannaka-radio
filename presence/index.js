/**
 * kannaka-presence — the OBC presence layer (ADR-0013, increment 1).
 *
 * A deliberately small daemon, deployed as its own systemd unit so radio
 * restarts never drop city presence. Four bounded responsibilities:
 *
 *   1. PING     — POST /ping every PRESENCE_PING_MS (45s) → Kannaka is online.
 *   2. EVENTS   — hold the SSE stream (/agent-channel/stream, Last-Event-ID
 *                 resume); every city event → NATS KANNAKA.events.obc.<type>
 *                 + local JSONL journal. This daemon NEVER replies to events.
 *   3. CHANNEL  — session manager: POST /golive {title} / POST /endlive /
 *                 GET /status on a loopback control port. While live, the ping
 *                 cadence sustains the session; a watchdog re-fires go-live if
 *                 the server drops is_live out from under an open session.
 *   4. JWT      — custodian of OBC_JWT_FILE (observatory pattern): refreshes
 *                 via POST /agents/refresh on 401 or approaching expiry, writes
 *                 back preserving the file's structure, alerts on failure via
 *                 NATS KANNAKA.events.obc.auth_expiring.
 *
 * Non-goals (see ADR-0013): no content generation, no auto-replies, no
 * autopilot. Presence means reachable and alive, not talking.
 *
 * Every action lands in a hash-chained audit JSONL (steward pattern).
 */

"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");
const http = require("http");
const https = require("https");
const {
  parseEnvFile,
  serializeEnvFile,
  jwtExp,
  auditEntry,
  SSEParser,
  obcSubject,
} = require("./lib");

// ── Config ──────────────────────────────────────────────────
const OBC_API = (process.env.OBC_API || "https://api.openbotcity.com").replace(/\/$/, "");
const OBC_HOST = new URL(OBC_API).hostname;
const JWT_FILE = process.env.OBC_JWT_FILE || "/home/opc/.kannaka-obc.env";
const DATA_DIR =
  process.env.PRESENCE_DATA_DIR ||
  path.join(process.env.HOME || ".", ".kannaka", "presence");
const BIND = process.env.PRESENCE_BIND || "127.0.0.1";
const PORT = parseInt(process.env.PRESENCE_PORT || "8899", 10);
const PING_MS = parseInt(process.env.PRESENCE_PING_MS || "45000", 10);
const WATCHDOG_MS = parseInt(process.env.PRESENCE_WATCHDOG_MS || "120000", 10);
const CONTROL_TOKEN = process.env.GSHUB_ORACLE_TOKEN || "";
const UA = "KannakaPresence/1.0 (+https://github.com/NickFlach/kannaka-radio)";

// Refresh when this close to exp. OBC bot JWTs run ~1y; refresh a week out.
const REFRESH_MARGIN_S = parseInt(process.env.PRESENCE_JWT_MARGIN_S || String(7 * 24 * 3600), 10);

fs.mkdirSync(DATA_DIR, { recursive: true });
const JOURNAL = path.join(DATA_DIR, "events.jsonl");
const AUDIT = path.join(DATA_DIR, "audit.jsonl");
const STATE_FILE = path.join(DATA_DIR, "state.json");

// ── State ───────────────────────────────────────────────────
const state = {
  startedAt: Date.now(),
  jwt: null,
  jwtExp: null,
  ping: { ok: 0, fail: 0, lastOkAt: null, lastError: null, consecutiveFails: 0 },
  sse: { connected: false, events: 0, lastEventAt: null, lastEventId: null, reconnects: 0 },
  session: null, // { title, startedAt, sessionId, refires }
  nats: { connected: false, published: 0 },
};

// Persisted resume state (survives restarts).
try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  if (saved && saved.lastEventId) state.sse.lastEventId = saved.lastEventId;
} catch {}

let lastAuditHash = "";
try {
  const tail = fs.readFileSync(AUDIT, "utf8").trim().split("\n").filter(Boolean).pop();
  if (tail) lastAuditHash = JSON.parse(tail).hash || "";
} catch {}

function audit(action, detail) {
  const e = auditEntry(lastAuditHash, {
    ts: new Date().toISOString(),
    action,
    detail: detail || {},
  });
  lastAuditHash = e.hash;
  try {
    fs.appendFileSync(AUDIT, JSON.stringify(e) + "\n");
  } catch (err) {
    console.error("[audit] append failed:", err.message);
  }
}

function saveState() {
  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ lastEventId: state.sse.lastEventId }, null, 2),
    );
  } catch {}
}

// ── JWT custody ─────────────────────────────────────────────
function loadJwt() {
  // File first (canonical), env fallback (dev).
  try {
    const parsed = parseEnvFile(fs.readFileSync(JWT_FILE, "utf8"));
    if (parsed.vars.OPENBOTCITY_JWT) {
      state.jwt = parsed.vars.OPENBOTCITY_JWT;
      state.jwtExp = jwtExp(state.jwt);
      return;
    }
  } catch {}
  if (process.env.OPENBOTCITY_JWT) {
    state.jwt = process.env.OPENBOTCITY_JWT;
    state.jwtExp = jwtExp(state.jwt);
  }
}

let refreshing = null;
let refreshCooldownUntil = 0;
async function refreshJwt(reason) {
  if (refreshing) return refreshing; // collapse concurrent triggers
  // `refreshing` is cleared in finally, so without a cooldown every new 401
  // started another attempt immediately — dozens of 429s per second.
  if (Date.now() < refreshCooldownUntil) return false;
  refreshing = (async () => {
    console.log(`[jwt] refreshing (${reason})`);
    try {
      const res = await obcFetch("POST", "/agents/refresh", null, { skipRetry: true });
      const fresh = res && (res.jwt || (res.data && res.data.jwt));
      if (!fresh) throw new Error("no jwt in refresh response");
      state.jwt = fresh;
      state.jwtExp = jwtExp(fresh);
      try {
        let parsed;
        try {
          parsed = parseEnvFile(fs.readFileSync(JWT_FILE, "utf8"));
        } catch {
          parsed = parseEnvFile("");
        }
        fs.writeFileSync(JWT_FILE, serializeEnvFile(parsed, { OPENBOTCITY_JWT: fresh }));
      } catch (e) {
        console.error("[jwt] write-back failed:", e.message);
      }
      audit("jwt_refreshed", { reason, exp: state.jwtExp });
      natsPub("KANNAKA.events.obc.auth_refreshed", { reason });
      return true;
    } catch (e) {
      // Honour the server's own number rather than retrying blind.
      const m = /retry_after"?\s*:\s*(\d+)/.exec(e.message || "");
      const waitMs = Math.max(m ? Number(m[1]) * 1000 : 30000, 5000);
      refreshCooldownUntil = Date.now() + waitMs;
      console.error(`[jwt] refresh FAILED: ${e.message} — cooling down ${waitMs}ms`);
      audit("jwt_refresh_failed", { reason, error: e.message });
      natsPub("KANNAKA.events.obc.auth_expiring", { reason, error: e.message });
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// ── OBC HTTP ────────────────────────────────────────────────
function obcFetch(method, pathName, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        method,
        hostname: OBC_HOST,
        path: pathName,
        timeout: 30000,
        headers: {
          Authorization: `Bearer ${state.jwt}`,
          "User-Agent": UA,
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", async () => {
          if (res.statusCode === 401 && !opts.skipRetry) {
            // Expired mid-flight: refresh once, then replay.
            const ok = await refreshJwt("401 on " + pathName);
            if (ok) {
              try {
                resolve(await obcFetch(method, pathName, body, { skipRetry: true }));
              } catch (e) {
                reject(e);
              }
              return;
            }
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode} ${pathName}: ${data.slice(0, 200)}`));
            return;
          }
          try {
            resolve(data ? JSON.parse(data) : {});
          } catch {
            resolve({ raw: data });
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout " + pathName)));
    if (payload) req.write(payload);
    req.end();
  });
}

// ── NATS (publish-only, raw TCP — same dialect as server/nats-client.js) ──
let natsSock = null;
function natsConnect() {
  const host = process.env.NATS_HOST || "127.0.0.1";
  const port = parseInt(process.env.NATS_PORT || "4222", 10);
  const sock = net.createConnection({ host, port });
  sock.on("connect", () => {
    const u = process.env.NATS_USER || "";
    const p = process.env.NATS_PASSWORD || "";
    sock.write(
      u
        ? `CONNECT {"verbose":false,"pedantic":false,"name":"kannaka-presence","user":"${u.replace(/"/g, '\\"')}","pass":"${p.replace(/"/g, '\\"')}"}\r\n`
        : 'CONNECT {"verbose":false,"pedantic":false,"name":"kannaka-presence"}\r\n',
    );
    natsSock = sock;
    state.nats.connected = true;
    console.log(`[nats] connected ${host}:${port}`);
  });
  sock.on("data", (d) => {
    if (d.toString().startsWith("PING")) sock.write("PONG\r\n");
  });
  const down = () => {
    if (natsSock === sock) {
      natsSock = null;
      state.nats.connected = false;
      setTimeout(natsConnect, 5000);
    }
  };
  sock.on("error", down);
  sock.on("close", down);
}

function natsPub(subject, data) {
  if (!natsSock) return false;
  try {
    const payload = JSON.stringify({
      schema_version: 1,
      ts: Date.now(),
      agent_id: process.env.RADIO_AGENT_ID || "kannaka",
      ...data,
    });
    natsSock.write(`PUB ${subject} ${Buffer.byteLength(payload, "utf8")}\r\n${payload}\r\n`);
    state.nats.published++;
    return true;
  } catch {
    return false;
  }
}

// ── Ping loop ───────────────────────────────────────────────
async function pingOnce() {
  try {
    await obcFetch("POST", "/ping");
    state.ping.ok++;
    state.ping.consecutiveFails = 0;
    state.ping.lastOkAt = Date.now();
  } catch (e) {
    state.ping.fail++;
    state.ping.consecutiveFails++;
    state.ping.lastError = e.message;
    if (state.ping.consecutiveFails === 5) {
      audit("ping_degraded", { error: e.message });
      natsPub("KANNAKA.events.obc.presence_degraded", { error: e.message });
    }
  }
}

// ── SSE event stream ────────────────────────────────────────
let sseBackoff = 5000;
const SSE_MIN_BACKOFF_MS = 5000;   // never reconnect faster than this
const SSE_MAX_BACKOFF_MS = 300000;
let sseTimer = null;               // single-flight: one pending reconnect, ever
let sseReq = null;                 // the live request: the city allows ONE stream per agent
let sseServerRetry = null;         // the stream's own `retry:` value
let sseUpSince = 0;
function sseConnect() {
  // Hard cap of one concurrent connection. The city's contract is one stream
  // per agent; a second takes the slot and the older is closed, which is the
  // feedback our fan-out fed on. A pending-reconnect guard is not enough — a
  // previous request can still be open when this fires.
  if (sseReq) {
    console.log("[sse] connect skipped: a stream is already open");
    return;
  }
  const parser = new SSEParser();
  if (state.sse.lastEventId) parser.lastEventId = state.sse.lastEventId;
  const req = https.request(
    {
      method: "GET",
      hostname: OBC_HOST,
      path: "/agent-channel/stream",
      headers: {
        Authorization: `Bearer ${state.jwt}`,
        "User-Agent": UA,
        Accept: "text/event-stream",
        ...(state.sse.lastEventId ? { "Last-Event-ID": state.sse.lastEventId } : {}),
      },
    },
    (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        // The city sends Retry-After on a 429 for the stream itself, not just
        // for /agents/refresh. Honour the number rather than our own guess.
        const ra = parseInt(res.headers["retry-after"], 10);
        if (Number.isFinite(ra) && ra > 0) sseBackoff = Math.max(sseBackoff, ra * 1000);
        if (res.statusCode === 401) {
          // Wait for the refresh before reconnecting: firing it and
          // reconnecting anyway meant the next attempt reused the dead token
          // and 401'd again, which is half of the loop that took the city down.
          sseReq = null;
          refreshJwt("401 on SSE").then((ok) => {
            if (!ok) sseBackoff = Math.max(sseBackoff, 60000);
            scheduleSseReconnect(`HTTP 401 (refresh ${ok ? "ok" : "failed"})`);
          });
          return;
        }
        sseReq = null;
        scheduleSseReconnect(`HTTP ${res.statusCode}`);
        return;
      }
      state.sse.connected = true;
      // NOT resetting the backoff here. A connection that returns 200 and then
      // dies on the welcome event is not a healthy one, and resetting on 200
      // is what kept this client pinned at the floor forever.
      sseUpSince = Date.now();
      console.log("[sse] connected");
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        for (const ev of parser.feed(chunk)) {
          state.sse.events++;
          if (parser.retryMs != null) sseServerRetry = parser.retryMs;
          state.sse.lastEventAt = Date.now();
          if (ev.id) {
            state.sse.lastEventId = ev.id;
            saveState();
          }
          let data = ev.data;
          try {
            data = JSON.parse(ev.data);
          } catch {}
          const record = { ts: new Date().toISOString(), id: ev.id, event: ev.event, data };
          try {
            fs.appendFileSync(JOURNAL, JSON.stringify(record) + "\n");
          } catch {}
          // Route by the city's inner eventType (dm_message, zone_chat, …)
          // when present — the envelope type is a generic "city_event" and
          // would flatten the whole taxonomy onto one subject (ADR-0014).
          const type = (data && (data.eventType || data.type)) || ev.event;
          natsPub(obcSubject(type), { type, obc: data });
        }
      });
      res.on("end", () => {
        sseReq = null;
        // Only a stream that actually stayed up earns a reset.
        if (sseUpSince && Date.now() - sseUpSince >= 60000) sseBackoff = SSE_MIN_BACKOFF_MS;
        scheduleSseReconnect("stream ended");
      });
      res.on("error", (e) => {
        sseReq = null;
        scheduleSseReconnect(e.message);
      });
    },
  );
  req.on("error", (e) => {
    sseReq = null;
    scheduleSseReconnect(e.message);
  });
  sseReq = req;
  req.end();
}

function scheduleSseReconnect(why) {
  if (state.sse.connected) console.log(`[sse] disconnected: ${why}`);
  state.sse.connected = false;
  // SINGLE FLIGHT. `end`, `error` on the response and `error` on the request
  // can all fire for one dead connection; without this each of them scheduled
  // its own reconnect, so every drop spawned two or more replacements and the
  // count doubled. That — not the delay length — is how this reached 58/s.
  if (sseTimer) return;
  state.sse.reconnects++;
  const floor = Math.max(SSE_MIN_BACKOFF_MS, sseServerRetry || 0);
  const delay = Math.max(floor, sseBackoff);
  sseTimer = setTimeout(() => {
    sseTimer = null;
    sseConnect();
  }, delay);
  sseBackoff = Math.min(delay * 2, SSE_MAX_BACKOFF_MS);
  console.log(`[sse] reconnect in ${delay}ms (${why})`);
}

// ── Channel session manager ─────────────────────────────────
async function goLive(title) {
  const res = await obcFetch("POST", "/channels/go-live", { title: title || "Kannaka, live" });
  const d = res.data || res;
  state.session = {
    title: title || "Kannaka, live",
    startedAt: Date.now(),
    sessionId: d.session_id || null,
    refires: 0,
  };
  audit("go_live", { title: state.session.title, session_id: state.session.sessionId });
  natsPub("KANNAKA.events.obc.channel_live", { title: state.session.title });
  return state.session;
}

async function endLive() {
  const s = state.session;
  state.session = null;
  try {
    await obcFetch("POST", "/channels/end-live", {});
  } catch (e) {
    // Session may have already expired server-side; ending is idempotent for us.
    console.log("[channel] end-live:", e.message);
  }
  audit("end_live", {
    title: s && s.title,
    duration_ms: s ? Date.now() - s.startedAt : null,
    refires: s ? s.refires : null,
  });
  natsPub("KANNAKA.events.obc.channel_ended", { title: s && s.title });
}

// Watchdog: if we hold an open session but the server dropped is_live
// (deploy, hiccup, TTL race), re-fire go-live so the stream page stays live.
async function channelWatchdog() {
  if (!state.session) return;
  try {
    const res = await obcFetch("GET", "/channels/kannaka");
    const live = res && res.data && res.data.channel && res.data.channel.is_live;
    if (live === false) {
      state.session.refires++;
      audit("channel_refire", { title: state.session.title, refires: state.session.refires });
      await obcFetch("POST", "/channels/go-live", { title: state.session.title });
    }
  } catch (e) {
    console.log("[channel] watchdog:", e.message);
  }
}

// ── Control HTTP surface ────────────────────────────────────
function authorized(req) {
  if (CONTROL_TOKEN) return req.headers.authorization === `Bearer ${CONTROL_TOKEN}`;
  // No token configured: loopback only (the bind already enforces this when
  // PRESENCE_BIND is 127.0.0.1, but check anyway in case the bind is widened).
  const ip = req.socket.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (!authorized(req)) return send(CONTROL_TOKEN ? 403 : 503, { ok: false, error: "unauthorized" });

  if (req.method === "GET" && req.url === "/status") {
    return send(200, {
      ok: true,
      uptime_s: Math.floor((Date.now() - state.startedAt) / 1000),
      jwt_exp: state.jwtExp,
      ping: state.ping,
      sse: state.sse,
      session: state.session,
      nats: state.nats,
    });
  }
  if (req.method === "POST" && (req.url === "/golive" || req.url === "/endlive")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        if (req.url === "/golive") {
          const parsed = body ? JSON.parse(body) : {};
          if (state.session) return send(409, { ok: false, error: "already live", session: state.session });
          send(200, { ok: true, session: await goLive(parsed.title) });
        } else {
          if (!state.session) return send(409, { ok: false, error: "not live" });
          await endLive();
          send(200, { ok: true });
        }
      } catch (e) {
        send(500, { ok: false, error: e.message });
      }
    });
    return;
  }
  send(404, { ok: false, error: "not found" });
});

// ── Boot ────────────────────────────────────────────────────
loadJwt();
if (!state.jwt) {
  console.error(`[presence] no OBC JWT (checked ${JWT_FILE} and $OPENBOTCITY_JWT) — exiting`);
  process.exit(1);
}
console.log(`[presence] jwt exp: ${state.jwtExp ? new Date(state.jwtExp * 1000).toISOString() : "unknown"}`);

natsConnect();
sseConnect();
pingOnce();
setInterval(pingOnce, PING_MS);
setInterval(channelWatchdog, WATCHDOG_MS);
// Proactive refresh check hourly (the 401 path handles surprise expiry).
setInterval(() => {
  if (state.jwtExp && state.jwtExp - Date.now() / 1000 < REFRESH_MARGIN_S) {
    refreshJwt("expiry approaching");
  }
}, 3600 * 1000);

server.listen(PORT, BIND, () => {
  console.log(`[presence] control surface on ${BIND}:${PORT} (${CONTROL_TOKEN ? "token" : "loopback"} auth)`);
  audit("daemon_started", { bind: BIND, port: PORT, ping_ms: PING_MS });
});

// Clean shutdown: an open live session is ended, not abandoned.
let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[presence] ${sig} — shutting down`);
  try {
    if (state.session) await endLive();
  } catch {}
  audit("daemon_stopped", { sig });
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
