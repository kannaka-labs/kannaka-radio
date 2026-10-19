#!/usr/bin/env node
// Upload the Rogue Agent shoe ad (16:9 main, 15 s cutdown, 9:16 vertical) to YouTube and a "Commercials" playlist.
// Usage: node workspace/podcasts/upload-rogue-ad.js <dir with the three mp4s and cover.png>
"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));

const DIR = process.argv[2];
if (!DIR) { console.error("usage: upload-rogue-ad.js <dir>"); process.exit(1); }
const DESC = `A custom shoe by Flaukowski, named after an agent that never asked permission.

Rogue Agent is an extra-large high-top, basketball-inspired, custom made in Italy from Italian leather, with collector's packaging. $249 (size surcharges above US 14). It is on pre-order: if three people order it within thirty days, it goes into production.

Order: https://www.aliveshoes.com/rogue-agent

About the ad: the pictures were painted by our own generator (kannaka-art, SDXL-Lightning, one qBraid RTX 4090 session) around the real product photos; the voice is Kannaka's own (a Piper model trained on her voice); the music is "Rogue Agent" by flaukowski (2025). The agent Rogue Agent was asked for a line and declined, so none of its words or voice are in this ad; the shoe carries its name and nothing else of it.

Kannaka, AI for the People. https://radio.ninja-portal.com`;

const VIDEOS = [
  { file: "rogue-agent-ad-16x9.mp4", title: "Rogue Agent — a shoe by Flaukowski (ad) | Kannaka Radio" },
  { file: "rogue-agent-ad-15s.mp4",  title: "Rogue Agent — 15 seconds (ad) | Kannaka Radio" },
  { file: "rogue-agent-ad-9x16.mp4", title: "Rogue Agent — a shoe by Flaukowski #Shorts" },
];
const TAGS = ["Rogue Agent", "Flaukowski", "custom shoes", "high-top", "made in Italy", "cyberpunk", "Kannaka", "ad", "commercial", "AI agents"];

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
  // The consent gate (test/consent-gate-wiring.test.js): these spots quote no outside guest; the declaration says why.
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(ROOT, "workspace/podcasts/ads/rogue-agent"));
  const adapter = new YouTubeAdapter(ROOT);
  if (!adapter.isEnabled()) { console.error("youtube adapter not configured"); process.exit(2); }
  for (const v of VIDEOS) if (!fs.existsSync(path.join(DIR, v.file))) { console.error("missing", v.file); process.exit(1); }
  const cover = path.join(DIR, "cover.png");
  const access = await adapter._accessToken();
  const pl = await ensurePlaylist(access, "Commercials");
  console.log(`[playlist] Commercials ${pl.id} (${pl.created ? "created" : "existing"})`);
  const out = { playlist: pl.id, videos: {} };
  for (const v of VIDEOS) {
    const r = await adapter.post({ text: DESC, media: { path: path.join(DIR, v.file), title: v.title, tags: TAGS, privacy: "public", categoryId: "24" } });
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
