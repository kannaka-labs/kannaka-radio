#!/usr/bin/env node
/**
 * post-track-announce.js — One-shot multi-broadcaster announcement of a
 * single track entering the radio's library.
 *
 * Used to announce "First Heartbeat" — Kannaktopus's emergence track —
 * across Bluesky, Mastodon, Telegram, Nostr, and (when --audio + --image
 * are passed) YouTube in one shot. Reuses the same `broadcastPost`
 * pipeline as the dream cron's social fan-out so credentials, formatting,
 * and per-platform link policies stay shared.
 *
 * Env / args:
 *   --title "Track Title"       (required)
 *   --reason "what happened"    (required, ≤ 240 chars)
 *   --link  "https://..."       (defaults to RADIO_PUBLIC_URL)
 *   --audio /path/to/track.mp3  (optional — enables YouTube)
 *   --image /path/to/cover.png  (optional — required if --audio is set)
 *   --tags "tag1,tag2,..."      (optional — YouTube discovery tags)
 *
 * When --audio + --image are set, ffmpeg renders a still-image MP4 and
 * the YouTube adapter uploads it. Other broadcasters ignore the media
 * field. If ffmpeg fails or YouTube is unconfigured, the rest of the
 * fan-out still runs.
 *
 * Exit 0 if any broadcaster succeeded, non-zero if all failed.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { broadcastPost, broadcastReply, getEnabledBroadcasters } = require("../server/broadcasters");
const { renderAudioMp4 } = require("../server/broadcasters/render-audio-mp4");
const voiceWriteback = require("../server/voice-writeback");

const ROOT = path.resolve(__dirname, "..");
const RADIO_URL = process.env.RADIO_PUBLIC_URL || "https://radio.ninja-portal.com";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : "";
}

async function main() {
  const title = arg("--title");
  const reason = arg("--reason");
  const link = arg("--link") || `${RADIO_URL}/player`;
  const audio = arg("--audio");
  const image = arg("--image");
  const tagsArg = arg("--tags");
  if (!title || !reason) {
    console.error('Usage: post-track-announce.js --title "..." --reason "..." [--link "..."] [--audio path --image path] [--tags "a,b,c"]');
    process.exit(64);
  }
  if (audio && !image) {
    console.error("[track-announce] --image is required when --audio is set (we render a still-image music video for YouTube)");
    process.exit(64);
  }

  const enabled = getEnabledBroadcasters(ROOT);
  if (enabled.length === 0) {
    console.error("[track-announce] no broadcasters configured");
    process.exit(0);
  }
  console.log(`[track-announce] enabled: ${enabled.map((b) => b.name).join(", ")}`);

  const text = `"${title}" just landed in the rotation. ${reason}`.slice(0, 220);

  // Optional video render path — only when both --audio and --image are
  // provided. Failures here are non-fatal: we still ship the text-only
  // broadcasters so a single ffmpeg hiccup doesn't kill the whole post.
  let media = null;
  if (audio && image) {
    const outPath = path.join(os.tmpdir(), `kannaka-track-${Date.now()}.mp4`);
    console.log(`[track-announce] rendering MP4 to ${outPath}`);
    try {
      const { durationSec } = await renderAudioMp4({ audioPath: audio, imagePath: image, outPath });
      console.log(`[track-announce] rendered ${Math.round(durationSec)}s of video`);
      const tags = tagsArg
        ? tagsArg.split(",").map((s) => s.trim()).filter(Boolean)
        : ["kannaka", "ambient", "ai music", "ghost frequency"];
      media = { path: outPath, title, tags, privacy: process.env.YT_PRIVACY || "public" };
    } catch (e) {
      console.error(`[track-announce] render failed: ${e.message}`);
      console.error("[track-announce] continuing with text-only broadcasters");
    }
  }

  const results = await broadcastPost({ text, link, media, composer: "operator-supplied reason via post-track-announce.js" }, { rootDir: ROOT });
  let anyOk = false;
  for (const r of results) {
    if (r.ok) {
      anyOk = true;
      console.log(`[track-announce] ${r.name} ok: ${r.url || "(no url)"}`);
    } else {
      console.error(`[track-announce] ${r.name} failed: ${r.error}`);
    }
  }

  // ── Thread the YouTube video as a comment under each post ──────────────
  // Use a pre-known video (--youtube, e.g. an album film built earlier in the
  // release), otherwise the one we just made + uploaded via --audio/--image.
  // Bluesky and Mastodon drop body URLs, so a reply is the only way the video
  // surfaces there — this automates the "comment the video" step by hand.
  let ytUrl = arg("--youtube") || "";
  if (!ytUrl) {
    const yt = results.find((r) => r.name === "youtube" && r.ok && r.url);
    if (yt) ytUrl = yt.url;
  }
  if (ytUrl) {
    const caption = arg("--video-caption") || "▶ Watch the video:";
    const replyText = `${caption} ${ytUrl}`.trim();
    const replies = await broadcastReply(results, replyText, {
      rootDir: ROOT,
      // Only a video link under the announce, which is already remembered.
      writeBack: false,
    });
    for (const r of replies) {
      if (r.ok) console.log(`[track-announce] ${r.name} video-comment ok: ${r.url || "(posted)"}`);
      else console.error(`[track-announce] ${r.name} video-comment skipped: ${r.error}`);
    }
  }

  // Clean up render artefact — ok to leave it if cleanup fails.
  if (media && media.path) {
    try { fs.unlinkSync(media.path); } catch (_) {}
  }

  await voiceWriteback.flush(); // let the write-back to her store finish
  process.exit(anyOk ? 0 : 2);
}

main().catch((e) => {
  console.error(`[track-announce] fatal: ${e.message}`);
  process.exit(3);
});
