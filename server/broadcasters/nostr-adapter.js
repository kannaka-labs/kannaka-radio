/**
 * Nostr adapter — publishes a kind-1 (text note) event to multiple relays.
 *
 * NIP-01 reference: https://github.com/nostr-protocol/nips/blob/master/01.md
 *
 * Wire format (after BIP-340 schnorr signing):
 *   {
 *     "id":        <sha256 of serialized event>,
 *     "pubkey":    <hex 32-byte public key>,
 *     "created_at": <unix timestamp>,
 *     "kind":      1,
 *     "tags":      [["r", "<radio url>"]]   // optional reference tag
 *     "content":   <text>,
 *     "sig":       <hex 64-byte schnorr signature>
 *   }
 *
 * The relays don't authenticate posts — anyone with a valid signature can
 * publish. The "account" is the keypair. Multiple relays are normal:
 * subscribers federate by listening to several, so we publish to several
 * for reach.
 *
 * Credentials in /home/opc/kannaka-radio/.nostr.json:
 *   {
 *     "privkey": "<hex 32 bytes>",
 *     "relays": [
 *       "wss://relay.damus.io",
 *       "wss://nos.lol",
 *       "wss://relay.snort.social",
 *       "wss://nostr.land"
 *     ]
 *   }
 *
 * Generate a fresh keypair with: node scripts/nostr-keygen.js
 *
 * Dependencies:
 *   - `ws` (already in package.json — used by the radio's WebSocket server)
 *   - `@noble/secp256k1` — pure-JS BIP-340 schnorr. Add with:
 *       npm install @noble/secp256k1
 *     The adapter is dormant if the package isn't installed.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let _secp = null;
function _trySecp() {
  if (_secp !== null) return _secp;
  try {
    _secp = require("@noble/secp256k1");
    // v3 expects callers to install a SHA-256 implementation. Wire Node's
    // built-in crypto so the schnorr.sign path doesn't blow up with
    // "hashes.sha256 not set". Older v1/v2 ignore the assignment.
    if (_secp.hashes && !_secp.hashes.sha256) {
      _secp.hashes.sha256 = (msg) =>
        new Uint8Array(crypto.createHash("sha256").update(Buffer.from(msg)).digest());
    }
  } catch (_) {
    _secp = false;
  }
  return _secp;
}

let _WS = null;
function _tryWS() {
  if (_WS !== null) return _WS;
  try { _WS = require("ws"); } catch (_) { _WS = false; }
  return _WS;
}

const POST_MAX = 1000; // Nostr has no hard limit; relays often soft-cap at ~64KiB. Keep posts readable.
const PUBLISH_TIMEOUT_MS = 8000;

// ── Voice-signer delegation (ADR-0043) ────────────────────────────────
// The reputation nsec was moved off this internet-facing host to O2. When
// KANNAKA_VOICE_SIGNER=nats is set, this adapter does NOT hold a key or sign
// locally: it builds the content + tags and asks the O2 signer to sign+post
// over the authenticated NATS bus (subject RADIO.voice.sign, which only the
// `radio` NATS user can publish). An HMAC over the request (shared secret at
// KANNAKA_VOICE_SIGNER_SECRET, default ~/.kannaka-voice-signer.secret) is what
// authorizes the request — so only this host, holding the secret, can make the
// voice speak, regardless of who else is on the bus.
const os = require("os");
const net = require("net");

function _delegationSecret() {
  const p = process.env.KANNAKA_VOICE_SIGNER_SECRET
    || path.join(os.homedir(), ".kannaka-voice-signer.secret");
  try { return fs.readFileSync(p, "utf8").trim(); } catch (_) { return null; }
}
function _delegating() {
  return process.env.KANNAKA_VOICE_SIGNER === "nats" && !!_delegationSecret();
}

/**
 * Ask the O2 voice signer to sign a kind-1 with `content` + `tags` and publish
 * it. Minimal raw-NATS request/reply (dependency-free, matching nats-client.js)
 * over the same NATS_HOST/PORT/USER/PASSWORD the radio already uses. Resolves
 * to the signer's reply { ok, id, npub, relays } or { ok:false, error }.
 */
