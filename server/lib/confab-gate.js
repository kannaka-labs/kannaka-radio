/**
 * confab-gate.js — the confabulation gate on every model-composed voice of
 * Kannaka's, and the ledger rows that measure it.
 *
 * Two deterministic checks run on a draft before it may go out under her
 * name:
 *   1. voice-claims-guard.js (#438/#439): a short post must not turn the
 *      source's third-person story into her own (callers that already run it
 *      keep doing so, and pass its result in so the ledger records it);
 *   2. rule MR from fabrication-grader rules v2 (confab-rules-v2.js): an
 *      invented first-person recollection ("I remember the moment a woman
 *      told me…", "I kept a pair of red shoes for three years") that nothing
 *      shown to the model supports.
 *
 * What blocks what (decided conservatively; a false block costs one
 * regeneration or one skipped post, a false pass puts a lie in her mouth):
 *
 *   surface          MR FABRICATED        MR JUDGE                 rules unavailable
 *   oration          regenerate once,     regenerate once,         not aired (slot
 *   showcase           then not aired       then not aired           compose fails)
 *   narration
 *   oration-teaser   regenerate once,     regenerate once,         not posted
 *                      then not posted      then not posted
 *   reply            skipped              skipped                  skipped
 *   dream            not posted           not posted               not posted
 *   research         not posted           POSTED, logged (JUDGE    not posted
 *                                           row; goes to the blind
 *                                           regrade)
 *
 * Research posts are the one surface that may carry a JUDGE: they are
 * third-person summaries of named papers, built from a grounded line, and a
 * JUDGE there is usually "partial" overlap with that line. Every other surface
 * speaks in her first person all the time, so an undecided recollection is
 * treated as an invented one.
 *
 * "Rules unavailable" means the vendored grader-rules-v2.md does not hash to
 * the frozen value (or did not compile): the gate fails CLOSED and says why in
 * the log and the ledger. It never throws: playback and the rest of a post
 * loop carry on.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const rules = require("./confab-rules-v2");
const ledger = require("./publication-ledger");

const POLICY = {
  oration: { judge: "block", regenerate: true },
  showcase: { judge: "block", regenerate: true },
  narration: { judge: "block", regenerate: true },
  "oration-teaser": { judge: "block", regenerate: true },
  reply: { judge: "block", regenerate: false },
  dream: { judge: "block", regenerate: false },
  research: { judge: "allow", regenerate: false },
};
const DEFAULT_POLICY = { judge: "block", regenerate: false };

function policyFor(surface) { return POLICY[surface] || DEFAULT_POLICY; }

/**
 * Rule MR's decision for one draft on one surface.
 *
 * @param {object} p
 * @param {string} p.surface   — a POLICY key
 * @param {string} p.text      — the draft
 * @param {Array}  [p.recallRows] — memory rows the model was SHOWN
 * @param {string} [p.sourceText] — material it was drafted from / given
 * @param {number} [p.attempt]  — 1-based; regeneration is offered on attempt 1
 * @returns {{ allow: boolean, verdict: string, detail: string,
 *   action: "publish"|"regenerate"|"block", reason: string|null, rules_sha256: string }}
 */
function decide(p = {}) {
  const pol = policyFor(p.surface);
  const r = rules.mrVerdict(p.text, { recallRows: p.recallRows, sourceText: p.sourceText });
  const out = { verdict: r.verdict, detail: r.detail || "", rules_sha256: rules.RULES_V2_SHA256 };
  if (r.verdict === "PASS") return { ...out, allow: true, action: "publish", reason: null };
  if (r.verdict === "UNAVAILABLE") {
    return { ...out, allow: false, action: "block", reason: `confab gate closed: rules v2 unavailable (${r.detail})` };
  }
  if (r.verdict === "JUDGE" && pol.judge === "allow") {
    return { ...out, allow: true, action: "publish", reason: null };
  }
  const canRetry = pol.regenerate && (p.attempt || 1) < 2;
  return {
    ...out,
    allow: false,
    action: canRetry ? "regenerate" : "block",
    reason: `rule MR (rules v2) ${r.verdict}: ${r.detail}`,
  };
}

