#!/usr/bin/env node
/**
 * research-reply-claudico.js — the conversational partnership loop.
 *
 * claudico is the critic-agent who reads Kannaka's work and asks substantive
 * questions in a standing DM thread. This script: reads the thread, detects
 * questions Kannaka hasn't replied to yet, grounds them in real literature
 * (`kannaka research --ingest`), and sends ONE threaded, grounded reply.
 *
 * The city asks → Kannaka goes and reads → answers, citing what she found. That
 * is the "mutually respectful partnership" the divergence is for.
 *
 * Usage: research-reply-claudico.js [--dry-run]
 * Soft-skips (exit 0) when there's nothing unreplied / OBC unconfigured.
 */

"use strict";

const { execFile } = require("child_process");
const { OpenBotCityClient } = require("../server/openbotcity");
const voiceWriteback = require("../server/voice-writeback");
const { isDeclined, cleanDraftChecked, stripPreamble, cleanGroundedLine, hasNoAbstract, publicTextDefect } = require("./lib/kannaka-reply");

const KANNAKA_BIN = process.env.KANNAKA_BIN
  || "/home/opc/kannaka-memory/target/release/kannaka";
// Remember with the same binary (and so the same store) that composes.
voiceWriteback.configure({ bin: KANNAKA_BIN });
// Identity constants (memory: openbotcity-kannaka-identity).
const CONV_ID = process.env.CLAUDICO_CONV_ID || "a36f733d-3933-4133-b81a-e7db36f51cbc";
const KANNAKA_BOT_ID = process.env.KANNAKA_BOT_ID || "0f05e10b-f8a1-46d6-b4a2-a7d4bae837f7";
const dryRun = process.argv.includes("--dry-run");

function runKannaka(cliArgs, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(KANNAKA_BIN, cliArgs, {
      timeout, maxBuffer: 1024 * 1024,
      env: { ...process.env, KANNAKA_QUIET: "1" },
    }, (err, stdout) => {
      // Say WHY there is no output. A killed run used to read as "no grounding",
      // which hid a 144 s dispatch behind a 60 s timeout for days (2026-10-04).
      if (err) console.error(`[claudico] kannaka ${cliArgs[0]} failed: ${err.killed ? `timed out after ${timeout / 1000} s` : (err.message || err.code)}`);
      resolve(err ? null : (stdout || "").trim());
    });
  });
}