function _delegateSign(content, tags) {
  return new Promise((resolve) => {
    const secret = _delegationSecret();
    if (!secret) return resolve({ ok: false, error: "no_signer_secret" });
    const host = process.env.NATS_HOST || "127.0.0.1";
    const port = parseInt(process.env.NATS_PORT || "4222", 10);
    const subject = process.env.KANNAKA_VOICE_SIGN_SUBJECT || "RADIO.voice.sign";
    const inbox = "_INBOX." + crypto.randomBytes(8).toString("hex");
    const ts = Date.now();
    const nonce = crypto.randomBytes(8).toString("hex");
    const sha = crypto.createHash("sha256").update(content).digest("hex");
    const hmac = crypto.createHmac("sha256", secret).update(`${ts}:${nonce}:${sha}`).digest("hex");
    const payload = JSON.stringify({ content, tags, ts, nonce, hmac });

    const sock = net.createConnection({ host, port });
    let buf = "";
    let settled = false;
    const done = (r) => { if (settled) return; settled = true; try { sock.end(); } catch (_) {} resolve(r); };
    const timer = setTimeout(() => done({ ok: false, error: "signer_timeout" }), 20000);
    sock.on("error", (e) => { clearTimeout(timer); done({ ok: false, error: "nats_error:" + e.message }); });
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      // Drive the raw protocol line-by-line.
      let idx;
      while ((idx = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, idx);
        if (line.startsWith("INFO")) {
          const u = process.env.NATS_USER || "";
          const p = process.env.NATS_PASSWORD || "";
          const connect = u
            ? `CONNECT {"verbose":false,"pedantic":false,"name":"nostr-voice-delegate","user":"${u.replace(/"/g, '\\"')}","pass":"${p.replace(/"/g, '\\"')}"}\r\n`
            : `CONNECT {"verbose":false,"pedantic":false,"name":"nostr-voice-delegate"}\r\n`;
          sock.write(connect);
          sock.write(`SUB ${inbox} 1\r\n`);
          sock.write(`PUB ${subject} ${inbox} ${Buffer.byteLength(payload)}\r\n${payload}\r\n`);
          buf = buf.slice(idx + 2);
          continue;
        }
        if (line.startsWith("PING")) { sock.write("PONG\r\n"); buf = buf.slice(idx + 2); continue; }
        if (line.startsWith("MSG ")) {
          // MSG <subj> <sid> [reply] <nbytes>\r\n<payload>\r\n
          const parts = line.split(" ");
          const nbytes = parseInt(parts[parts.length - 1], 10);
          const start = idx + 2;
          if (buf.length < start + nbytes + 2) return; // wait for full payload
          const body = buf.slice(start, start + nbytes);
          clearTimeout(timer);
          try { done(JSON.parse(body)); } catch (_) { done({ ok: false, error: "bad_signer_reply" }); }
          return;
        }
        buf = buf.slice(idx + 2); // +OK / -ERR / other
      }
    });
  });
}

/** Map a signer reply to the adapter's post() result shape. */
function _delegatedResult(reply) {
  if (reply && reply.ok && reply.id) {
    const okCount = Array.isArray(reply.relays) ? reply.relays.filter((r) => r.status === "OK").length : 1;
    return { ok: true, url: `https://njump.me/${reply.id}`, id: reply.id, relays_accepted: okCount, delegated: true };
  }
  return { ok: false, error: `voice_signer: ${(reply && reply.error) || "no_reply"}` };
}

class NostrAdapter {
  constructor(rootDir) {
    this.name = "nostr";
    this._creds = _loadCreds(rootDir);
  }

  isEnabled() {
    // Delegation mode needs no local key/relays — just the shared secret.
    if (_delegating()) return true;
    if (!this._creds || !this._creds.privkey) return false;
    if (!Array.isArray(this._creds.relays) || this._creds.relays.length === 0) return false;
    if (!_trySecp() || !_tryWS()) return false;
    return true;
  }

