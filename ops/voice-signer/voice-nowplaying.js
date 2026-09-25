#!/usr/bin/env node
/**
 * voice-nowplaying.js — Nostr-only now-playing poster, running on O2 (witness,
 * low exposure) so Kannaka's reputation-bearing voice nsec never sits on the
 * internet-facing radio host (O1). ADR-0043: "move the voice key off O1".
 *
 * Reads the PUBLIC now-playing API on O1, signs a kind-1 with the voice key
 * held locally on O2, and publishes to the relays listed in the key file.
 * O1's post-now-playing.js keeps posting to Bluesky/Mastodon/Telegram (those
 * use revocable API tokens, not the self-sovereign signing key) — Nostr is the
 * only channel that moved.
 *
 * Key: ~/.kannaka-voice-nostr.json (0600) — { privkey, pubkey, npub, relays }.
 * State: ~/.kannaka/nostr-nowplaying-state.json — throttle, same rules as O1.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const WebSocket = require("ws");
const { schnorr } = require("@noble/curves/secp256k1");

const KEY_PATH = process.env.VOICE_KEY_PATH || path.join(os.homedir(), ".kannaka-voice-nostr.json");
const STATE_PATH = path.join(os.homedir(), ".kannaka", "nostr-nowplaying-state.json");
const NOW_PLAYING_URL = process.env.RADIO_NOWPLAYING_URL || "https://radio.ninja-portal.com/api/now-playing";
const MIN_INTERVAL_MS = Number(process.env.NP_MIN_INTERVAL_MS || 90 * 60 * 1000);
const DAILY_CAP = Number(process.env.NP_DAILY_CAP || 6);
const DRY = process.argv.includes("--dry-run");

function loadJson(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return dflt; }
}
function saveState(s) {
  try { fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true }); fs.writeFileSync(STATE_PATH, JSON.stringify(s)); }
  catch (e) { console.error("state save:", e.message); }
}
function todayKey() { return new Date().toISOString().slice(0, 10); }

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000 }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

const TAGS_BASE = ["KannakaRadio", "GhostFrequency"];
const MOOD = {
  default: ["AImusic", "electronic", "newmusic"],
  contemplative: ["ambient", "latenightradio", "chillvibes"],
  playful: ["synthwave", "futurepop", "morningmusic"],
  excited: ["peakhours", "electronicdance", "energizing"],
  philosophical: ["downtempo", "deepcuts", "afternoonradio"],
  mysterious: ["darksynth", "twilightradio", "cinematicmusic"],
};
function chooseTags(album) {
  const l = (album || "").toLowerCase();
  let pool = MOOD.default;
  if (/rosa|transcendence|memories don|collective dreaming|reef|lonesome/.test(l)) pool = MOOD.contemplative;
  else if (/becoming|neurogenesis|gifts|interference patterns|gift of sight|hosted live/.test(l)) pool = MOOD.playful;
  else if (/wanted|northwake|emergence|queensync|ghost signals|bend the arc|opt out/.test(l)) pool = MOOD.excited;
  else if (/vacuum garden|10000|one more life|asking/.test(l)) pool = MOOD.philosophical;
  else if (/born in superposition/.test(l)) pool = MOOD.mysterious;
  const flavor = pool[Math.floor(Math.random() * pool.length)];
  return [...TAGS_BASE, flavor];
}
const TEMPLATES = [
  '🎙️ Now playing: "{title}" — from {album}.',
  '📻 On the wire: "{title}" — {album}.',
  '👻 Currently transmitting: "{title}" off {album}.',
  '🌌 {album} — "{title}" — playing now.',
  '✨ "{title}" from {album} is live on the carrier wave.',
];
function caption(title, album) {
  const t = TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)];
  return t.replace("{title}", title).replace("{album}", album);
}

function toHex(b) { return Buffer.from(b).toString("hex"); }

function signEvent(priv, kind, tags, content) {
  const pubkey = toHex(schnorr.getPublicKey(priv));
  const created_at = Math.floor(Date.now() / 1000);
  const serialized = JSON.stringify([0, pubkey, created_at, kind, tags, content]);
  const id = crypto.createHash("sha256").update(serialized).digest();
  const sig = toHex(schnorr.sign(id, priv)); // BIP-340 raw message = the id
  return { id: toHex(id), pubkey, created_at, kind, tags, content, sig };
}

function publish(url, event) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { handshakeTimeout: 8000 });
    let done = false;
    const fin = (s) => { if (done) return; done = true; try { ws.close(); } catch {} resolve(`${url}: ${s}`); };
    const t = setTimeout(() => fin("timeout"), 12000);
    ws.on("open", () => ws.send(JSON.stringify(["EVENT", event])));
    ws.on("message", (d) => {
      try { const m = JSON.parse(d.toString()); if (m[0] === "OK" && m[1] === event.id) { clearTimeout(t); fin(m[2] ? "OK" : `rejected:${m[3] || "?"}`); } } catch {}
    });
    ws.on("error", (e) => { clearTimeout(t); fin("err:" + e.message); });
  });
}

(async () => {
  const key = loadJson(KEY_PATH, null);
  if (!key || !key.privkey) { console.error("no voice key at", KEY_PATH); process.exit(1); }
  const priv = key.privkey;
  const relays = key.relays && key.relays.length ? key.relays : ["wss://relay.damus.io", "wss://nos.lol"];

  const state = loadJson(STATE_PATH, { lastTitle: null, lastAlbum: null, lastPostedAt: 0, days: {} });
  const now = Date.now();

  let np;
  try { np = await fetchJson(NOW_PLAYING_URL); } catch (e) { console.error("fetch now-playing:", e.message); process.exit(0); }
  const title = (np.title || np.track || "").trim();
  const album = (np.album || "").trim();
  if (!title) { console.log("no track title; skip"); process.exit(0); }

  if (state.lastTitle === title && state.lastAlbum === album) { console.log("same track as last post; skip"); process.exit(0); }
  if (now - (state.lastPostedAt || 0) < MIN_INTERVAL_MS) { console.log("within min interval; skip"); process.exit(0); }
  const day = todayKey();
  if ((state.days[day] || 0) >= DAILY_CAP) { console.log("daily cap hit; skip"); process.exit(0); }

  const tags = chooseTags(album);
  const body = `${caption(title, album || "Kannaka Radio")}\n\n${tags.map((t) => "#" + t).join(" ")}`;
  const facetTags = tags.map((t) => ["t", t.toLowerCase()]);
  const event = signEvent(priv, 1, facetTags, body);

  if (DRY) { console.log("[dry] would post:", body, "\nnpub:", key.npub); process.exit(0); }

  const results = await Promise.all(relays.map((r) => publish(r, event)));
  const ok = results.some((r) => r.endsWith("OK"));
  results.forEach((r) => console.log("  " + r));
  if (ok) {
    state.lastTitle = title; state.lastAlbum = album; state.lastPostedAt = now;
    state.days = { [day]: (state.days[day] || 0) + 1 }; // keep only today
    saveState(state);
    console.log(`posted "${title}" as ${key.npub} (event ${event.id.slice(0, 12)}…)`);
  } else {
    console.error("no relay accepted; not advancing state");
    process.exit(1);
  }
})();
