#!/usr/bin/env node
/**
 * voice-signer.js — O2 remote signer for Kannaka's Nostr voice key (ADR-0043).
 *
 * The reputation nsec lives ONLY on O2 (low-exposure witness). O1's radio
 * delegates every "post as the voice" over the constellation's authenticated
 * NATS bus: it publishes a sign-request to RADIO.voice.sign, this daemon
 * signs with the voice key, publishes to relays, and replies with the event id.
 * So the key never sits on the internet-facing radio host, and there is no new
 * inbound internet port — the bus is the only surface.
 *
 * Authorization is an HMAC over the request with a shared secret held 0600 on
 * O1 and O2, plus a freshness window and nonce dedupe. The rules live in
 * protocol.js (kind 1 notes with HMAC v1; kind 30023 long-form with HMAC v2,
 * which also covers the kind and tags); this file only signs and publishes.
 *
 * Key:    ~/.kannaka-voice-nostr.json (0600) — { privkey, npub, relays }
 * Secret: ~/.kannaka-voice-signer.secret (0600) — shared with O1
 * Deploy: see README.md in this directory. The deployed copy must equal this file.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");
const { schnorr } = require("@noble/curves/secp256k1");
const { connect, StringCodec } = require("nats");
const { createGate } = require("./protocol");

const KEY_PATH = process.env.VOICE_KEY_PATH || path.join(os.homedir(), ".kannaka-voice-nostr.json");
const SECRET_PATH = process.env.VOICE_SIGNER_SECRET || path.join(os.homedir(), ".kannaka-voice-signer.secret");
const NATS_URL = process.env.VOICE_SIGNER_NATS_URL || "nats://127.0.0.1:4222";
// RADIO.voice.sign: the only voice-sign subject the O1 `radio` NATS user can
// publish (its ACL allows RADIO.>). The `anon` lane's publish ACL does NOT
// include RADIO.>, so the request subject is transport-restricted to the radio
// identity on top of the HMAC gate — defense in depth.
const SUBJECT = process.env.VOICE_SIGN_SUBJECT || "RADIO.voice.sign";
const NATS_USER = process.env.VOICE_SIGNER_NATS_USER || undefined;
const NATS_PASS = process.env.VOICE_SIGNER_NATS_PASS || undefined;

const key = JSON.parse(fs.readFileSync(KEY_PATH, "utf8"));
const PRIV = key.privkey;
const NPUB = key.npub;
const RELAYS = key.relays && key.relays.length ? key.relays : ["wss://relay.damus.io", "wss://nos.lol"];
const gate = createGate({ secret: fs.readFileSync(SECRET_PATH, "utf8").trim() });

const sc = StringCodec();

function toHex(b) { return Buffer.from(b).toString("hex"); }

function signEvent(kind, tags, content) {
  const pubkey = toHex(schnorr.getPublicKey(PRIV));
  const created_at = Math.floor(Date.now() / 1000);
  const serialized = JSON.stringify([0, pubkey, created_at, kind, tags, content]);
  const id = crypto.createHash("sha256").update(serialized).digest();
  const sig = toHex(schnorr.sign(id, PRIV));
  return { id: toHex(id), pubkey, created_at, kind, tags, content, sig };
}

function publishToRelay(url, event) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { handshakeTimeout: 8000 });
    let done = false;
    const fin = (s) => { if (done) return; done = true; try { ws.close(); } catch {} resolve({ relay: url, status: s }); };
    const t = setTimeout(() => fin("timeout"), 12000);
    ws.on("open", () => ws.send(JSON.stringify(["EVENT", event])));
    ws.on("message", (d) => {
      try { const m = JSON.parse(d.toString()); if (m[0] === "OK" && m[1] === event.id) { clearTimeout(t); fin(m[2] ? "OK" : `rejected:${m[3] || "?"}`); } } catch {}
    });
    ws.on("error", (e) => { clearTimeout(t); fin("err:" + e.message); });
  });
}

async function handle(reqStr) {
  const r = gate.check(reqStr);
  if (!r.ok) return r;
  const event = signEvent(r.kind, r.tags, r.content);
  const results = await Promise.all(RELAYS.map((u) => publishToRelay(u, event)));
  const accepted = results.some((x) => x.status === "OK");
  return { ok: accepted, id: event.id, npub: NPUB, relays: results };
}

(async () => {
  const opts = { servers: NATS_URL, name: "kannaka-voice-signer" };
  if (NATS_USER) { opts.user = NATS_USER; opts.pass = NATS_PASS; }
  const nc = await connect(opts);
  console.log(`[voice-signer] connected ${NATS_URL}; subscribing ${SUBJECT} as ${NPUB}`);
  const sub = nc.subscribe(SUBJECT, { queue: "voice-signer" });
  for await (const m of sub) {
    let resp;
    try { resp = await handle(sc.decode(m.data)); }
    catch (e) { resp = { ok: false, error: "internal:" + e.message }; }
    if (m.reply) m.respond(sc.encode(JSON.stringify(resp)));
    console.log(`[voice-signer] ${resp.ok ? "signed " + (resp.id || "").slice(0, 12) + "…" : "rejected:" + resp.error}`);
  }
})().catch((e) => { console.error("[voice-signer] fatal:", e.message); process.exit(1); });
