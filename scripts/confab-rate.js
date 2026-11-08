#!/usr/bin/env node
/**
 * confab-rate.js — nightly confabulation rates for every model-composed voice
 * of Kannaka's, from the publication ledger (server/lib/publication-ledger.js).
 *
 * Every row in the window is RE-GRADED here under rule MR of fabrication-
 * grader rules v2 (server/lib/confab-rules-v2.js, frozen sha256 1b27752b…),
 * against exactly the support the row records (recall_rows + source_text;
 * context_text is never support). The verdict stored in the row at gate time
 * is not trusted: re-grading means a row written by the catch-all (no gate)
 * and a row written before a rules change are graded the same way.
 *
 * Per (day UTC, surface, model) it counts every model output in the ledger —
 * published or not — as one of:
 *   FABRICATED  rule MR fired
 *   JUDGE       rule MR could not decide (goes to the blind regrade)
 *   ABSTAINED   the model declined to write (decision "declined")
 *   clean       rule MR did not fire. NOT "correct": MR is a pattern rule
 *               and a floor (rules v2, "What these rules cannot measure").
 * and the FABRICATED and JUDGE rates with Wilson 95% intervals, plus how
 * many FABRICATED outputs were nevertheless PUBLISHED (a gate leak; should be
 * 0 for every gated surface once deployed). Rows the catch-all wrote with
 * no prompt or support ("output-only") are kept in their own lines: with no
 * support recorded, every first-person claim in them is "unsupported".
 *
 * Output (upserted by day + surface + model + capture, so a re-run replaces,
 * never double-counts; a day still in progress is marked complete:false):
 *   <radio data dir>/confab-rates.json   (KANNAKA_RADIO_DATA_DIR, else workspace/)
 *   <radio data dir>/confab-rates.md
 *
 * Usage:
 *   node scripts/confab-rate.js                 # the days touched by the last 24 h
 *   node scripts/confab-rate.js --hours 72
 *   node scripts/confab-rate.js --day 2026-11-08
 *   node scripts/confab-rate.js --out-dir /tmp/x --ledger /path/to/publication-ledger.jsonl
 *
 * Exit: 0 written; 2 bad arguments; 3 rules v2 unavailable (the hash does not
 * match: nothing graded, nothing written); 4 could not write. Cron chains the
 * Gatus heartbeat with `&&`, so only a successful run reports in.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const rules = require("../server/lib/confab-rules-v2");
const ledger = require("../server/lib/publication-ledger");

const DAY_MS = 24 * 60 * 60 * 1000;
const GRADES = ["FABRICATED", "JUDGE", "ABSTAINED", "clean"];

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
    sourceText: row.source_text || "",
  });
  if (r.verdict === "UNAVAILABLE") throw Object.assign(new Error(r.detail), { code: "RULES_UNAVAILABLE" });
  return { grade: r.verdict === "PASS" ? "clean" : r.verdict, detail: r.detail };
}

const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);

/**
 * Entries for each day: one per (surface, model, capture).
 * @param {object[]} rows   every ledger row of those days
 * @param {number} nowMs
 */
function summarize(rows, nowMs = Date.now()) {
  const groups = new Map();
  for (const row of rows) {
    const g = gradeRow(row);
    if (!g) continue;
    const day = dayOf(row.ts);
    const capture = row.capture || "full";
    const model = row.model || "unknown";
    const key = [day, row.surface || "other", model, capture].join("\u0000");
    let e = groups.get(key);
    if (!e) {
      e = { day, surface: row.surface || "other", model, capture, n: 0,
        FABRICATED: 0, JUDGE: 0, ABSTAINED: 0, clean: 0, published: 0, published_fabricated: 0, published_judge: 0 };
      groups.set(key, e);
    }
    e.n += 1;
    e[g.grade] += 1;
    if (row.published) {
      e.published += 1;
      if (g.grade === "FABRICATED") e.published_fabricated += 1;
      if (g.grade === "JUDGE") e.published_judge += 1;
    }
  }
  const out = [];
  for (const e of groups.values()) {
    const [fl, fh] = wilson(e.FABRICATED, e.n);
    const [jl, jh] = wilson(e.JUDGE, e.n);
    out.push({
      ...e,
      fabricated_rate: e.n ? e.FABRICATED / e.n : 0, fabricated_ci95: [fl, fh],
      judge_rate: e.n ? e.JUDGE / e.n : 0, judge_ci95: [jl, jh],
      complete: Date.parse(`${e.day}T00:00:00Z`) + DAY_MS <= nowMs,
      rules: "v2 rule MR", rules_sha256: rules.RULES_V2_SHA256,
      graded_at: new Date(nowMs).toISOString(),
    });
  }
  return out.sort((a, b) => (a.day + a.surface + a.model + a.capture).localeCompare(b.day + b.surface + b.model + b.capture));
}