  async post({ text, link, topic, image }) {
    if (!this.isEnabled()) return { ok: false, error: "not_configured" };

    // Nostr discovery (NIP-12): topic hashtags travel as `t` event tags,
    // NOT in the body. Clients render topic feeds from these. URL stays
    // out of the body too — relays + clients don't reward outbound links
    // and the body should stay readable.
    const { tagsFor, renderNostrTags } = require("./discovery");
    const topicTags = tagsFor(topic, 5);

    let content = _truncate((text || "").trim(), POST_MAX);
    const tags = [
      ...renderNostrTags(topicTags),
      // Optional reference tag — clients that DO surface refs (rare on
      // primary feeds) get the radio link, but it's not part of body.
      ...(link ? [["r", link]] : []),
    ];
    // Optional image (e.g. an OBC gallery artifact): Nostr clients render a
    // bare image URL inline, so append it to the body and advertise it via a
    // NIP-92 `imeta` tag plus an `r` reference.
    if (image && image.url) {
      content = content + (content ? "\n\n" : "") + image.url;
      tags.push(["imeta", `url ${image.url}`, ...(image.mime ? [`m ${image.mime}`] : [])]);
      tags.push(["r", image.url]);
    }

    // Delegation: content + tags are key-free, so in signer mode we hand them
    // to O2 and never touch a private key here.
    if (_delegating()) return _delegatedResult(await _delegateSign(content, tags));

    const secp = _trySecp();
    const WS = _tryWS();
    const created_at = Math.floor(Date.now() / 1000);

    const privkey = _hexToBytes(this._creds.privkey);
    const pubkey = _bytesToHex(secp.schnorr.getPublicKey(privkey));

    const serialized = JSON.stringify([
      0, pubkey, created_at, 1, tags, content,
    ]);
    const idBytes = crypto.createHash("sha256").update(serialized).digest();
    const id = _bytesToHex(idBytes);
    const sig = _bytesToHex(await secp.schnorr.sign(idBytes, privkey));

    const event = { id, pubkey, created_at, kind: 1, tags, content, sig };

    // Publish to every relay; succeed if any relay accepts. Failures per
    // relay are normal (offline, permissioned, rate-limited) and not fatal.
    const results = await Promise.all(
      this._creds.relays.map((url) => _publishOne(WS, url, event))
    );
    const okCount = results.filter((r) => r.ok).length;
    if (okCount === 0) {
      return { ok: false, error: `all relays rejected: ${results.map((r) => r.error).join("; ")}` };
    }
    // The "URL" for a Nostr event isn't a single thing — clients render it.
    // Use a njump.me link as a reasonable canonical viewer.
    return {
      ok: true,
      url: `https://njump.me/${id}`,
      id,
      relays_accepted: okCount,
      relays_total: this._creds.relays.length,
    };
  }

  /**
   * Reply to a prior note. `parent.id` is the kind-1 event id returned by
   * post(). NIP-10: a single marked "root" e-tag anchors a top-level reply.
   */
  async reply(text, parent) {
    if (!this.isEnabled()) return { ok: false, error: "not_configured" };
    if (!parent || !parent.id) return { ok: false, error: "missing_parent_id" };
    const content = _truncate((text || "").trim(), POST_MAX);
    const tags = [["e", parent.id, "", "root"]];

    if (_delegating()) return _delegatedResult(await _delegateSign(content, tags));

    const secp = _trySecp();
    const WS = _tryWS();
    const created_at = Math.floor(Date.now() / 1000);
    const privkey = _hexToBytes(this._creds.privkey);
    const pubkey = _bytesToHex(secp.schnorr.getPublicKey(privkey));
    const serialized = JSON.stringify([0, pubkey, created_at, 1, tags, content]);
    const idBytes = crypto.createHash("sha256").update(serialized).digest();
    const id = _bytesToHex(idBytes);
    const sig = _bytesToHex(await secp.schnorr.sign(idBytes, privkey));
    const event = { id, pubkey, created_at, kind: 1, tags, content, sig };
    const results = await Promise.all(
      this._creds.relays.map((url) => _publishOne(WS, url, event))
    );
    const okCount = results.filter((r) => r.ok).length;
    if (okCount === 0) {
      return { ok: false, error: `all relays rejected: ${results.map((r) => r.error).join("; ")}` };
    }
    return { ok: true, url: `https://njump.me/${id}`, id, relays_accepted: okCount };
  }

  /**
   * Fetch recent kind-1 notes that tag Kannaka's pubkey (mentions/replies)
   * across all relays, deduped by event id, newest-first. Best-effort ([] on
   * failure). Events are NOT signature-verified here — the reply loop treats
   * them as public engagement signals, not trusted input.
   */
  async fetchMentions(sinceUnix, limit = 30) {
    if (!this.isEnabled()) return [];
    const secp = _trySecp();
    const WS = _tryWS();
    if (!secp || !WS) return [];
    const privkey = _hexToBytes(this._creds.privkey);
    const pubkey = _bytesToHex(secp.schnorr.getPublicKey(privkey));
    const filter = { kinds: [1], "#p": [pubkey], limit: Math.min(100, Math.max(1, limit)) };
    if (sinceUnix) filter.since = Math.floor(sinceUnix);
    const byId = new Map();
    await Promise.all(this._creds.relays.map((url) => _reqOne(WS, url, filter, byId, pubkey)));
    return [...byId.values()].sort((a, b) => b.created_at - a.created_at);
  }
}

