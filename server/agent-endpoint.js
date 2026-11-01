/**
 * server/agent-endpoint.js — JSON / SSE surface for the swarm inbox.
 *
 * The /agent HTML page itself lives at workspace/agent.html (the
 * Greenroom) — restored to its original role plus an embedded Inbox
 * Console that talks to these two endpoints:
 *
 *   POST /agent/send   JSON { to, verb, args, from? } → shells
 *                      `kannaka inbox send` and returns the published
 *                      payload
 *   GET  /agent/audit  Server-Sent Events stream; each NATS
 *                      KANNAKA.inbox.audit message lands as one
 *                      `data: <json>\n\n` frame
 *
 * The audit stream spawns one `kannaka inbox tail` child per connected
 * browser; cleaned up on socket close.
 *
 * No auth on this surface — it's a local-net dev console. If we ever
 * expose /agent on the public radio domain with sensitive verbs in the
 * handlers.toml, this should grow a token.
 */

"use strict";

const { spawn, execFile } = require("child_process");
const path = require("path");

const KANNAKA_BIN = process.env.KANNAKA_BIN ||
  path.join(__dirname, "..", "..", "kannaka-memory", "target", "release",
    process.platform === "win32" ? "kannaka.exe" : "kannaka");

const RADIO_URL = process.env.RADIO_PUBLIC_URL || "https://radio.ninja-portal.com";

// Active /agent/audit child processes (one `kannaka inbox tail` per SSE
// connection). Bounded by RADIO_AUDIT_MAX so a flood of connections can't
// spawn unlimited children. (#66)
const RADIO_AUDIT_MAX = parseInt(process.env.RADIO_AUDIT_MAX || "8", 10) || 8;
let _activeAuditChildren = 0;

let _warnedNoToken = false;
/**
 * Auth gate for write surfaces. If RADIO_AGENT_TOKEN is set, require a
 * matching `Authorization: Bearer <token>` or `x-agent-token` header.
 * If unset the surface is DISABLED (503) — fail closed, matching
 * GSHUB_ORACLE_TOKEN semantics (ADR-0013 hardening; supersedes the #65
 * open dev-mode, which left a command-shelling endpoint unauthenticated
 * on any deploy that forgot the env var).
 * Returns true when allowed; writes the refusal and returns false otherwise.
 */
function checkAgentAuth(req, res) {
  const token = process.env.RADIO_AGENT_TOKEN;
  if (!token) {
    if (!_warnedNoToken) {
      _warnedNoToken = true;
      console.warn("[agent-endpoint] RADIO_AGENT_TOKEN unset — /agent write surface DISABLED (set the token to enable)");
    }
    json(res, 503, { error: "disabled: RADIO_AGENT_TOKEN unset" });
    return false;
  }
  const auth = req.headers["authorization"] || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const headerToken = (req.headers["x-agent-token"] || "").trim();
  const same = (a, b) => {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    if (x.length !== y.length) return false;
    try { return require("crypto").timingSafeEqual(x, y); } catch (_) { return false; }
  };
  if (same(bearer, token) || same(headerToken, token)) return true;
  json(res, 401, { error: "unauthorized" });
  return false;
}

/**
 * Reject flag-injection attempts: any to/verb/arg key or value that begins
 * with `-` could be reinterpreted as a CLI flag by kannaka. (#65)
 * Returns true when the payload is safe; writes a 400 and returns false
 * otherwise.
 */
function rejectFlagInjection(res, { to, verb, args }) {
  const looksFlag = (v) => typeof v === "string" && v.startsWith("-");
  if (looksFlag(to) || looksFlag(verb)) {
    json(res, 400, { error: "to/verb must not start with '-'" });
    return false;
  }
  for (const [k, v] of Object.entries(args || {})) {
    if (looksFlag(k) || looksFlag(String(v))) {
      json(res, 400, { error: "arg keys/values must not start with '-'" });
      return false;
    }
  }
  return true;
}

function json(res, code, body) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body));
}

