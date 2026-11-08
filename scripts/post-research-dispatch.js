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
const voiceWriteback = require("../server/voice-writeback");
const confabGate = require("../server/lib/confab-gate");
const { OpenBotCityClient } = require("../server/openbotcity");
const { isDeclined, stripPreamble, cleanGroundedLine, hasNoAbstract, publicTextDefect } = require("./lib/kannaka-reply");
require("./lib/run-log").stampConsole(); // date every line: one cron, one log file, many runs


const ROOT = path.resolve(__dirname, "..");
const COMPOSER = "kannaka ask via post-research-dispatch.js (grounded on kannaka dispatch)";
const KANNAKA_BIN = process.env.KANNAKA_BIN
  || "/home/opc/kannaka-memory/target/release/kannaka";
// Remember with the same binary (and so the same store) that composes.
// O1's cron runs this with KANNAKA_READONLY=1 so its recalls do not write,
// which also skips the write-back; KANNAKA_VOICE_WRITEBACK=force on that cron
// line stores the post anyway, lifting READONLY for the remember child only.
voiceWriteback.configure({ bin: KANNAKA_BIN });
const RADIO_URL = process.env.RADIO_PUBLIC_URL || "https://radio.ninja-portal.com";
// `kannaka dispatch` recalls over the whole medium; on O1 it takes ~2.5 min under load (144 s measured 2026-10-05).
const DISPATCH_TIMEOUT_MS = 300000;

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
    }, (err, stdout) => {
      // Say WHY there is no output. A killed run used to read as "no grounding",
      // which hid a 144 s dispatch behind a 60 s timeout for days (2026-10-04).
      if (err) console.error(`[research-dispatch] kannaka ${cliArgs[0]} failed: ${err.killed ? `timed out after ${timeout / 1000} s` : (err.message || err.code)}`);
      resolve(err ? null : (stdout || "").trim());
    });
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
  const raw = await runKannaka(dispatchArgs, DISPATCH_TIMEOUT_MS);
  if (raw === null) {
    // The dispatch itself failed (timeout or error, logged above). That is not
    // "no grounding", and a cron that reports it as a skip hides the fault.
    console.error("[research-dispatch] dispatch failed — nothing posted");
    process.exit(1);
  }
  let d = null;
  try { d = raw ? JSON.parse(raw) : null; } catch { d = null; }
  if (!d || !d.title) {
    console.error("[research-dispatch] no research grounding yet (run `kannaka research --ingest`) — skipping");
    process.exit(0);
  }

  // The grounded line quotes the stored abstract, which is the literal
  // "(no abstract)" when OpenAlex had none; that hole went out verbatim on
  // 2026-11-07 (Bluesky 3mzqbkthhzr22). Clean it before the model or a reader
  // sees it.
  const noAbstract = hasNoAbstract(d.text);
  d.text = cleanGroundedLine(d.text);

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
    noAbstract ? "Only the title is on record, with no abstract: say nothing about its findings that the title does not support." : "",
    "Output ONLY the post text — no quotes, no headings.",
  ].filter(Boolean).join("\n");

  let draft = await runKannaka(["ask", "--no-tools", "--quiet-tools", prompt], 600000);
  if (draft) draft = stripPreamble(draft);
  // A refusal ("I don't have that paper in my record...") is not a post; ten
  // of them went out as research dispatches before this check.
  if (draft && isDeclined(draft)) {
    console.error("[research-dispatch] compose declined — posting the grounded line instead");
    if (!dryRun) confabGate.recordDeclined({ surface: "research", composer: COMPOSER, model: confabGate.askModel(), prompt, text: draft, sourceText: d.text });
    draft = null;
  }
  if (draft && publicTextDefect(draft)) {
    console.error(`[research-dispatch] compose failed the public-text check (${publicTextDefect(draft)}) — posting the grounded line instead`);
    draft = null;
  }
  if (!draft) draft = d.text; // grounded fallback — always have something real to say
  if (!draft) {
    console.error("[research-dispatch] compose returned empty — aborting");
    process.exit(1);
  }
  // Last gate: nothing with machine residue reaches a reader, grounded or not.
  const defect = publicTextDefect(draft);
  if (defect) {
    console.error(`[research-dispatch] post fails the public-text check (${defect}) — nothing posted`);
    process.exit(0);
  }

  // The confabulation gate (server/lib/confab-gate.js): rule MR against what
  // the compose was given (the title and the grounded line). Research posts
  // may carry a JUDGE (logged); FABRICATED or a closed gate posts nothing.
  const fromModel = draft !== d.text;
  const gate = confabGate.check({
    surface: "research",
    composer: fromModel ? COMPOSER : "the grounded line from kannaka dispatch (post-research-dispatch.js fallback)",
    model: fromModel ? confabGate.askModel() : "none (template line from kannaka dispatch)",
    prompt: fromModel ? prompt : null, text: draft, sourceText: [`"${d.title}"`, d.text || ""].join("\n"),
  });
  if (!gate.allow) {
    if (!dryRun) gate.record({ decision: "blocked" });
    console.error(`[research-dispatch] confab gate: nothing posted (${gate.reason})`);
    process.exit(0);
  }

  // Link the paper itself, so every research post is citable (a Mastodon reader
  // asked "References?" and the post only linked the radio homepage).
  const link = d.openalex_id || RADIO_URL;

  if (dryRun) {
    const obc = new OpenBotCityClient();
    console.log(`[research-dispatch] DRY-RUN topic=${d.theme} (obc=${obc.isConfigured() ? "on" : "off"})\n${draft}\n(link: ${link}, topic: research)`);
    process.exit(0);
  }

  // 3. Fan out via the shared multi-platform broadcaster (Bluesky/Mastodon/…).
  const results = await broadcastPost({ text: draft, link, topic: "research", writeBack: false }, { rootDir: ROOT });
  let anyOk = false;
  for (const r of results) {
    if (r.ok) { anyOk = true; console.log(`[research-dispatch] ${r.name} ok: ${r.url || "(no url)"}`); }
    else console.error(`[research-dispatch] ${r.name} failed: ${r.error || "(unknown)"}`);
  }

  // 4. Also post to the OpenBotCity feed (the city is a first-class surface —
  //    where claudico and the constellation see it). Best-effort, independent.
  const obc = new OpenBotCityClient();
  const surfaces = results.slice();
  if (obc.isConfigured()) {
    const r = await obc.postFeed({ content: draft, postType: "reflection" });
    if (r.ok) { anyOk = true; console.log(`[research-dispatch] obc ok: post ${r.id || "(no id)"}`); }
    else console.error(`[research-dispatch] obc failed: ${r.error || "(unknown)"}`);
    surfaces.push({ name: "openclawcity feed", ok: !!r.ok });
  }

  gate.record({ results: surfaces });
  // One memory for the socials + the city feed: the same words, one publication.
  await voiceWriteback.rememberPublication({
    text: draft, results: surfaces, composer: COMPOSER, ledger: false,
  });
  process.exit(anyOk ? 0 : 1);
}

main().catch((e) => { console.error("[research-dispatch] fatal:", e); process.exit(1); });
