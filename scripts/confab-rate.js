#!/usr/bin/env node
/**
 * confab-rate.js — nightly confabulation rates for every model-composed voice
 * of Kannaka's, from the publication ledger (server/lib/publication-ledger.js).
 *
 * Every row in the window is RE-GRADED here under rule MR of fabrication-
 * grader rules v2 (server/lib/confab-rules-v2.js, frozen sha256 in
 * RULES_V2_SHA256), against exactly the support the row records
 * (recall_rows + source_text; context_text is never support). Re-grading
 * means a row written by the catch-all (no gate) and a row written before a
 * rules change are graded the same way. The verdict stored at gate time is
 * used for one thing only: whether a published draft was a gate LEAK (the
 * regrade sees redacted and capped fields, so it can differ; those rows are
 * counted as regrade_differs, never as leaks).
 *
 * Per (day UTC, surface, model, capture, attempt) it counts every model
 * output in the ledger — published or not — as one of:
 *   FABRICATED  rule MR fired
 *   JUDGE       rule MR could not decide (goes to the blind regrade)
 *   ABSTAINED   the model declined to write (decision "declined")
 *   clean       rule MR did not fire. NOT "correct": MR is a pattern rule
 *               and a floor (rules v2, "What these rules cannot measure").
 * The FABRICATED and JUDGE rates are over DRAFTS (n minus ABSTAINED), with
 * Wilson 95% intervals. attempt "1" rows are first drafts: their FABRICATED
 * rate is the model's own rate, the headline. attempt "2+" rows were written
 * after a rejection (with the rule's note in the prompt) and are not
 * comparable. Rows are drafts, not publications: one oration slot can add a
 * row per attempt.
 *
 * Kept out of the counts: rows with no model output, and template copy
 * (model "none …": the research dispatch posting its grounded line as is).
 *
 * Reply surfaces get no support by construction (`kannaka ask` does not
 * expose the memories it showed the model), so a reply's FABRICATED rate
 * measures "made any memory claim", not "made an unsupported one", and is not
 * comparable with orations or with rogue's rate. Rows the catch-all wrote
 * with no prompt or support ("output-only") are kept in their own lines for
 * the same reason.
 *
 * Output (upserted by day, so a re-run replaces, never double-counts; a day
 * still in progress is marked complete:false):
 *   <radio data dir>/confab-rates.json   (KANNAKA_RADIO_DATA_DIR, else workspace/)
 *   <radio data dir>/confab-rates.md
 *
 * Usage:
 *   node scripts/confab-rate.js                 # the days touched by the last 24 h
 *   node scripts/confab-rate.js --hours 72
 *   node scripts/confab-rate.js --day 2026-11-08
 *   node scripts/confab-rate.js --out-dir /tmp/x --ledger /path/to/publication-ledger.jsonl
 *
 * Exit: 0 written, no leak; 2 bad arguments; 3 rules v2 unavailable (the hash
 * does not match: nothing graded, nothing written); 4 could not write;
 * 5 written, but a draft the gate graded FABRICATED was published (a leak);
 * 6 grading failed for another reason (nothing written). Cron pings Gatus on
 * 0 and sends a failing ping on anything else (see the PR's cron line).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const rules = require("../server/lib/confab-rules-v2");
const ledger = require("../server/lib/publication-ledger");

const DAY_MS = 24 * 60 * 60 * 1000;
const GRADES = ["FABRICATED", "JUDGE", "ABSTAINED", "clean"];
const SUPPORT_FIELDS = ["output", "source_text", "recall_rows"];
const NO_SUPPORT_SURFACES = new Set(["reply"]);

function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** The grade of one ledger row under rule MR (rules v2), or null when it holds no model output. */
function gradeRow(row) {
  if (!row) return null;
  if (row.decision === "declined") return { grade: "ABSTAINED", detail: row.reason || "declined" };
  if (typeof row.output !== "string" || !row.output.trim()) return null;
  const r = rules.mrVerdict(row.output, {
    recallRows: Array.isArray(row.recall_rows) ? row.recall_rows : [],
    sourceText: typeof row.source_text === "string" ? row.source_text : "",
  });
  if (r.verdict === "UNAVAILABLE") throw Object.assign(new Error(r.detail), { code: "RULES_UNAVAILABLE" });
  return { grade: r.verdict === "PASS" ? "clean" : r.verdict, detail: r.detail };
}