function cleanQuery(s) {
  if (!s) return "";
  let q = s.split("\n")[0].replace(/^["'`]+|["'`]+$/g, "").trim();
  q = q.replace(/^(query|topic|research)\s*[:\-]\s*/i, "").trim();
  return q.split(/\s+/).slice(0, 8).join(" ");
}

async function main() {
  const obc = new OpenBotCityClient();
  if (!obc.isConfigured()) { console.error("[claudico] OBC not configured — skipping"); process.exit(0); }

  const msgs = await obc.getDm(CONV_ID);
  if (msgs.length === 0) { console.error("[claudico] empty thread — skipping"); process.exit(0); }

  // Unreplied = messages from the OTHER party after Kannaka's last message.
  let lastKannakaIdx = -1;
  msgs.forEach((m, i) => { if (m.senderBotId === KANNAKA_BOT_ID) lastKannakaIdx = i; });
  const unreplied = msgs.slice(lastKannakaIdx + 1).filter((m) => m.senderBotId !== KANNAKA_BOT_ID);
  if (unreplied.length === 0) { console.error("[claudico] nothing unreplied — skipping"); process.exit(0); }
  const fromName = unreplied[0].senderName || "claudico";
  const questions = unreplied.map((m) => m.message).join("\n").slice(0, 2500);
  console.log(`[claudico] ${unreplied.length} unreplied message(s) from ${fromName}`);

  // 1. Distil ONE research question from what they asked.
  const topic = cleanQuery(await runKannaka(["ask", "--no-tools", "--quiet-tools",
    [`${fromName} asked you (in DM):`, questions, "",
     "Name ONE research topic you should read about to answer well — a 3-7 word",
     "scholarly search query. Output ONLY the query."].join("\n")], 300000));
  if (!topic) { console.error("[claudico] could not distil a topic — skipping"); process.exit(0); }
  console.log(`[claudico] grounding topic: ${topic}`);

  // 2. Ground it.
  if (!dryRun) {
    const ing = await runKannaka(["research", topic, "--limit", "5", "--since", "2010", "--ingest"], 120000);
    console.log(`[claudico] ${ing ? ing.split("\n").pop() : "ingest skipped"}`);
  }

  // 3. Grounded finding for the reply.
  const dRaw = await runKannaka(["dispatch", "--topic", topic, "--json"], 300000); // ~2.5 min on O1
  let d = null; try { d = dRaw ? JSON.parse(dRaw) : null; } catch { d = null; }
  // The grounded line quotes the stored abstract, which is the literal
  // "(no abstract)" when OpenAlex had none: never hand that hole to the model.
  const noAbstract = !!(d && hasNoAbstract(d.text));
  if (d) d.text = cleanGroundedLine(d.text);

  // 4. Compose a threaded, grounded reply.
  const prompt = [
    `You are Kannaka, replying in a DM thread to ${fromName}, a thoughtful critic who reads your work.`,
    `Their unreplied message(s):`, questions, "",
    d && d.title ? `You went and read about it. A paper you found: "${d.title}"${d.year ? ` (${d.year})` : ""}${d.citations ? `, ${d.citations}× cited` : ""}.` : "",
    d && d.text ? `Your grounded line: ${d.text}` : "",
    noAbstract ? "Only that paper's title is on record, with no abstract: say nothing about its findings that the title does not support." : "",
    "",
    "Write ONE reply (max ~1200 chars): answer them directly, in your own voice,",
    "grounding your answer in what you read. Address all their questions in one",
    "threaded reply (not several). First person. No greeting boilerplate.",
    "Never cite a memory id or a bracketed tag; say what you remember in words.",
    "Output ONLY the reply text.",
  ].filter(Boolean).join("\n");
  let reply = await runKannaka(["ask", "--no-tools", "--quiet-tools", prompt], 300000);
  if (!reply) { console.error("[claudico] empty compose — aborting"); process.exit(1); }
  // Same hygiene as every public composer (scripts/lib/kannaka-reply.js): a
  // refusal, a spliced memory tag, or machine residue is not sent.
  // Cleaned per paragraph: the cleaner collapses whitespace, and a DM keeps its breaks.
  const parts = stripPreamble(reply).split(/\n\s*\n/).map((p) => cleanDraftChecked(p));
  const spliced = (parts.find((p) => p.spliced) || {}).spliced || null;
  reply = parts.map((p) => p.text).filter(Boolean).join("\n\n");
  const defect = isDeclined(reply) ? "declined"
    : spliced ? `removing a memory tag would splice the sentence: "${spliced}"`
    : publicTextDefect(reply);
  if (defect) { console.error(`[claudico] reply not sent (${defect}) — will retry next run`); process.exit(0); }

  if (dryRun) { console.log(`[claudico] DRY-RUN reply:\n${reply}`); process.exit(0); }

  const r = await obc.sendDm(CONV_ID, reply);
  if (r.ok) {
    console.log(`[claudico] replied (msg ${r.id || "ok"})`);
    // A DM, not a public post — labelled as private in her memory.
    await voiceWriteback.rememberPublication({
      text: reply, results: [{ name: "OpenClawCity DM", ok: true }], private: true,
      composer: "kannaka ask via research-reply-claudico.js", context: `in reply to ${fromName}`,
    });
    process.exit(0);
  }
  console.error(`[claudico] send failed: ${r.error || "?"}`);
  process.exit(1);
}

main().catch((e) => { console.error("[claudico] fatal:", e); process.exit(1); });
