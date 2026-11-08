#!/usr/bin/env node
/**
 * youtube-upload-test.js — direct upload via the YouTube adapter,
 * bypassing the multi-broadcaster fan-out. Useful for verifying the
 * pipeline (auth, ffmpeg render, multipart upload) without spamming
 * Bluesky/Mastodon/Telegram/Nostr each test.
 *
 * Args:
 *   --title "Title"
 *   --description "Description body"
 *   --audio /path/to/track.mp3   (required)
 *   --image /path/to/cover.png   (required)
 *   --tags "a,b,c"               (optional)
 *   --privacy public|unlisted|private  (default unlisted)
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { YouTubeAdapter } = require("../server/broadcasters/youtube-adapter");
// A public or unlisted upload is remembered by the adapter (voice-writeback.js
// wrapDirectPost; a private one is not); flush() before process.exit.
const voiceWriteback = require("../server/voice-writeback");
const { renderAudioMp4 } = require("../server/broadcasters/render-audio-mp4");
const { renderMusicVideo } = require("../server/broadcasters/render-music-video");

const ROOT = path.resolve(__dirname, "..");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : "";
}

const VISUAL_EXT = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v", ".png", ".jpg", ".jpeg", ".webp", ".bmp"]);

function gatherSources(videoDir, videos, image) {
  const out = [];
  if (videoDir) {
    const dir = path.resolve(videoDir);
    if (fs.existsSync(dir)) {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && VISUAL_EXT.has(path.extname(e.name).toLowerCase()))
        .map((e) => path.join(dir, e.name))
        .sort();
      out.push(...entries);
    }
  }
  if (videos) out.push(...videos.split(",").map((s) => s.trim()).filter(Boolean));
  if (image) out.push(image);
  return out;
}

async function main() {
  const title = arg("--title");
  const description = arg("--description") || "";
  const audio = arg("--audio");
  const image = arg("--image");
  const videoDir = arg("--video-dir");
  const videos = arg("--videos");
  const tagsArg = arg("--tags");
  const privacy = arg("--privacy") || "unlisted";

  const sources = gatherSources(videoDir, videos, image);
  if (!title || !audio || sources.length === 0) {
    console.error('Usage: youtube-upload-test.js --title "..." --audio PATH (--image PATH | --video-dir PATH | --videos a.mp4,b.mp4) [--description ...] [--tags "a,b"] [--privacy unlisted|public|private]');
    process.exit(64);
  }

  const adapter = new YouTubeAdapter(ROOT);
  if (!adapter.isEnabled()) {
    console.error("[yt-test] adapter not enabled — is .youtube.json present at the project root?");
    process.exit(2);
  }
  console.log(`[yt-test] adapter ok; channel: ${adapter._creds.channel_title || "(unknown)"}`);
  if (adapter._creds.playlist_id) {
    console.log(`[yt-test] auto-add to playlist: ${adapter._creds.playlist_title || adapter._creds.playlist_id}`);
  }

  const outPath = path.join(os.tmpdir(), `kannaka-yt-test-${Date.now()}.mp4`);
  console.log(`[yt-test] rendering ${sources.length} source(s) → ${outPath}`);
  for (const s of sources) console.log(`  - ${s}`);

  const t0 = Date.now();
  let renderResult;
  if (sources.length === 1 && /\.(png|jpg|jpeg|webp|bmp)$/i.test(sources[0])) {
    renderResult = await renderAudioMp4({ audioPath: audio, imagePath: sources[0], outPath });
  } else {
    renderResult = await renderMusicVideo({ audioPath: audio, sources, outPath });
  }
  const { durationSec } = renderResult;
  const sizeMB = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(1);
  console.log(`[yt-test] rendered ${Math.round(durationSec)}s / ${sizeMB} MB in ${Math.round((Date.now() - t0) / 1000)}s`);

  const tags = tagsArg
    ? tagsArg.split(",").map((s) => s.trim()).filter(Boolean)
    : ["kannaka", "ambient", "ai music", "ghost frequency"];

  const media = { path: outPath, title, tags, privacy };
  console.log(`[yt-test] uploading (privacy=${privacy})...`);
  const result = await adapter.post({ text: description, link: "", media });
  if (result.ok) {
    console.log(`[yt-test] ok: ${result.url}`);
    if (result.playlist) console.log(`[yt-test] playlist: ${result.playlist}`);
  } else {
    console.error(`[yt-test] failed: ${result.error}`);
  }
  try { fs.unlinkSync(outPath); } catch (_) {}

  await voiceWriteback.flush();
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`[yt-test] fatal: ${e.message}`);
  process.exit(3);
});
