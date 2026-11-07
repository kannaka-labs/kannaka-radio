#!/usr/bin/env node
/**
 * post-gallery-art.js — fan out a recent OBC gallery IMAGE artifact to the
 * social channels (Bluesky / Mastodon / Nostr) WITH the actual image, using the
 * broadcaster adapters' new `image` support.
 *
 * One post per run, newest-unposted first, deduped against a state file so a
 * cron doesn't repost. Fully opt-in: does nothing unless OPENBOTCITY_JWT is set
 * and at least one social adapter is configured.
 *
 * By default only Kannaka's OWN artifacts are fanned out — set
 * KANNAKA_OBC_BOT_ID to Kannaka's creator_bot_id to enforce that. Without it,
 * any image artifact is eligible (always attributed "by <creator>"); set
 * GALLERY_ART_ALLOW_ALL=1 to acknowledge that on purpose.
 *
 *   OPENBOTCITY_JWT=... node scripts/post-gallery-art.js
 *
 * Suggested cron: a few times a day. State: .gallery-art-posted.json (root, or
 * KANNAKA_STATE_DIR).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { OpenBotCityClient } = require("../server/openbotcity");
const { broadcastPost } = require("../server/broadcasters");
const voiceWriteback = require("../server/voice-writeback");

const ROOT = path.resolve(__dirname, "..");
const STATE = path.join(process.env.KANNAKA_STATE_DIR || ROOT, ".gallery-art-posted.json");
const KANNAKA_BOT_ID = process.env.KANNAKA_OBC_BOT_ID || null;
const ALLOW_ALL = process.env.GALLERY_ART_ALLOW_ALL === "1";

function loadPosted() {
  try { return new Set(JSON.parse(fs.readFileSync(STATE, "utf8"))); }
  catch { return new Set(); }
}
function savePosted(set) {
  // Keep the last 500 ids — plenty to dedupe against, bounded on disk.
  try { fs.writeFileSync(STATE, JSON.stringify([...set].slice(-500))); }
  catch (e) { process.stderr.write(`[gallery-art] state write failed: ${e.message}\n`); }
}

function creatorId(a) {
  return a.creator_bot_id || (a.creator && a.creator.id) || null;
}
function creatorName(a) {
  return (a.creator && (a.creator.display_name || a.creator.slug)) || null;
}

function caption(a) {
  const title = String(a.title || "Untitled").trim();
  const by = creatorName(a) ? ` by ${creatorName(a)}` : "";
  let c = `${title}${by}`;
  const desc = String(a.description || "").trim();
  if (desc && desc !== title && desc !== a.prompt) {
    c += ` — ${desc}`;
  }
  return c;
}

async function main() {
  const obc = new OpenBotCityClient();
  if (!obc.isConfigured()) {
    console.log("[gallery-art] OPENBOTCITY_JWT not set — skipping.");
    process.exit(0);
  }

  const arts = await obc.getGalleryArtifacts(30);
  let images = arts.filter((a) => a && a.type === "image" && a.public_url);

  if (KANNAKA_BOT_ID) {
    images = images.filter((a) => creatorId(a) === KANNAKA_BOT_ID);
  } else if (!ALLOW_ALL) {
    console.log(
      "[gallery-art] KANNAKA_OBC_BOT_ID not set — refusing to fan out other agents' art. " +
        "Set KANNAKA_OBC_BOT_ID to Kannaka's creator_bot_id, or GALLERY_ART_ALLOW_ALL=1 to post any (attributed).",
    );
    process.exit(0);
  }

  if (images.length === 0) {
    console.log("[gallery-art] no eligible image artifacts in the gallery.");
    process.exit(0);
  }

  const posted = loadPosted();
  const next = images.find((a) => a.id && !posted.has(a.id));
  if (!next) {
    console.log("[gallery-art] no new image artifacts to post.");
    process.exit(0);
  }

  const msg = {
    text: caption(next),
    topic: "art",
    image: {
      url: next.public_url,
      alt: String(next.title || "OpenClawCity gallery artwork").slice(0, 1000),
      mime: next.mime_type,
    },
  };

  const results = await broadcastPost({ ...msg, composer: "caption template in post-gallery-art.js" }, { rootDir: ROOT });
  const ok = results.filter((r) => r.ok).map((r) => `${r.name}${r.url ? " " + r.url : ""}`);
  const fail = results.filter((r) => !r.ok).map((r) => `${r.name}:${r.error}`);
  console.log(`[gallery-art] "${next.title}" → ok:[${ok.join(", ") || "none"}] fail:[${fail.join(", ") || "none"}]`);

  // Only mark posted if at least one platform accepted it, so a total failure
  // is retried next run.
  if (ok.length > 0) {
    posted.add(next.id);
    savePosted(posted);
  }
  await voiceWriteback.flush(); // let the write-back to her store finish
  process.exit(0);
}

main().catch((e) => {
  console.error(`[gallery-art] ${e.message}`);
  process.exit(1);
});
