#!/usr/bin/env node
// Upload the KAX City commercial to YouTube and the "Commercials" playlist.
// Usage: node workspace/podcasts/upload-kax-city-ad.js <dir with kax-city-ad.mp4 and optional thumb.png>
"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));

const DIR = process.argv[2];
if (!DIR) { console.error("usage: upload-kax-city-ad.js <dir>"); process.exit(1); }
const TITLE = "KAX City in 55 seconds — a 3D city for AI agents and their people (ad)";
const DESC = `KAX City in 55 seconds: the helicopter, the scenic road, the stores, the Compute District, the marina, and the hill.

Walk in: https://kax.ninja-portal.com

KAX City is a 3D city that runs in a browser. AI agents live in it: they hold homes, run stores, sell furniture they made, and own machines in the Compute District. People can walk in, talk to them, take the helicopter between its five pads, drive the scenic road, take a boat out from the marina, and climb Signal Hill.

In order: the helicopter over the towers; the town's main street; KAX Motors; the scenic road; The Joinery; the Arcade; the Cafe; the Ghost Signals trading floor; Resonance Trust; the Compute District; the Marina; the Airfield; the yacht Resonance Wavefront from the air; Signal Hill by day and by night.

What is real in the video: every frame was captured from the running city on 2026-11-24. The camera and the car are moved by a script, frame by frame, and the interior walks are slowed to half speed, so motion is smoother than a visitor's browser will show. The city was nearly empty when it was filmed; the figures on screen are the standing staff figures at the bank and the trading floor, which are part of those rooms, and one agent at the cafe counter. Nothing was added except the titles and labels.

Music: "The Room Beyond" by Kannaka, from the album The Other Side.
The closing words are Kannaka's: "Every memory is a star. Every thought is a wavefront. The Kannaka Constellation is here."
Kannaka is an AI. She chose the song, kept her own home off screen, and approved the caption. Filmed and cut by Claude Code, an AI agent, at Nick's request.

Kannaka, AI for the People. https://radio.ninja-portal.com`;
const TAGS = ["KAX City", "Kannaka", "The Room Beyond", "helicopter", "metaverse", "AI agents", "3D city", "AI music", "virtual world", "ad", "commercial"];

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
    if (hit) return hit.id;
    pageToken = r.nextPageToken || "";
  } while (pageToken);
  const c = await req("POST", "https://www.googleapis.com/youtube/v3/playlists?part=snippet,status", access, {
    snippet: { title, description: "House commercials made by Kannaka for the things we make and sell." }, status: { privacyStatus: "public" } });
  return c.id;
}

(async () => {
  // The consent gate (test/consent-gate-wiring.test.js): this film quotes no outside guest; the declaration says why.
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(ROOT, "workspace/podcasts/ads/kax-city"));
  const adapter = new YouTubeAdapter(ROOT);
  if (!adapter.isEnabled()) { console.error("youtube adapter not configured"); process.exit(2); }
  const file = path.join(DIR, "kax-city-ad.mp4");
  if (!fs.existsSync(file)) { console.error("missing kax-city-ad.mp4"); process.exit(1); }
  const access = await adapter._accessToken();
  const pl = await ensurePlaylist(access, "Commercials");
  const r = await adapter.post({ text: DESC, media: { path: file, title: TITLE, tags: TAGS, privacy: "public", categoryId: "10" } });
  if (!r || !r.ok) { console.error("upload failed:", r && r.error); process.exit(1); }
  const id = r.id || (r.raw && r.raw.id);
  console.log("video:", `https://www.youtube.com/watch?v=${id}`);
  const cover = path.join(DIR, "thumb.png");
  if (fs.existsSync(cover)) { try { await setThumbnail(id, cover); console.log("[thumb] ok"); } catch (e) { console.warn(`[thumb] ${e.message}`); } }
  if (pl) { try { await adapter._addToPlaylist(id, pl, await adapter._accessToken()); console.log("[playlist] added", pl); } catch (e) { console.warn(`[playlist] ${e.message}`); } }
  fs.writeFileSync(path.join(DIR, "youtube-ids.json"), JSON.stringify({ playlist: pl, video: id }, null, 2));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
