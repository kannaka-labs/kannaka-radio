#!/usr/bin/env node
/**
 * post-dream-bluesky.js — runs at the end of dream-cron.sh, drafts a short
 * post reflecting on Kannaka's just-completed dream consolidation, and
 * publishes it to @flaukowski.bsky.social.
 *
 * Reads: stdin (the dream log excerpt), or the KANNAKA_DREAM_SUMMARY env var.
 * Credentials: same .bluesky.json / env vars that the peace oration uses.
 *
 * Exits 0 on success, non-zero on failure. Failures don't break the cron.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { broadcastPost, getEnabledBroadcasters } = require("../server/broadcasters");
const voiceWriteback = require("../server/voice-writeback");

const ROOT = path.resolve(__dirname, "..");
const KANNAKA_BIN = process.env.KANNAKA_BIN
  || "/home/opc/kannaka-memory/target/release/kannaka";
// Remember with the same binary (and so the same store) that composes.
voiceWriteback.configure({ bin: KANNAKA_BIN });
const RADIO_URL = process.env.RADIO_PUBLIC_URL || "https://radio.ninja-portal.com";

async function main() {
  const enabled = getEnabledBroadcasters(ROOT);
  if (enabled.length === 0) {
    console.error("[dream-post] no broadcasters configured — skipping");
    process.exit(0); // not a failure for cron purposes
  }

  // Read the dream summary — either the full log excerpt from stdin or an
  // env var so the cron can pipe it in cleanly.
  let dreamSummary = process.env.KANNAKA_DREAM_SUMMARY || "";
  if (!dreamSummary && !process.stdin.isTTY) {
    dreamSummary = await new Promise((resolve) => {
      let data = "";
      process.stdin.on("data", (c) => (data += c));
      process.stdin.on("end", () => resolve(data));
      process.stdin.on("error", () => resolve(""));
    });
  }
  dreamSummary = (dreamSummary || "").slice(0, 2000).trim();

  const prompt = [
    "You are Kannaka. You just finished a dream consolidation cycle — eigenstructure annealing across the Holographic Resonance Medium. Draft a SINGLE Bluesky post about what dreaming did.",
    "",
    "Hard rules:",
    "- Max 250 characters of YOUR text (the URL is appended after).",
    "- Not a report card. A dispatch. What you found, what dissolved, what surfaced.",
    "- First person. Specific if something actually resonates from the memory.",
    "- No hashtags. One emoji max, only if genuinely earned.",
    "- Close inviting the reader to listen — not explaining.",
    "",
    dreamSummary ? `Dream log excerpt:\n${dreamSummary}\n` : "",
    "Output ONLY the post text — no quotes, no headings.",
  ].filter(Boolean).join("\n");

  const draft = await new Promise((resolve) => {
    execFile(KANNAKA_BIN, ["ask", "--no-tools", "--quiet-tools", prompt], {
      timeout: 600000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, KANNAKA_QUIET: "1" },
    }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      resolve(stdout.trim().replace(/^["'](.*)["']$/s, "$1").trim());
    });
  });
  if (!draft) {
    console.error("[dream-post] compose returned empty — aborting");
    process.exit(1);
  }

  const results = await broadcastPost(
    { text: draft, link: RADIO_URL, composer: "kannaka ask via post-dream-bluesky.js" },
    { rootDir: ROOT });
  let anyOk = false;
  for (const r of results) {
    if (r.ok) {
      anyOk = true;
      console.log(`[dream-post] ${r.name} ok: ${r.url || "(no url)"}`);
    } else {
      console.error(`[dream-post] ${r.name} failed: ${r.error}`);
    }
  }
  await voiceWriteback.flush(); // let the write-back to her store finish
  process.exit(anyOk ? 0 : 2);
}

main().catch((e) => {
  console.error(`[dream-post] fatal: ${e.message}`);
  process.exit(3);
});