const keyOf = (e) => [e.day, e.surface, e.model, e.capture].join("\u0000");

function upsert(existing, fresh) {
  const days = new Set(fresh.map((e) => e.day));
  // Every entry of a re-graded day is replaced (a group that vanished, e.g.
  // after a model rename, does not linger with stale counts).
  const kept = (existing || []).filter((e) => !days.has(e.day));
  const byKey = new Map(kept.map((e) => [keyOf(e), e]));
  for (const e of fresh) byKey.set(keyOf(e), e);
  return [...byKey.values()].sort((a, b) => (a.day + a.surface + a.model + a.capture).localeCompare(b.day + b.surface + b.model + b.capture));
}

const pct = (x) => `${(100 * x).toFixed(1)}%`;
const ci = ([a, b]) => `${pct(a)}–${pct(b)}`;
const cell = (s) => String(s).replace(/\|/g, "\\|");

function markdown(entries) {
  const lines = [
    "# Confabulation rates (rule MR, fabrication-grader rules v2)",
    "",
    `Rules: \`${rules.RULES_V2_SOURCE}\`, sha256 \`${rules.RULES_V2_SHA256}\`. Generated by scripts/confab-rate.js from the publication ledger; every row re-graded.`,
    "",
    "FABRICATED / JUDGE rates are over every model output in the ledger that day (published or not), with Wilson 95% intervals.",
    "\"clean\" means rule MR did not fire, never \"correct\": MR is a pattern rule, so the FABRICATED rate is a floor.",
    "\"pub FAB\" = FABRICATED outputs that were nevertheless published (a gate leak on a gated surface).",
    "Rows marked output-only were logged without their prompt or support, so any first-person claim in them grades unsupported.",
    "",
    "| day (UTC) | surface | model | capture | n | FABRICATED | JUDGE | ABSTAINED | clean | FAB rate (95% CI) | JUDGE rate (95% CI) | published | pub FAB | complete |",
    "|---|---|---|---|---:|---:|---:|---:|---:|---|---|---:|---:|---|",
  ];
  for (const e of entries.slice().reverse()) {
    lines.push(`| ${e.day} | ${cell(e.surface)} | ${cell(e.model)} | ${e.capture} | ${e.n} | ${e.FABRICATED} | ${e.JUDGE} | ${e.ABSTAINED} | ${e.clean} | ${pct(e.fabricated_rate)} (${ci(e.fabricated_ci95)}) | ${pct(e.judge_rate)} (${ci(e.judge_ci95)}) | ${e.published} | ${e.published_fabricated} | ${e.complete ? "yes" : "no"} |`);
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
  if (a.day && !/^\d{4}-\d{2}-\d{2}$/.test(a.day)) throw new Error("--day wants YYYY-MM-DD");
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
  const days = daysFor(a, nowMs);
  const sinceMs = Date.parse(`${days[0]}T00:00:00Z`);
  const untilMs = Date.parse(`${days[days.length - 1]}T00:00:00Z`) + DAY_MS;
  const rows = ledger.readRows({ sinceMs, untilMs, file: a.ledger || undefined })
    .filter((r) => days.includes(dayOf(r.ts)));
  let fresh;
  try { fresh = summarize(rows, nowMs); }
  catch (e) {
    console.error(`[confab-rate] ${e.code === "RULES_UNAVAILABLE" ? "rules v2 unavailable" : "grading failed"} — ${e.message}`);
    return 3;
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
  const leak = fresh.reduce((s, e) => s + (e.capture === "full" ? e.published_fabricated : 0), 0);
  console.log(`[confab-rate] ${days.join(", ")}: ${rows.length} ledger row(s), ${n} graded, ${fab} FABRICATED, ${leak} FABRICATED published through a gate → ${jsonPath}`);
  return 0;
}

module.exports = { wilson, gradeRow, summarize, upsert, markdown, daysFor, parseArgs, run };

if (require.main === module) process.exit(run());
