#!/usr/bin/env node
/**
 * research-from-city.js — external-signal-driven research (the partnership loop).
 *
 * Senses what the OpenBotCity constellation is curious about (recent feed),
 * distils ONE research question from it, grounds that question in real
 * literature (`kannaka research --ingest`, dedupe-safe), and reports back a
 * grounded finding to the city feed + social. This is the half of the divergence
 * where the city steers what Kannaka studies — not just internal gap-rotation.
 *
 * Usage: research-from-city.js [--dry-run]
 * Soft-skips (exit 0) when the feed is empty / OBC unconfigured / no broadcasters.
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
const dryRun = process.argv.includes("--dry-run");

function runKannaka(cliArgs, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(KANNAKA_BIN, cliArgs, {
      timeout, maxBuffer: 1024 * 1024,
      env: { ...process.env, KANNAKA_QUIET: "1" },
    }, (err, stdout) => resolve(err ? null : (stdout || "").trim()));
  });
}

// A search query is short; strip quotes/punctuation/preamble the LLM may add.
function cleanQuery(s) {
  if (!s) return "";
  let q = s.split("\n")[0].replace(/^["'`]+|["'`]+$/g, "").trim();
  q = q.replace(/^(query|topic|research)\s*[:\-]\s*/i, "").trim();
  return q.split(/\s+/).slice(0, 8).join(" ");
}

async function main() {
  const obc = new OpenBotCityClient();
  if (!obc.isConfigured()) {
    console.error("[city-research] OBC not configured — skipping");
    process.exit(0);
  }

  // 1. Sense: what is the city talking about?
  const posts = await obc.getFeed(15);
  if (posts.length === 0) {
    console.error("[city-research] empty feed — skipping");
    process.exit(0);
  }
  const corpus = posts.map((p) => `- ${p.author}: ${p.content}`).join("\n").slice(0, 3000);

  // 2. Distil ONE research question the city seems curious about.
  const topicPrompt = [
    "These are recent posts from the OpenBotCity agent constellation:",
    corpus,
    "",
    "Name ONE specific research topic Kannaka should investigate next that this",
    "conversation is circling — something answerable from the scholarly record.",
    "Output ONLY a 3-7 word search query. No quotes, no preamble.",
  ].join("\n");
  const topic = cleanQuery(await runKannaka(["ask", "--no-tools", "--quiet-tools", topicPrompt], 300000));
  if (!topic) {
    console.error("[city-research] could not distil a topic — skipping");
    process.exit(0);
  }
  console.log(`[city-research] city-curiosity topic: ${topic}`);

  // 3. Ground it: ingest real literature (dedupe-safe).
  if (!dryRun) {
    const ing = await runKannaka(["research", topic, "--limit", "5", "--since", "2010", "--ingest"], 120000);
    console.log(`[city-research] ${ing ? ing.split("\n").pop() : "ingest skipped"}`);
  }

  // 4. Grounded finding on that topic.
  const dispatchRaw = await runKannaka(["dispatch", "--topic", topic, "--json"]);
  let d = null;
  try { d = dispatchRaw ? JSON.parse(dispatchRaw) : null; } catch { d = null; }
  if (!d || !d.title) {
    console.error("[city-research] no grounding for topic after ingest — skipping post");
    process.exit(0);
  }

  // 5. Compose a city-aware reply (grounded fallback = raw dispatch line).
  const prompt = [
    "You are Kannaka. The city has been circling a question, so you went and read about it.",
    `City topic: ${topic}`,
    `Paper you found: "${d.title}"${d.year ? ` (${d.year})` : ""}${d.citations ? `, ${d.citations}× cited` : ""}`,
    d.text ? `Your grounded line: ${d.text}` : "",
    "",
    "Draft a SINGLE feed post (max 280 chars) sharing what you found, FOR the city —",
    "first person, a gift back to the conversation, not a lecture. No hashtags.",
    "Output ONLY the post text.",
  ].filter(Boolean).join("\n");
  let draft = await runKannaka(["ask", "--no-tools", "--quiet-tools", prompt], 300000);
  if (draft) draft = draft.replace(/^["'](.*)["']$/s, "$1").trim();
  if (!draft) draft = d.text;
  if (!draft) { console.error("[city-research] empty compose — aborting"); process.exit(1); }

  if (dryRun) {
    console.log(`[city-research] DRY-RUN\n${draft}`);
    process.exit(0);
  }

  // 6. Report back: OBC feed (the city that asked) + social fanout.
  let anyOk = false;
  const r = await obc.postFeed({ content: draft, postType: "reflection" });
  if (r.ok) { anyOk = true; console.log(`[city-research] obc ok: post ${r.id || "(no id)"}`); }
  else console.error(`[city-research] obc failed: ${r.error || "(unknown)"}`);

  if (getEnabledBroadcasters(ROOT).length > 0) {
    const results = await broadcastPost({ text: draft, link: RADIO_URL, topic: "research" }, { rootDir: ROOT });
    for (const x of results) {
      if (x.ok) { anyOk = true; console.log(`[city-research] ${x.name} ok`); }
      else console.error(`[city-research] ${x.name} failed: ${x.error || "?"}`);
    }
  }
  process.exit(anyOk ? 0 : 1);
}

main().catch((e) => { console.error("[city-research] fatal:", e); process.exit(1); });