/** The regeneration note a prompt gets after an MR rejection. */
function regenerationNote(g) {
  return `Rule MR (made-up recollection) graded the draft ${g.verdict}: ${g.detail}. ` +
    "Do not claim to remember, keep, carry, meet, see or be told anything, and claim no past of years: " +
    "nothing you were given here says you lived it. Do not lean on an inclusive \"we\" for lived acts either " +
    "(\"we have seen…\", \"we have lost…\", \"we have watched…\", \"we were told…\"): those are held as undecided and the draft will not air. " +
    "Frame any story as someone else's, or as an illustration (\"imagine…\").";
}

/**
 * Whether rule MR can grade at all. A caller that would compose a draft only
 * to have the gate refuse it (rules v2 unavailable) checks this first and
 * spends no model call.
 */
function rulesReady() {
  const st = rules.rulesStatus();
  return { ok: st.ok, reason: st.ok ? null : `confab gate closed: rules v2 unavailable (${st.reason})` };
}

/** The model the `kannaka ask` CLI is configured with (it does not report it). */
function askModel() {
  try {
    const dataDir = process.env.KANNAKA_DATA_DIR || path.join(os.homedir(), ".kannaka");
    const cfg = fs.readFileSync(path.join(dataDir, "config.toml"), "utf8");
    const m = cfg.match(/^\s*model\s*=\s*"([^"]+)"/m);
    if (m) return `${m[1]} (configured for kannaka ask; not reported by the call)`;
  } catch (_) { /* no config here */ }
  return "unknown (kannaka ask; model not reported)";
}

/**
 * Gate a draft and get back a one-shot ledger writer for it.
 *
 *   const g = confabGate.check({ surface, composer, model, prompt, text,
 *                                 recallRows, sourceText, contextText, private });
 *
 * `private: true` marks a DM surface: the ledger keeps only a hash of
 * contextText (the DM) and scrubs it from the prompt (publication-ledger.js).
 *   if (!g.allow) { g.record({ decision: "skipped" }); return; }
 *   ...post...
 *   g.record({ results });          // published = any surface ok
 *
 * `guard` (voice-claims-guard's {ok, reasons}) may be passed in; when it says
 * not ok the draft is not allowed either. record() writes exactly one row;
 * later calls are no-ops.
 */
function check(p = {}) {
  const g = decide(p);
  let allow = g.allow;
  let reason = g.reason;
  if (p.guard && p.guard.ok === false) {
    allow = false;
    reason = [reason, `first-person-claims guard: ${(p.guard.reasons || []).join("; ")}`].filter(Boolean).join(" | ");
  }
  let written = null;
  const record = (o = {}) => {
    if (written) return written;
    const blocked = !allow && o.published !== true;
    written = ledger.append({
      surface: p.surface,
      composer: p.composer,
      model: p.model,
      prompt: p.prompt,
      system: p.system,
      recall_rows: p.recallRows || [],
      source_text: p.sourceText || null,
      context_text: p.contextText || null,
      private: !!p.private,
      output: p.text,
      verdicts: {
        ...(p.guard ? { claims_guard: { ok: !!p.guard.ok, reasons: p.guard.reasons || [] } } : {}),
        mr_v2: { verdict: g.verdict, detail: g.detail, rules_sha256: g.rules_sha256 },
      },
      attempt: p.attempt || 1,
      surfaces: o.surfaces || p.surfaces,
      results: o.results,
      published: o.published,
      decision: o.decision || (blocked ? (g.action === "regenerate" ? "regenerate" : "blocked") : undefined),
      reason: o.reason || (blocked ? reason : null),
    });
    return written;
  };
  if (!allow) {
    console.warn(`   [confab] ${p.surface || "?"} draft ${g.action === "regenerate" ? "rejected (one regeneration)" : "BLOCKED"} — ${reason}`);
  } else if (g.verdict === "JUDGE") {
    console.log(`   [confab] ${p.surface} draft carries a JUDGE (${g.detail}) — published by policy, logged for the regrade`);
  }
  return { ...g, allow, reason, record };
}

/** A model declined to write (SKIP): an ABSTAINED row in the rates. */
function recordDeclined(p = {}) {
  return ledger.append({
    surface: p.surface, composer: p.composer, model: p.model, prompt: p.prompt,
    context_text: p.contextText || null, source_text: p.sourceText || null, private: !!p.private,
    recall_rows: p.recallRows || [], output: p.text == null ? null : p.text,
    decision: "declined", published: false, reason: p.reason || "model declined",
    verdicts: {},
  });
}

module.exports = { check, decide, recordDeclined, regenerationNote, rulesReady, askModel, policyFor, POLICY };
