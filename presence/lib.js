/**
 * presence/lib.js — pure, testable pieces of the kannaka-presence daemon (ADR-0013).
 *
 * No IO here: env-file structure-preserving parse/serialize (the OBC_JWT_FILE
 * custody pattern borrowed from the observatory), JWT exp decoding, the
 * hash-chained audit entry builder (steward pattern), and an incremental SSE
 * parser for the OBC agent-channel stream.
 */

"use strict";

const crypto = require("crypto");

/**
 * Parse an env-format file preserving structure. Returns { lines, vars } where
 * lines is the ordered raw file model ([{type:'var',key,value,raw}|{type:'raw',raw}])
 * and vars is a plain lookup object. Comments/blank lines survive round-trips —
 * the JWT custodian must never destroy a hand-edited creds file.
 */
function parseEnvFile(text) {
  const lines = [];
  const vars = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const m = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) {
      lines.push({ type: "var", key: m[1], value: m[2], raw });
      vars[m[1]] = m[2];
    } else {
      lines.push({ type: "raw", raw });
    }
  }
  return { lines, vars };
}

/**
 * Serialize the parsed model back to text, applying `updates` (key→newValue).
 * Keys present in updates but absent from the file are appended at the end.
 */
function serializeEnvFile(parsed, updates = {}) {
  const pending = { ...updates };
  const out = parsed.lines.map((l) => {
    if (l.type === "var" && Object.prototype.hasOwnProperty.call(pending, l.key)) {
      const v = pending[l.key];
      delete pending[l.key];
      return `${l.key}=${v}`;
    }
    return l.raw;
  });
  // Trim a single trailing blank line before appending so new keys don't float.
  while (out.length && out[out.length - 1] === "" && Object.keys(pending).length) out.pop();
  for (const [k, v] of Object.entries(pending)) out.push(`${k}=${v}`);
  if (out[out.length - 1] !== "") out.push(""); // newline-terminated file
  return out.join("\n");
}

/** Decode a JWT's exp claim (epoch seconds). Returns null on any malformation. */
function jwtExp(jwt) {
  try {
    const parts = String(jwt).split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * Build the next hash-chained audit entry. Chain rule:
 *   hash = sha256(prev_hash + "\n" + JSON.stringify({ts, action, detail}))
 * Genesis prev_hash is "".  Verification: recompute over the file in order.
 */
function auditEntry(prevHash, { ts, action, detail }) {
  const body = { ts, action, detail };
  const hash = crypto
    .createHash("sha256")
    .update((prevHash || "") + "\n" + JSON.stringify(body))
    .digest("hex");
  return { ...body, prev_hash: prevHash || "", hash };
}

/** Verify a full audit chain (array of entries). Returns true iff intact. */
function verifyAuditChain(entries) {
  let prev = "";
  for (const e of entries) {
    const expect = auditEntry(prev, { ts: e.ts, action: e.action, detail: e.detail });
    if (e.prev_hash !== prev || e.hash !== expect.hash) return false;
    prev = e.hash;
  }
  return true;
}

/**
 * Incremental server-sent-events parser. feed(chunk) returns completed events:
 * [{ id, event, data }]. Handles multi-chunk splits, multi-line data, comments
 * (lines starting ":"), and CRLF. Tracks lastEventId across events for resume.
 */
class SSEParser {
  constructor() {
    this._buf = "";
    this.lastEventId = null;
    // The server's `retry:` directive, in ms. Previously parsed and thrown
    // away, which is why our client ignored OpenClawCity's retry: 5000.
    this.retryMs = null;
  }

  feed(chunk) {
    this._buf += chunk;
    const events = [];
    // An event is terminated by a blank line. Process all complete blocks.
    let idx;
    while ((idx = this._buf.search(/\r?\n\r?\n/)) !== -1) {
      const sep = this._buf.match(/\r?\n\r?\n/);
      const block = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + sep[0].length);
      const ev = { id: null, event: "message", data: [] };
      for (const line of block.split(/\r?\n/)) {
        if (!line || line.startsWith(":")) continue;
        const c = line.indexOf(":");
        const field = c === -1 ? line : line.slice(0, c);
        let value = c === -1 ? "" : line.slice(c + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "retry") {
          const n = parseInt(value, 10);
          if (Number.isFinite(n) && n >= 0) this.retryMs = n;
        } else if (field === "id") ev.id = value;
        else if (field === "event") ev.event = value;
        else if (field === "data") ev.data.push(value);
      }
      if (ev.data.length === 0 && ev.id === null && ev.event === "message") continue;
      const out = { id: ev.id, event: ev.event, data: ev.data.join("\n") };
      if (out.id !== null) this.lastEventId = out.id;
      events.push(out);
    }
    return events;
  }
}

/**
 * Map an OBC stream event to its NATS subject. Event types become the subject
 * leaf, sanitized to [a-z0-9_] so a hostile event name can't traverse the
 * subject space (KANNAKA.events.obc.> stays the ceiling).
 */
function obcSubject(eventType) {
  const leaf = String(eventType || "message")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 64) || "message";
  return `KANNAKA.events.obc.${leaf}`;
}

module.exports = {
  parseEnvFile,
  serializeEnvFile,
  jwtExp,
  auditEntry,
  verifyAuditChain,
  SSEParser,
  obcSubject,
};
