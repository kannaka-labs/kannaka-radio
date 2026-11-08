#!/usr/bin/env node
/**
 * release-album-upload-youtube.js — upload a pre-rendered album MP4
 * to YouTube via the YouTubeAdapter, no re-render. Called by
 * release-album.sh. All inputs come through env vars so the shell
 * caller doesn't have to argv-quote multi-line descriptions:
 *
 *   YT_VIDEO   absolute path to the MP4
 *   YT_TITLE   public title
 *   YT_DESC    description body (newlines preserved)
 *   YT_TAGS    comma-separated tag list
 *   YT_LINK    canonical link (player URL) appended to the post object
 *   YT_PRIVACY public | unlisted | private  (default: public)
 *
 * Exit 0 on success, non-zero otherwise. URL printed on stdout.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
// The adapter remembers a public upload in her store (voice-writeback.js
// wrapDirectPost); flush() lets that store finish before process.exit.
const voiceWriteback = require(path.join(ROOT, "server/voice-writeback"));

const VIDEO = process.env.YT_VIDEO || "";
const TITLE = process.env.YT_TITLE || "";
const DESC  = process.env.YT_DESC  || "";
const TAGS  = (process.env.YT_TAGS || "").split(",").map((s) => s.trim()).filter(Boolean);
const LINK  = process.env.YT_LINK  || "";
const PRIVACY = process.env.YT_PRIVACY || "public";

async function main() {
  if (!VIDEO || !TITLE) {
    console.error("[release-yt] YT_VIDEO and YT_TITLE are required");
    process.exit(64);
  }
  if (!fs.existsSync(VIDEO)) { console.error(`[release-yt] missing ${VIDEO}`); process.exit(2); }
  const adapter = new YouTubeAdapter(ROOT);
  if (!adapter.isEnabled()) {
    console.error("[release-yt] adapter not enabled — is .youtube.json present at the project root?");
    process.exit(2);
  }
  console.log(`[release-yt] channel: ${adapter._creds.channel_title || "(unknown)"}`);
  if (adapter._creds.playlist_id) {
    console.log(`[release-yt] auto-add to playlist: ${adapter._creds.playlist_title || adapter._creds.playlist_id}`);
  }
  const sizeMB = (fs.statSync(VIDEO).size / (1024 * 1024)).toFixed(1);
  console.log(`[release-yt] video: ${VIDEO} (${sizeMB} MB)  privacy=${PRIVACY}`);
  const media = { path: VIDEO, title: TITLE, tags: TAGS, privacy: PRIVACY };
  const result = await adapter.post({ text: DESC, link: LINK, media });
  if (result.ok) {
    console.log(`[release-yt] ok: ${result.url}`);
    if (result.playlist) console.log(`[release-yt] playlist: ${result.playlist}`);
    await voiceWriteback.flush();
    process.exit(0);
  } else {
    console.error(`[release-yt] failed: ${result.error}`);
    process.exit(1);
  }
}
main().catch((e) => { console.error(`[release-yt] fatal: ${e.message}`); process.exit(3); });