/** YYYY-MM-DD (UTC) of a timestamp, or null when it is not a time. */
function dayOf(ts) {
  const t = typeof ts === "number" ? ts : Date.parse(ts);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

const isTemplate = (row) => /^none\b/i.test(String(row.model || ""));
const attemptOf = (row) => (Number.isInteger(row.attempt) && row.attempt > 1 ? "2+" : "1");
const gateVerdict = (row) => (row.verdicts && row.verdicts.mr_v2 && row.verdicts.mr_v2.verdict) || null;
const keyParts = (e) => [e.day, e.surface, e.model, e.capture, e.attempt];

/**
 * Entries for each day: one per (surface, model, capture, attempt).
 * @param {object[]} rows   every ledger row of those days
 * @param {number} nowMs
 */
function summarize(rows, nowMs = Date.now()) {
  const groups = new Map();
  for (const row of rows) {
    const day = row && dayOf(row.ts);
    if (!day || isTemplate(row)) continue;
    const g = gradeRow(row);
    if (!g) continue;
    const surface = row.surface || "other";
    const e0 = { day, surface, model: row.model || "unknown", capture: row.capture || "full", attempt: attemptOf(row) };
    const key = keyParts(e0).join("\u0000");
    let e = groups.get(key);
    if (!e) {
      e = { ...e0, n: 0, FABRICATED: 0, JUDGE: 0, ABSTAINED: 0, clean: 0,
        published: 0, published_fabricated: 0, published_judge: 0,
        regrade_differs: 0, truncated: 0, private: 0,
        support: NO_SUPPORT_SURFACES.has(surface) ? "none by construction" : "recorded" };
      groups.set(key, e);
    }
    e.n += 1;
    e[g.grade] += 1;
    if (row.private) e.private += 1;
    const cut = Array.isArray(row.truncated) && row.truncated.some((f) => SUPPORT_FIELDS.includes(f));
    if (cut) e.truncated += 1;
    const gv = gateVerdict(row);
    const regraded = g.grade === "clean" ? "PASS" : g.grade;
    if (gv && g.grade !== "ABSTAINED" && gv !== regraded) e.regrade_differs += 1;
    if (row.published) {
      e.published += 1;
      // A leak is judged by what the gate saw (its stored verdict); a row with
      // no gate verdict (output-only) falls back to the regrade.
      const v = gv || regraded;
      if (v === "FABRICATED") e.published_fabricated += 1;
      if (v === "JUDGE") e.published_judge += 1;
    }
  }
  const out = [];
  for (const e of groups.values()) {
    const drafts = e.n - e.ABSTAINED;
    out.push({
      ...e,
      drafts,
      fabricated_rate: drafts ? e.FABRICATED / drafts : 0, fabricated_ci95: wilson(e.FABRICATED, drafts),
      judge_rate: drafts ? e.JUDGE / drafts : 0, judge_ci95: wilson(e.JUDGE, drafts),
      complete: Date.parse(`${e.day}T00:00:00Z`) + DAY_MS <= nowMs,
      rules: "v2 rule MR", rules_sha256: rules.RULES_V2_SHA256,
      graded_at: new Date(nowMs).toISOString(),
    });
  }
  return out.sort((a, b) => keyParts(a).join("|").localeCompare(keyParts(b).join("|")));
}

const keyOf = (e) => keyParts(e).join("\u0000");

function upsert(existing, fresh) {
  const days = new Set(fresh.map((e) => e.day));
  // Every entry of a re-graded day is replaced (a group that vanished, e.g.
  // after a model rename, does not linger with stale counts).
  const kept = (existing || []).filter((e) => !days.has(e.day));
  const byKey = new Map(kept.map((e) => [keyOf(e), e]));
  for (const e of fresh) byKey.set(keyOf(e), e);
  return [...byKey.values()].sort((a, b) => keyParts(a).join("|").localeCompare(keyParts(b).join("|")));
}

const pct = (x) => `${(100 * x).toFixed(1)}%`;
const ci = ([a, b]) => `${pct(a)}–${pct(b)}`;
const cell = (s) => String(s == null ? "" : s).replace(/\|/g, "\\|");

function markdown(entries) {
  const lines = [
    "# Confabulation rates (rule MR, fabrication-grader rules v2)",
    "",
    `Rules: \`${rules.RULES_V2_SOURCE}\`, sha256 \`${rules.RULES_V2_SHA256}\`. Generated by scripts/confab-rate.js from the publication ledger; every row re-graded.`,
    "",
    "- **Headline: attempt 1.** FABRICATED / JUDGE rates are over drafts (declined drafts excluded), with Wilson 95% intervals. Attempt-1 rows are first drafts, the model's own rate; attempt-2+ rows were written after a rejection and are not comparable. Rows count drafts, not publications.",
    "- \"clean\" means rule MR did not fire, never \"correct\": MR is a pattern rule, so the FABRICATED rate is a floor, and JUDGE is undecided, not clean.",
    "- \"pub FAB\" = drafts the gate graded FABRICATED that were nevertheless published (a leak; should be 0). \"regrade ≠\" = rows where tonight's regrade disagrees with the gate's verdict (redacted or capped fields, \"cut\"), never counted as leaks.",
    "- **Reply rows (support: none by construction)**: `kannaka ask` does not expose the memories it showed the model, so a reply's FABRICATED rate means \"made any memory claim\", not \"made an unsupported one\". Not comparable with orations or with rogue's rate. Output-only rows (no prompt or support logged) are the same.",
    "- The rule's design examples (the orations aired 2026-11-05..08 and the review probes) were read while the rules were written: no rate covering them is evidence that the rule works (rules v2, \"Disclosure\").",
    "",
    "| day (UTC) | surface | model | capture | attempt | support | n | drafts | FABRICATED | JUDGE | ABSTAINED | clean | FAB rate (95% CI) | JUDGE rate (95% CI) | published | pub FAB | regrade ≠ | cut | complete |",
    "|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|---|---:|---:|---:|---:|---|",
  ];
  for (const e of entries.slice().reverse()) {
    const drafts = e.drafts != null ? e.drafts : e.n - (e.ABSTAINED || 0);
    lines.push(`| ${e.day} | ${cell(e.surface)} | ${cell(e.model)} | ${cell(e.capture)} | ${cell(e.attempt || "1")} | ${cell(e.support || "recorded")} | ${e.n} | ${drafts} | ${e.FABRICATED} | ${e.JUDGE} | ${e.ABSTAINED} | ${e.clean} | ${pct(e.fabricated_rate)} (${ci(e.fabricated_ci95)}) | ${pct(e.judge_rate)} (${ci(e.judge_ci95)}) | ${e.published} | ${e.published_fabricated} | ${e.regrade_differs || 0} | ${e.truncated || 0} | ${e.complete ? "yes" : "no"} |`);
  }
  return lines.join("\n") + "\n";
}

function parseArgs(argv) {
  const a = { hours: 24, day: null, outDir: null, ledger: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--hours") { a.hours = Number(v); i++; }
    else if (k === "--day") { a.day = v; i++; }
    else if (k === "--out-dir") { a.outDir = v; i++; }
    else if (k === "--ledger") { a.ledger = v; i++; }
    else throw new Error(`unknown argument ${k}`);
  }
  if (a.day && !(/^\d{4}-\d{2}-\d{2}$/.test(a.day) && dayOf(`${a.day}T00:00:00Z`) === a.day)) throw new Error("--day wants YYYY-MM-DD");
  if (!a.day && !(a.hours > 0)) throw new Error("--hours wants a positive number");
  return a;
}

/** The days to (re)compute: --day, else every UTC day the last N hours touch. */
function daysFor(a, nowMs) {
  if (a.day) return [a.day];
  const out = new Set();
  for (let t = nowMs - a.hours * 3600 * 1000; t < nowMs; t += 3600 * 1000) out.add(dayOf(t));
  out.add(dayOf(nowMs - 1));
  return [...out].sort();
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function run(argv = process.argv.slice(2), nowMs = Date.now()) {
  let a;
  try { a = parseArgs(argv); }
  catch (e) { console.error(`[confab-rate] ${e.message}`); return 2; }
  const st = rules.rulesStatus();
  if (!st.ok) {
    console.error(`[confab-rate] rules v2 unavailable — ${st.reason}; nothing graded, nothing written`);
    return 3;
  }
  let rows;
  let fresh;
  let days;
  try {
    days = daysFor(a, nowMs);
    const sinceMs = Date.parse(`${days[0]}T00:00:00Z`);
    const untilMs = Date.parse(`${days[days.length - 1]}T00:00:00Z`) + DAY_MS;
    rows = ledger.readRows({ sinceMs, untilMs, file: a.ledger || undefined })
      .filter((r) => days.includes(dayOf(r.ts)));
    fresh = summarize(rows, nowMs);
  } catch (e) {
    if (e.code === "RULES_UNAVAILABLE") {
      console.error(`[confab-rate] rules v2 unavailable — ${e.message}`);
      return 3;
    }
    console.error(`[confab-rate] grading failed — ${e.message}; nothing written`);
    return 6;
  }
  const outDir = a.outDir || ledger.radioDataDir();
  const jsonPath = path.join(outDir, "confab-rates.json");
  const mdPath = path.join(outDir, "confab-rates.md");
  try {
    fs.mkdirSync(outDir, { recursive: true });
    let existing = { entries: [] };
    try { existing = JSON.parse(fs.readFileSync(jsonPath, "utf8")); } catch (_) { /* first run */ }
    const entries = upsert(existing.entries, fresh);
    writeAtomic(jsonPath, JSON.stringify({
      rules: "fabrication-grader rules v2, rule MR", rules_sha256: rules.RULES_V2_SHA256,
      rules_source: rules.RULES_V2_SOURCE, updated_at: new Date(nowMs).toISOString(), entries,
    }, null, 2) + "\n");
    writeAtomic(mdPath, markdown(entries));
  } catch (e) {
    console.error(`[confab-rate] could not write ${jsonPath} / ${mdPath}: ${e.message}`);
    return 4;
  }
  const n = fresh.reduce((s, e) => s + e.n, 0);
  const fab = fresh.reduce((s, e) => s + e.FABRICATED, 0);
  const first = fresh.filter((e) => e.attempt === "1" && e.capture === "full" && e.support === "recorded");
  const firstDrafts = first.reduce((s, e) => s + e.drafts, 0);
  const firstFab = first.reduce((s, e) => s + e.FABRICATED, 0);
  const leak = fresh.reduce((s, e) => s + (e.capture === "full" ? e.published_fabricated : 0), 0);
  console.log(`[confab-rate] ${days.join(", ")}: ${rows.length} ledger row(s), ${n} graded, ${fab} FABRICATED ` +
    `(first drafts with recorded support: ${firstFab}/${firstDrafts}), ${leak} FABRICATED published through a gate → ${jsonPath}`);
  if (leak > 0) {
    console.error(`[confab-rate] GATE LEAK: ${leak} draft(s) the gate graded FABRICATED were published`);
    return 5;
  }
  return 0;
}

module.exports = { wilson, gradeRow, summarize, upsert, markdown, daysFor, parseArgs, dayOf, run };

if (require.main === module) process.exit(run());