async function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on("data", (c) => {
      n += c.length;
      if (n > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Skill-registry snapshot served at /agent/skills. Returns `{}` when
 * no nats client has been wired in (e.g. minimal dev deploy).
 */
let _natsClient = null;
function attachNatsClient(client) { _natsClient = client; }

function inboxSend({ to, verb, args, from, wait }) {
  const cli = [KANNAKA_BIN, "inbox", "send", to, verb];
  if (from) cli.push("--from", from);
  for (const [k, v] of Object.entries(args || {})) {
    cli.push("--arg", `${k}=${v}`);
  }
  // wait can be a number (seconds) or truthy boolean for default 30s
  if (wait) {
    cli.push("--wait");
    if (typeof wait === "number" && wait > 0 && wait <= 600) cli.push(String(wait));
  }
  // Give the child a few extra seconds beyond the inbox --wait limit so
  // the timeout surfaces from kannaka, not from execFile.
  const baseMs = wait ? (typeof wait === "number" ? wait : 30) * 1000 + 5000 : 15000;
  return new Promise((resolve, reject) => {
    execFile(cli[0], cli.slice(1), { timeout: baseMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.code !== 2) return reject(new Error(stderr.trim() || err.message));
      // exit code 2 from `inbox send --wait` means "no reply within
      // timeout"; surface stderr as the response so the UI shows the
      // timeout message instead of failing.
      if (err && err.code === 2) {
        return resolve({ status: "no_reply", error: (stderr || "").trim() });
      }
      const out = (stdout || "").trim();
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        // --wait mode writes raw payload + newline; --no-wait writes
        // JSON. Either way return what we got so the UI can render it.
        resolve({ status: "raw", raw: out.slice(0, 4000) });
      }
    });
  });
}


/**
 * Returns true if the request was handled by an /agent route.
 * Designed to be called from routes.js inside the main request handler.
 */
async function handleAgentRequest(req, res, parsed) {
  if (parsed.pathname === "/agent/skills" && req.method === "GET") {
    const snapshot = _natsClient && typeof _natsClient.skillsSnapshot === "function"
      ? _natsClient.skillsSnapshot()
      : {};
    json(res, 200, { skills: snapshot, count: Object.keys(snapshot).length });
    return true;
  }

  if (parsed.pathname === "/agent/peers" && req.method === "GET") {
    const peers = _natsClient && typeof _natsClient.peersSnapshot === "function"
      ? _natsClient.peersSnapshot()
      : [];
    json(res, 200, { peers, count: peers.length });
    return true;
  }

  if (parsed.pathname === "/agent/inbox-stats" && req.method === "GET") {
    const snapshot = _natsClient && typeof _natsClient.inboxStatsSnapshot === "function"
      ? _natsClient.inboxStatsSnapshot()
      : { sent: 0, received: 0 };
    json(res, 200, snapshot);
    return true;
  }

  if (parsed.pathname === "/agent/audit-history" && req.method === "GET") {
    const n = Math.max(1, Math.min(200, parseInt(parsed.searchParams.get("limit") || "40", 10) || 40));
    const events = _natsClient && typeof _natsClient.inboxAuditTail === "function"
      ? _natsClient.inboxAuditTail(n)
      : [];
    json(res, 200, { events, count: events.length });
    return true;
  }

  if (parsed.pathname === "/agent/send" && req.method === "POST") {
    if (!checkAgentAuth(req, res)) return true;
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      return json(res, 400, { error: "bad json: " + e.message }), true;
    }
    if (!body || !body.to || !body.verb) {
      return json(res, 400, { error: "to and verb are required" }), true;
    }
    if (!rejectFlagInjection(res, { to: String(body.to), verb: String(body.verb), args: body.args || {} })) {
      return true;
    }
    try {
      const result = await inboxSend({
        to: String(body.to),
        verb: String(body.verb),
        args: body.args || {},
        from: body.from ? String(body.from) : undefined,
        wait: body.wait || false,
      });
      return json(res, 200, result), true;
    } catch (e) {
      return json(res, 500, { error: e.message }), true;
    }
  }

  if (parsed.pathname === "/agent/audit") {
    if (!checkAgentAuth(req, res)) return true;
    // Bound the number of concurrent tail children so a connection flood
    // can't exhaust the box. (#66)
    if (_activeAuditChildren >= RADIO_AUDIT_MAX) {
      json(res, 503, { error: "audit stream capacity reached" });
      return true;
    }
    // Server-Sent Events — one child kannaka-inbox-tail per connection.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // disable nginx buffering if fronted
    });
    res.write("retry: 5000\n\n");
    const child = spawn(KANNAKA_BIN, ["inbox", "tail"], { stdio: ["ignore", "pipe", "pipe"] });
    _activeAuditChildren++;
    let _released = false;
    const release = () => {
      if (_released) return;
      _released = true;
      _activeAuditChildren = Math.max(0, _activeAuditChildren - 1);
    };
    let buf = "";
    const flush = () => {
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          res.write("data: " + line + "\n\n");
        }
      }
    };
    child.stdout.on("data", (c) => { buf += c.toString("utf8"); flush(); });
    child.stderr.on("data", () => { /* swallow stderr from the tail child */ });
    const cleanup = () => {
      try { child.kill("SIGTERM"); } catch (_) {}
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
    child.on("exit", () => {
      release();
      try { res.end(); } catch (_) {}
    });
    // A failed spawn (e.g. KANNAKA_BIN missing → ENOENT) emits 'error' and may
    // never emit 'exit'. Without this listener that 'error' is unhandled and
    // crashes the whole process, AND release() never runs — so the slot leaks
    // and after RADIO_AUDIT_MAX failed spawns the endpoint is wedged at 503.
    child.on("error", () => {
      release();
      try { res.end(); } catch (_) {}
    });
    return true;
  }

  return false;
}

module.exports = { handleAgentRequest, attachNatsClient };