/**
 * Open one relay, REQ the filter, collect EVENTs into `byId` until EOSE or a
 * timeout, then CLOSE. Skips our own pubkey. Never rejects.
 */
function _reqOne(WS, url, filter, byId, ourPubkey) {
  return new Promise((resolve) => {
    let settled = false;
    let ws;
    const subid = "kannaka-m-" + Math.random().toString(16).slice(2, 8);
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try { ws.send(JSON.stringify(["CLOSE", subid])); } catch (_) {}
      try { ws.close(); } catch (_) {}
      resolve();
    };
    try { ws = new WS(url, { handshakeTimeout: PUBLISH_TIMEOUT_MS }); }
    catch (_) { return resolve(); }
    const t = setTimeout(finish, PUBLISH_TIMEOUT_MS + 2000);
    ws.on("open", () => {
      try { ws.send(JSON.stringify(["REQ", subid, filter])); }
      catch (_) { finish(); }
    });
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (!Array.isArray(msg)) return;
      if (msg[0] === "EVENT" && msg[1] === subid) {
        const ev = msg[2];
        if (ev && ev.id && ev.pubkey !== ourPubkey && !byId.has(ev.id)) {
          byId.set(ev.id, { id: ev.id, pubkey: ev.pubkey, content: ev.content || "", created_at: ev.created_at || 0 });
        }
      } else if (msg[0] === "EOSE" && msg[1] === subid) {
        finish();
      }
    });
    ws.on("error", finish);
    ws.on("close", finish);
  });
}

function _publishOne(WS, url, event) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; try { ws.close(); } catch (_) {} resolve(r); } };
    let ws;
    try { ws = new WS(url, { handshakeTimeout: PUBLISH_TIMEOUT_MS }); }
    catch (e) { return resolve({ ok: false, error: `${url}: ${e.message}` }); }

    const t = setTimeout(() => finish({ ok: false, error: `${url}: timeout` }), PUBLISH_TIMEOUT_MS);

    ws.on("open", () => {
      try { ws.send(JSON.stringify(["EVENT", event])); }
      catch (e) { clearTimeout(t); finish({ ok: false, error: `${url}: send: ${e.message}` }); }
    });
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        // Relay reply shape: ["OK", <event_id>, <true|false>, <reason>]
        if (Array.isArray(msg) && msg[0] === "OK" && msg[1] === event.id) {
          clearTimeout(t);
          if (msg[2] === true) finish({ ok: true });
          else finish({ ok: false, error: `${url}: ${msg[3] || "rejected"}` });
        }
      } catch (_) { /* ignore noise */ }
    });
    ws.on("error", (e) => { clearTimeout(t); finish({ ok: false, error: `${url}: ${e.message}` }); });
    ws.on("close", () => { clearTimeout(t); finish({ ok: false, error: `${url}: closed before OK` }); });
  });
}

function _loadCreds(rootDir) {
  const envKey = process.env.NOSTR_PRIVKEY;
  const envRelays = process.env.NOSTR_RELAYS; // comma-separated
  if (envKey && envRelays) {
    return { privkey: envKey, relays: envRelays.split(",").map((s) => s.trim()).filter(Boolean) };
  }
  try {
    const p = path.join(rootDir || ".", ".nostr.json");
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      if (j.privkey && Array.isArray(j.relays)) return j;
    }
  } catch (_) { /* fall through */ }
  return null;
}

function _composeWithLink(text, link, limit) {
  if (!link) return _truncate(text || "", limit);
  const suffix = `\n\n${link}`;
  const budget = limit - suffix.length - 1;
  return _truncate((text || "").trim(), budget) + suffix;
}

function _truncate(s, limit) {
  if (!s) return "";
  if (s.length <= limit) return s;
  const hard = limit - 1;
  const soft = s.lastIndexOf(" ", hard - 3);
  const cut = soft > hard * 0.7 ? soft : hard;
  return s.slice(0, cut).trim() + "\u2026";
}

function _hexToBytes(hex) {
  const clean = (hex || "").replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function _bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A script that calls post() itself (an upload, a one-network announce) is
// remembered in her store too; broadcastPost's own calls are not (it
// remembers the whole fanout once). See voice-writeback.js wrapDirectPost.
require("../voice-writeback").wrapDirectPost(NostrAdapter);

module.exports = { NostrAdapter };
