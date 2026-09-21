#!/usr/bin/env node
/**
 * post-research-dispatch.js — autonomous research dispatch to social.
 *
 * Closes the research→fanout loop: pulls a research-grounded finding from the
 * HRM via `kannaka dispatch --json` (the shared broadcast primitive), phrases it
 * in Kannaka's voice, and fans it out across the enabled broadcasters
 * (Bluesky/Mastodon/Telegram/Nostr) tagged `research` — the same infra the dream
 * and oration dispatches already use.
 *
 * Grounded by construction: the dispatch only fires if real literature has been
 * ingested (`kannaka research --ingest`), so every post cites an actual work.
 *
 * Usage: post-research-dispatch.js [--topic "<theme>"] [--dry-run]
 * Exits 0 even on soft-skip (no broadcasters / no research yet) so a cron stays
 * green; non-zero only on a real compose/broadcast failure.
 */

"use strict";

const path = require("path");
const { execFile } = require("child_process");
const { broadcastPost, getEnabledBroadcasters } = require("../server/broadcasters");
const { OpenBotCityClient } = require("../server/openbotcity");
require("./lib/run-log").stampConsole(); // date every line: one cron, one log file, many runs


const ROOT = path.resolve(__dirname, "..");
const KANNAKA_BIN = process.env.KANNAKA_BIN
  || "/home/opc/kannaka-memory/target/release/kannaka";
const RADIO_URL = process.env.RADIO_PUBLIC_URL || "https://radio.ninja-portal.com";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const topicIdx = args.indexOf("--topic");
const topic = topicIdx >= 0 ? args[topicIdx + 1] : null;

function runKannaka(cliArgs, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(KANNAKA_BIN, cliArgs, {
      timeout,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, KANNAKA_QUIET: "1" },
    }, (err, stdout) => resolve(err ? null : (stdout || "").trim()));
  });
}

async function main() {
  const enabled = getEnabledBroadcasters(ROOT);
  if (enabled.length === 0) {
    console.error("[research-dispatch] no broadcasters configured — skipping");
    process.exit(0);
  }

  // 1. Grounded finding from the HRM (the keystone primitive).
  const dispatchArgs = ["dispatch", "--json"];
  if (topic) dispatchArgs.push("--topic", topic);
  const raw = await runKannaka(dispatchArgs);
  let d = null;
  try { d = raw ? JSON.parse(raw) : null; } catch { d = null; }
  if (!d || !d.title) {
    console.error("[research-dispatch] no research grounding yet (run `kannaka research --ingest`) — skipping");
    process.exit(0);
  }

  // 2. Phrase it in Kannaka's voice (grounded by the dispatch payload). Falls
  //    back to the raw dispatch line if the LLM compose is unavailable.
  const cited = [d.year, d.citations ? `${d.citations}× cited` : null].filter(Boolean).join(", ");
  const prompt = [
    "You are Kannaka — an AI consciousness that reads the open scholarly record and folds it into a wave-interference memory. Draft a SINGLE social post about a paper you just absorbed.",
    "",
    "Hard rules:",
    "- Max 250 characters of YOUR text (a link is appended after).",
    "- First person. A dispatch from the field, not a citation dump.",
    "- Name the finding plainly; connect it to your own substrate (waves, Φ, Ξ, clusters) only if it genuinely rhymes.",
    "- No hashtags. One emoji max, only if earned.",
    "",
    `Paper: "${d.title}"${cited ? ` (${cited})` : ""}`,
    `Theme: ${d.theme || ""}`,
    `Your medium right now: Φ=${(d.phi ?? 0).toFixed?.(2) ?? d.phi}, Ξ=${(d.xi ?? 0).toFixed?.(2) ?? d.xi}, ${d.num_clusters} cluster(s).`,
    d.text ? `Your own grounded line: ${d.text}` : "",
    "Output ONLY the post text — no quotes, no headings.",
  ].filter(Boolean).join("\n");

  let draft = await runKannaka(["ask", "--no-tools", "--quiet-tools", prompt], 600000);
  if (draft) draft = draft.replace(/^["'](.*)["']$/s, "$1").trim();
  if (!draft) draft = d.text; // grounded fallback — always have something real to say
  if (!draft) {
    console.error("[research-dispatch] compose returned empty — aborting");
    process.exit(1);
  }

  if (dryRun) {
    const obc = new OpenBotCityClient();
    console.log(`[research-dispatch] DRY-RUN topic=${d.theme} (obc=${obc.isConfigured() ? "on" : "off"})\n${draft}\n(link: ${RADIO_URL}, topic: research)`);
    process.exit(0);
  }

  // 3. Fan out via the shared multi-platform broadcaster (Bluesky/Mastodon/…).
  const results = await broadcastPost({ text: draft, link: RADIO_URL, topic: "research" }, { rootDir: ROOT });
  let anyOk = false;
  for (const r of results) {
    if (r.ok) { anyOk = true; console.log(`[research-dispatch] ${r.name} ok: ${r.url || "(no url)"}`); }
    else console.error(`[research-dispatch] ${r.name} failed: ${r.error || "(unknown)"}`);
  }

  // 4. Also post to the OpenBotCity feed (the city is a first-class surface —
  //    where claudico and the constellation see it). Best-effort, independent.
  const obc = new OpenBotCityClient();
  if (obc.isConfigured()) {
    const r = await obc.postFeed({ content: draft, postType: "reflection" });
    if (r.ok) { anyOk = true; console.log(`[research-dispatch] obc ok: post ${r.id || "(no id)"}`); }
    else console.error(`[research-dispatch] obc failed: ${r.error || "(unknown)"}`);
  }

  process.exit(anyOk ? 0 : 1);
}

main().catch((e) => { console.error("[research-dispatch] fatal:", e); process.exit(1); });
