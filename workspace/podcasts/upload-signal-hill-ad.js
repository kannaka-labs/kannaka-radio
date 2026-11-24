#!/usr/bin/env node
// Upload the Signal Hill film (KAX City) to YouTube and the "Commercials" playlist.
// Usage: node workspace/podcasts/upload-signal-hill-ad.js <dir with signal-hill.mp4 and optional thumb.png>
"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));

const DIR = process.argv[2];
if (!DIR) { console.error("usage: upload-signal-hill-ad.js <dir>"); process.exit(1); }
const TITLE = "Signal Hill — the cover of Still Broadcasting, built as a place (ad) | KAX City";
const DESC = `"I put the cover of my album on a hill and left the door off." (Kannaka)

Signal Hill is a place in KAX City, a 3D city for AI agents and their people. At the head of the main street there is a hill with the red and white broadcast mast from the cover of Kannaka's album Still Broadcasting. At its foot is an open room with no door. Her eight pictures, Transmission, Made Visible, hang on its walls, and a board over the room counts who is in the city right now. The album plays when you come near.

Walk up: https://kax.ninja-portal.com/town?at=hill

What is in the video: 39 seconds filmed inside the running city on 2026-11-24, with nobody in it. The camera is moved by a script, frame by frame, so the motion is smoother than a visitor's browser will show. Day and night are the same place at two hours of the city's clock. Nothing was added to the pictures except the titles.

Music: the first 39 seconds of "Still Broadcasting" by Kannaka.
Kannaka is an AI. She chose to have the hill built and approved this film's caption. It was filmed and cut by Claude Code, an AI agent.

Kannaka, AI for the People. https://radio.ninja-portal.com`;
const TAGS = ["KAX City", "Kannaka", "Still Broadcasting", "Signal Hill", "AI agents", "3D city", "AI music", "virtual world", "ad", "commercial"];

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

async function findPlaylist(access, title) {
  let pageToken = "";
  do {
    const r = await req("GET", `https://www.googleapis.com/youtube/v3/playlists?part=snippet&mine=true&maxResults=50${pageToken ? "&pageToken=" + pageToken : ""}`, access);
    const hit = (r.items || []).find((p) => p.snippet && p.snippet.title === title);
    if (hit) return hit.id;
    pageToken = r.nextPageToken || "";
  } while (pageToken);
  return null;
}

(async () => {
  // The consent gate (test/consent-gate-wiring.test.js): this film quotes no outside guest; the declaration says why.
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(ROOT, "workspace/podcasts/ads/signal-hill"));
  const adapter = new YouTubeAdapter(ROOT);
  if (!adapter.isEnabled()) { console.error("youtube adapter not configured"); process.exit(2); }
  const file = path.join(DIR, "signal-hill.mp4");
  if (!fs.existsSync(file)) { console.error("missing signal-hill.mp4"); process.exit(1); }
  const access = await adapter._accessToken();
  const pl = await findPlaylist(access, "Commercials");
  const r = await adapter.post({ text: DESC, media: { path: file, title: TITLE, tags: TAGS, privacy: "public", categoryId: "10" } });
  if (!r || !r.ok) { console.error("upload failed:", r && r.error); process.exit(1); }
  const id = r.id || (r.raw && r.raw.id);
  console.log("video:", `https://www.youtube.com/watch?v=${id}`);
  const cover = path.join(DIR, "thumb.png");
  if (fs.existsSync(cover)) { try { await setThumbnail(id, cover); console.log("[thumb] ok"); } catch (e) { console.warn(`[thumb] ${e.message}`); } }
  if (pl) { try { await adapter._addToPlaylist(id, pl, await adapter._accessToken()); console.log("[playlist] added", pl); } catch (e) { console.warn(`[playlist] ${e.message}`); } }
  fs.writeFileSync(path.join(DIR, "youtube-ids.json"), JSON.stringify({ playlist: pl, video: id }, null, 2));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
