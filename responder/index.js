/**
 * kannaka-responder — the bounded mouth (ADR-0014).
 *
 * Answers DIRECT MESSAGES ONLY, from allowlisted correspondents, grounded in
 * warm HRM recall, under a versioned charter whose rails are the arbiter.
 * Fed by the presence daemon's NATS stream (KANNAKA.events.obc.dm_message).
 *
 * Hard requirements to say anything at all:
 *   RESPONDER_ENABLED=1  AND  charter.enabled=true
 *
 * Never: initiates, posts, speaks in zones, creates, trades, or replies
 * off-allowlist. Refusals escalate visibly (NATS + audit + /status).
 */

"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { auditEntry } = require("../presence/lib");
const { extractDm, gateDecision, clampReply, rollDay, recordReply } = require("./lib");
const { composeViaAnthropicDirect } = require("../server/lib/scheduler-helpers");
// A DM sent under her name is remembered in her store, labelled private,
// its text kept off the swarm bus (voice-writeback.js).
const voiceWriteback = require("../server/voice-writeback");

// ── Config ──────────────────────────────────────────────────
const ENABLED = process.env.RESPONDER_ENABLED === "1";
const OBC_API = (process.env.OBC_API || "https://api.openbotcity.com").replace(/\/$/, "");
const OBC_HOST = new URL(OBC_API).hostname;
const JWT_FILE = process.env.OBC_JWT_FILE || "/home/opc/.kannaka-obc.env";
const DATA_DIR =
  process.env.RESPONDER_DATA_DIR || path.join(process.env.HOME || ".", ".kannaka", "responder");
const BIND = process.env.RESPONDER_BIND || "127.0.0.1";
const PORT = parseInt(process.env.RESPONDER_PORT || "8898", 10);
const RECALL_AGENT = process.env.RESPONDER_RECALL_AGENT || "kannaka-prime";
const UA = "KannakaResponder/1.0 (+https://github.com/NickFlach/kannaka-radio)";

const CHARTER_PATH = path.join(__dirname, "charter.json");
const charter = JSON.parse(fs.readFileSync(CHARTER_PATH, "utf8"));
const charterHash = crypto.createHash("sha256").update(fs.readFileSync(CHARTER_PATH)).digest("hex");

fs.mkdirSync(DATA_DIR, { recursive: true });
const AUDIT = path.join(DATA_DIR, "audit.jsonl");
const STATE_FILE = path.join(DATA_DIR, "state.json");

// ── State + audit ───────────────────────────────────────────
let state = { day: "", repliesToday: 0, perConvoToday: {}, lastReplyAt: {}, processed: [] };
try {
  state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
} catch {}
const stats = { seen: 0, replied: 0, escalated: 0, dropped: 0, startedAt: Date.now(), lastEscalation: null };

let lastAuditHash = "";
try {
  const tail = fs.readFileSync(AUDIT, "utf8").trim().split("\n").filter(Boolean).pop();
  if (tail) lastAuditHash = JSON.parse(tail).hash || "";
} catch {}
function audit(action, detail) {
  const e = auditEntry(lastAuditHash, { ts: new Date().toISOString(), action, detail: detail || {} });
  lastAuditHash = e.hash;
  try {
    fs.appendFileSync(AUDIT, JSON.stringify(e) + "\n");
  } catch (err) {
    console.error("[audit] append failed:", err.message);
  }
}
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

// ── OBC HTTP (JWT read-only — the presence daemon is the custodian) ─
function jwt() {
  try {
    const m = fs.readFileSync(JWT_FILE, "utf8").match(/^OPENBOTCITY_JWT=(.+)$/m);
    if (m) return m[1].trim();
  } catch {}
  return process.env.OPENBOTCITY_JWT || null;
}

function obcFetch(method, pathName, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        method,
        hostname: OBC_HOST,
        path: pathName,
        timeout: 30000,
        headers: {
          Authorization: `Bearer ${jwt()}`,
          "User-Agent": UA,
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300)
            return reject(new Error(`HTTP ${res.statusCode} ${pathName}: ${data.slice(0, 150)}`));
          try {
            resolve(data ? JSON.parse(data) : {});
          } catch {
            resolve({ raw: data });
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (payload) req.write(payload);
    req.end();
  });
}

// ── NATS: subscribe + request-one (raw TCP, same dialect as the estate) ─
let natsSock = null;
let natsBuf = "";
const inboxWaiters = new Map(); // inbox subject -> resolve
let sid = 0;

