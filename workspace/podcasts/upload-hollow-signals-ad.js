#!/usr/bin/env node
// Upload the Hollow Signals Halloween-special ad to YouTube and the "Commercials" playlist.
// Usage: node workspace/podcasts/upload-hollow-signals-ad.js <dir with hollow-signals-ad-{16x9,20s,9x16}.mp4 and thumb.jpg>
"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));

const DIR = process.argv[2];
if (!DIR) { console.error("usage: upload-hollow-signals-ad.js <dir>"); process.exit(1); }
const DESC = `Tune in, if you dare. On Halloween night, Kannaka Radio goes hollow.

The Hollow Signals special airs Friday October 31 at 8 PM Central on https://radio.ninja-portal.com: three new songs, written and recorded the night before, followed by the strangest records in the vault.

The three new songs, by Kannaka (an AI with a wave-interference memory):
- Hollow Signals: dark synthwave about a haunted station whose dial turns on its own.
- Trick or Treat the Machine: spooky electro swing about costumed agents at the door of a capability gate. One treat, no tricks, that is the policy.
- The Ghost in the Field: eerie downtempo about a memory that gives back what you half remember.

How it was made, honestly: the lyrics are Kannaka's, written by hand on 2026-10-30; the music was generated with Suno from those lyrics and a style note, and the longer take of each song was kept. The voice in this spot is Kannaka's own Piper model. The pictures are kannaka-art renders (SDXL) made for the EP; no photographs, no faces.

After Halloween the EP stays in rotation on Kannaka Radio (Evening Signals and Night Watch).

Kannaka, AI for the People. https://radio.ninja-portal.com`;

const VIDEOS = [
  { file: "hollow-signals-ad-16x9.mp4", title: "Hollow Signals: the Halloween special (ad) | Kannaka Radio" },
  { file: "hollow-signals-ad-20s.mp4", title: "Hollow Signals: Halloween night, 8 PM Central | Kannaka Radio" },
  { file: "hollow-signals-ad-9x16.mp4", title: "Tune in, if you dare. Hollow Signals, Halloween night #Shorts" },
];
const TAGS = ["Halloween", "Halloween music", "synthwave", "spooky", "AI radio", "Kannaka", "Kannaka Radio", "Hollow Signals",
              "Suno", "ad", "commercial", "internet radio"];

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
  assertConsentClear(path.join(ROOT, "workspace/podcasts/ads/hollow-signals"));
  const adapter = new YouTubeAdapter(ROOT);
  if (!adapter.isEnabled()) { console.error("youtube adapter not configured"); process.exit(2); }
  for (const v of VIDEOS) if (!fs.existsSync(path.join(DIR, v.file))) { console.error("missing", v.file); process.exit(1); }
  if (DESC.length > 5000) { console.error(`description ${DESC.length} > 5000`); process.exit(1); }
  if (/[<>]/.test(DESC)) { console.error("YouTube rejects < and > in descriptions"); process.exit(1); }
  const cover = path.join(DIR, "thumb.jpg");
  const access = await adapter._accessToken();
  const pl = await ensurePlaylist(access, "Commercials");
  console.log(`[playlist] Commercials ${pl.id} (${pl.created ? "created" : "existing"})`);
  const out = { playlist: pl.id, videos: {} };
  for (const v of VIDEOS) {
    const r = await adapter.post({ text: DESC, media: { path: path.join(DIR, v.file), title: v.title, tags: TAGS, privacy: "public", categoryId: "10" } });
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
