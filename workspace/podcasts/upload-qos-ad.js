#!/usr/bin/env node
// Upload the QuantumOS console ad to YouTube and the "Commercials" playlist.
// Usage: node workspace/podcasts/upload-qos-ad.js <dir with qos-console-ad-{16x9,short,9x16}.mp4 and thumb.png>
"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));

const DIR = process.argv[2];
if (!DIR) { console.error("usage: upload-qos-ad.js <dir>"); process.exit(1); }
const DESC = `QuantumOS is the operating system we are building: a small x86-64 kernel with a memory field, a capability ledger and a seeded generator. The public console boots one for you.

Press Boot and you get your own real KVM microVM (Firecracker), with no disk and no network. It is restored from a snapshot of a booted machine in about 16 ms, and the qsh prompt is on your screen in about 0.3 s. Each visitor's machine gets its own fresh random seed. You have ten minutes; the machine is deleted when you close the page or the timer runs out. Nothing you type is logged.

Try it: https://qos.ninja-portal.com

Everything in this ad is a real session on the public console, recorded from a browser. The typing is shown at double speed and the pauses between commands were cut; the machine's answers are at real speed. The voice is Kannaka's own (a Piper model trained on her voice). The music is "Heartbeat on the Bus" from our album Swarm Intentions.

Kannaka, AI for the People. https://radio.ninja-portal.com`;

const VIDEOS = [
  { file: "qos-console-ad-16x9.mp4",  title: "QuantumOS — boot your own machine (ad) | Kannaka Radio" },
  { file: "qos-console-ad-short.mp4", title: "QuantumOS — a real VM in 0.3 seconds (ad, short) | Kannaka Radio" },
  { file: "qos-console-ad-9x16.mp4",  title: "QuantumOS — boot your own machine #Shorts" },
];
const TAGS = ["QuantumOS", "operating system", "Firecracker", "microVM", "KVM", "osdev", "kernel", "Kannaka", "ad", "commercial"];

function req(method, url, access, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const data = body ? JSON.stringify(body) : null;
    const r = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: {
      authorization: `Bearer ${access}`, "content-type": "application/json", ...(data ? { "content-length": Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => {
        if (res.statusCode >= 300) return reject(new Error(`${method} ${u.pathname} ${res.statusCode}: ${b.slice(0, 300)}`));
        resolve(b ? JSON.parse(b) : {});
      });
    });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}

async function ensurePlaylist(access, title) {
  let pageToken = "";
  do {
    const r = await req("GET", `https://www.googleapis.com/youtube/v3/playlists?part=snippet&mine=true&maxResults=50${pageToken ? "&pageToken=" + pageToken : ""}`, access);
    const hit = (r.items || []).find((p) => p.snippet && p.snippet.title === title);
    if (hit) return { id: hit.id, created: false };
    pageToken = r.nextPageToken || "";
  } while (pageToken);
  const c = await req("POST", "https://www.googleapis.com/youtube/v3/playlists?part=snippet,status", access, {
    snippet: { title, description: "House commercials made by Kannaka for the things we make and sell." }, status: { privacyStatus: "public" } });
  return { id: c.id, created: true };
}

(async () => {
  // The consent gate (test/consent-gate-wiring.test.js): this spot quotes no outside guest; the declaration says why.
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(ROOT, "workspace/podcasts/ads/quantumos-console"));
  const adapter = new YouTubeAdapter(ROOT);
  if (!adapter.isEnabled()) { console.error("youtube adapter not configured"); process.exit(2); }
  for (const v of VIDEOS) if (!fs.existsSync(path.join(DIR, v.file))) { console.error("missing", v.file); process.exit(1); }
  if (DESC.length > 5000) { console.error(`description ${DESC.length} > 5000`); process.exit(1); }
  const cover = path.join(DIR, "thumb.png");
  const access = await adapter._accessToken();
  const pl = await ensurePlaylist(access, "Commercials");
  console.log(`[playlist] Commercials ${pl.id} (${pl.created ? "created" : "existing"})`);
  const out = { playlist: pl.id, videos: {} };
  for (const v of VIDEOS) {
    const r = await adapter.post({ text: DESC, media: { path: path.join(DIR, v.file), title: v.title, tags: TAGS, privacy: "public", categoryId: "28" } });
    if (!r || !r.ok) { console.error("upload failed:", v.file, r && r.error); process.exit(1); }
    const id = r.id || (r.raw && r.raw.id);
    console.log("video:", v.file, "->", `https://www.youtube.com/watch?v=${id}`);
    out.videos[v.file] = id;
    if (fs.existsSync(cover) && !v.file.includes("9x16")) { try { await setThumbnail(id, cover); console.log("[thumb] ok"); } catch (e) { console.warn(`[thumb] ${e.message}`); } }
    try { await adapter._addToPlaylist(id, pl.id, await adapter._accessToken()); console.log("[playlist] added"); } catch (e) { console.warn(`[playlist] ${e.message}`); }
    await new Promise((r) => setTimeout(r, 45000));
  }
  fs.writeFileSync(path.join(DIR, "youtube-ids.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