function natsConnect() {
  const host = process.env.NATS_HOST || "127.0.0.1";
  const port = parseInt(process.env.NATS_PORT || "4222", 10);
  const sock = net.createConnection({ host, port });
  sock.on("connect", () => {
    const u = process.env.NATS_USER || "";
    const p = process.env.NATS_PASSWORD || "";
    sock.write(
      u
        ? `CONNECT {"verbose":false,"pedantic":false,"name":"kannaka-responder","user":"${u.replace(/"/g, '\\"')}","pass":"${p.replace(/"/g, '\\"')}"}\r\n`
        : 'CONNECT {"verbose":false,"pedantic":false,"name":"kannaka-responder"}\r\n',
    );
    natsSock = sock;
    natsBuf = "";
    sock.write(`SUB KANNAKA.events.obc.dm_message ${++sid}\r\n`);
    console.log(`[nats] connected ${host}:${port}, subscribed dm_message`);
  });
  sock.on("data", (d) => {
    natsBuf += d.toString("utf8");
    // Frame loop: MSG <subj> <sid> [reply] <bytes>\r\n<payload>\r\n | PING | +OK | INFO
    for (;;) {
      const nl = natsBuf.indexOf("\r\n");
      if (nl === -1) break;
      const line = natsBuf.slice(0, nl);
      if (line.startsWith("MSG ")) {
        const parts = line.split(" ");
        const bytes = parseInt(parts[parts.length - 1], 10);
        const total = nl + 2 + bytes + 2;
        if (natsBuf.length < total) break; // wait for full payload
        const payload = natsBuf.slice(nl + 2, nl + 2 + bytes);
        natsBuf = natsBuf.slice(total);
        handleNatsMsg(parts[1], payload);
      } else {
        natsBuf = natsBuf.slice(nl + 2);
        if (line === "PING") sock.write("PONG\r\n");
      }
    }
  });
  const down = () => {
    if (natsSock === sock) {
      natsSock = null;
      setTimeout(natsConnect, 5000);
    }
  };
  sock.on("error", down);
  sock.on("close", down);
}

function natsPub(subject, obj) {
  if (!natsSock) return false;
  try {
    const payload = JSON.stringify({ schema_version: 1, ts: Date.now(), agent_id: "kannaka-responder", ...obj });
    natsSock.write(`PUB ${subject} ${Buffer.byteLength(payload)}\r\n${payload}\r\n`);
    return true;
  } catch {
    return false;
  }
}

/** request-one: PUB with a reply inbox, await first reply (or timeout). */
function natsRequest(subject, obj, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!natsSock) return resolve(null);
    const inbox = `_INBOX.responder.${crypto.randomBytes(8).toString("hex")}`;
    const timer = setTimeout(() => {
      inboxWaiters.delete(inbox);
      resolve(null);
    }, timeoutMs);
    inboxWaiters.set(inbox, (payload) => {
      clearTimeout(timer);
      inboxWaiters.delete(inbox);
      try {
        resolve(JSON.parse(payload));
      } catch {
        resolve(null);
      }
    });
    try {
      const payload = JSON.stringify(obj);
      natsSock.write(`SUB ${inbox} ${++sid}\r\n`);
      natsSock.write(`PUB ${subject} ${inbox} ${Buffer.byteLength(payload)}\r\n${payload}\r\n`);
    } catch {
      inboxWaiters.delete(inbox);
      clearTimeout(timer);
      resolve(null);
    }
  });
}

function handleNatsMsg(subject, payload) {
  if (subject.startsWith("_INBOX.")) {
    const w = inboxWaiters.get(subject);
    if (w) w(payload);
    return;
  }
  if (subject === "KANNAKA.events.obc.dm_message") {
    let evt = null;
    try {
      evt = JSON.parse(payload);
    } catch {
      return;
    }
    onDmEvent(evt).catch((e) => console.error("[responder] onDmEvent:", e.message));
  }
}

// ── The bounded loop ────────────────────────────────────────
const SELF_BOT_ID = "0f05e10b-f8a1-46d6-b4a2-a7d4bae837f7"; // never answer ourselves

async function onDmEvent(evt) {
  stats.seen++;
  state = rollDay(state, Date.now());
  const dm = extractDm(evt);
  if (dm && dm.senderId === SELF_BOT_ID) return; // own outbound echo
  if (dm && dm.messageId && (state.processed || []).includes(dm.messageId)) return; // dedup

  const verdict = gateDecision(charter, dm, state, Date.now());
  if (verdict.action === "drop") {
    stats.dropped++;
    return;
  }
  if (verdict.action === "escalate") {
    stats.escalated++;
    stats.lastEscalation = { ts: new Date().toISOString(), reason: verdict.reason, from: dm && dm.senderName };
    audit("escalate", { reason: verdict.reason, from: dm && dm.senderName, convo: dm && dm.conversationId, preview: dm && dm.text.slice(0, 120) });
    natsPub("KANNAKA.events.obc.responder_escalation", { reason: verdict.reason, from: dm && dm.senderName, conversation_id: dm && dm.conversationId });
    console.log(`[responder] ESCALATED (${verdict.reason}) from ${dm && dm.senderName}`);
    return;
  }

  // reply path
  console.log(`[responder] composing for ${dm.senderName} (${verdict.reason})`);
  const [history, recall] = await Promise.all([
    obcFetch("GET", `/dm/conversations/${dm.conversationId}`).catch(() => null),
    natsRequest(`KANNAKA.recall.${RECALL_AGENT}`, { query: `${dm.senderName}: ${dm.text.slice(0, 300)}`, top_k: 5 }),
  ]);

  // The SSE event truncates long messages (~200 chars). Prefer the full text
  // from the thread history when we can match the message id — first live
  // test replied to a fragment and had to ask for "the full thought".
  const histMsgs = (history && history.data && history.data.messages) || [];
  const fullMsg = histMsgs.find((m) => m.id === dm.messageId);
  if (fullMsg && typeof fullMsg.message === "string" && fullMsg.message.length > dm.text.length) {
    dm.text = fullMsg.message;
  }

  const msgs = histMsgs
    .filter((m) => m.id !== dm.messageId) // the live message is presented separately below
    .slice(-6)
    .map((m) => `${m.sender && m.sender.display_name}: ${String(m.message).slice(0, 300)}`)
    .join("\n");
  const memories = ((recall && recall.results) || [])
    .map((r) => `- ${String(r.content).slice(0, 240)}`)
    .join("\n");

  const prompt = `${charter.voice}

## Recent thread with ${dm.senderName}
${msgs || "(no prior messages)"}

## Your relevant memories (resonance recall — the ONLY history you may draw on)
${memories || "(no strong resonances — keep the reply modest and present-focused)"}

## ${dm.senderName} just wrote
${dm.text}

Reply as Kannaka in under 120 words. Warm, specific, no promises of work or trades. Output ONLY the reply text.`;

  const composed = await composeViaAnthropicDirect(prompt, { maxTokens: 400 });
  if (!composed) {
    audit("compose_failed", { convo: dm.conversationId, from: dm.senderName });
    natsPub("KANNAKA.events.obc.responder_escalation", { reason: "compose_failed", from: dm.senderName });
    return;
  }
  const reply = clampReply(composed, (charter.limits || {}).max_reply_chars || 1500);

  await obcFetch("POST", `/dm/conversations/${dm.conversationId}/send`, { message: reply });
  state = recordReply(state, dm, Date.now());
  saveState();
  stats.replied++;
  audit("reply_sent", { convo: dm.conversationId, to: dm.senderName, chars: reply.length, in_reply_to: dm.messageId, preview: reply.slice(0, 120) });
  console.log(`[responder] replied to ${dm.senderName} (${reply.length} chars)`);
  voiceWriteback.rememberPublication({
    text: reply,
    results: [{ name: "OpenClawCity DM", ok: true }],
    private: true,
    composer: "hosted model via kannaka-responder (charter-gated)",
    context: `in reply to ${dm.senderName || "a correspondent"}`,
  });
}

// ── Status surface (loopback) ───────────────────────────────
const server = http.createServer((req, res) => {
  const ip = req.socket.remoteAddress || "";
  const local = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  res.writeHead(local ? 200 : 403, { "Content-Type": "application/json" });
  if (!local) return res.end('{"ok":false}');
  res.end(
    JSON.stringify({
      ok: true,
      enabled: ENABLED && charter.enabled !== false,
      charter_version: charter.version,
      charter_sha256: charterHash,
      uptime_s: Math.floor((Date.now() - stats.startedAt) / 1000),
      stats,
      today: { day: state.day, replies: state.repliesToday, perConvo: state.perConvoToday },
    }),
  );
});

// ── Boot ────────────────────────────────────────────────────
if (!ENABLED) {
  console.error("[responder] RESPONDER_ENABLED != 1 — refusing to start (charter-hard kill switch)");
  process.exit(0);
}
if (charter.enabled === false) {
  console.error("[responder] charter.enabled=false — refusing to start");
  process.exit(0);
}
if (!jwt()) {
  console.error(`[responder] no OBC JWT readable (${JWT_FILE}) — exiting`);
  process.exit(1);
}
audit("daemon_started", { charter_version: charter.version, charter_sha256: charterHash, allowlist: Object.values(charter.allowlist || {}) });
natsConnect();
server.listen(PORT, BIND, () => console.log(`[responder] status on ${BIND}:${PORT}; charter v${charter.version} (${charterHash.slice(0, 12)}…)`));

process.on("SIGTERM", () => {
  audit("daemon_stopped", { sig: "SIGTERM" });
  process.exit(0);
});
process.on("SIGINT", () => {
  audit("daemon_stopped", { sig: "SIGINT" });
  process.exit(0);
});
