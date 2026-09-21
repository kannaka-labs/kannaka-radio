'use strict';

/**
 * consent-guard.js — the half of the GSP-040 fix that was missing.
 *
 * PR #325 added `scripts/consent-gate.py`, which reads a conversation and
 * refuses if a quoted guest has answered since we asked. Its own docstring
 * says how it is meant to be used: "run it as the LAST step before uploading,
 * and do not upload on a non-zero exit."
 *
 * Nothing ran it. Between the gate merging on 2026-09-20 and this file, the
 * only reference to it anywhere in the repo was a note in GSP-041's own audit
 * record. The episode that aired about unenforced rules graded its consent fix
 * PASS on the evidence that the PR had merged — and a merged script with no
 * caller is enforced by memory, which is the exact mechanism that failed in
 * GSP-040. Nobody re-read the thread; nobody would have run the gate either.
 *
 * This is the caller. `test/consent-gate-wiring.test.js` is what stops the
 * next upload script from forgetting it, on the same two-halves doctrine
 * `deploy-onair-guard.test.js` already states: the check must be right, AND
 * the thing that publishes must actually consult it.
 *
 * Usage, as the first line inside an upload script's main:
 *
 *     const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
 *     assertConsentClear(path.join(ROOT, "workspace/podcasts/042"));
 *
 * It throws on anything short of a clear pass, so an upload script that calls
 * it cannot proceed past a guest who answered.
 *
 * The declaration, at `<episodeDir>/consent.json`:
 *
 *     { "episode": "042",
 *       "threads": [
 *         { "conversation_id": "d3eb...", "who": "Noah", "why": "quoted in the cold open" }
 *       ] }
 *
 * An episode that quotes nobody says so explicitly:
 *
 *     { "episode": "042", "threads": [], "no_quoted_guests": "reads only from
 *       published artifacts; no permission was asked of anyone" }
 *
 * FAILS CLOSED, deliberately, in all three directions: a missing declaration,
 * an empty `threads` with no stated reason, and a gate that cannot reach the
 * API all block the upload. GSP-040 published on an assumption of silence.
 * The default here is that silence is never assumed, only measured.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const GATE = path.join(ROOT, 'scripts', 'consent-gate.py');

/** Raised for every refusal, so a caller can catch one class and stop. */
class ConsentBlocked extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConsentBlocked';
  }
}

/**
 * The python that can run the gate. Windows ships `python`, CI ships
 * `python3`; an operator with neither on PATH sets CONSENT_GATE_PYTHON.
 * Returning null is not "skip" — the caller turns it into a refusal.
 */
function findPython(runner) {
  const probe = runner || ((exe) => spawnSync(exe, ['--version'], { encoding: 'utf8' }));
  const candidates = [process.env.CONSENT_GATE_PYTHON, 'python3', 'python'].filter(Boolean);
  for (const exe of candidates) {
    const r = probe(exe);
    if (r && !r.error && r.status === 0) return exe;
  }
  return null;
}

/**
 * Read and validate an episode's consent declaration.
 *
 * Every refusal below is a sentence an operator can act on, because the one at
 * the other end of it is about to publish something and needs to know exactly
 * what is missing.
 */
function readDeclaration(episodeDir) {
  const p = path.join(episodeDir, 'consent.json');
  if (!fs.existsSync(p)) {
    throw new ConsentBlocked(
      `no consent declaration at ${p}\n` +
        `  Write it before uploading. List every DM thread this episode quotes or\n` +
        `  asked permission in:\n` +
        `      { "episode": "NNN", "threads": [ { "conversation_id": "...", "who": "..." } ] }\n` +
        `  If it quotes nobody, say so and why:\n` +
        `      { "episode": "NNN", "threads": [], "no_quoted_guests": "<reason>" }`,
    );
  }
  let decl;
  try {
    decl = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new ConsentBlocked(`consent declaration at ${p} is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(decl.threads)) {
    throw new ConsentBlocked(`consent declaration at ${p} has no "threads" array`);
  }
  for (const t of decl.threads) {
    if (!t || typeof t.conversation_id !== 'string' || !t.conversation_id.trim()) {
      throw new ConsentBlocked(`consent declaration at ${p} has a thread with no conversation_id`);
    }
  }
  // An empty list is a claim — "this episode quotes no one" — and a claim has
  // to be made out loud. Defaulting it to fine is how the gate would quietly
  // become a no-op for every episode that forgot to fill it in.
  if (decl.threads.length === 0 && !String(decl.no_quoted_guests || '').trim()) {
    throw new ConsentBlocked(
      `consent declaration at ${p} lists no threads and gives no reason.\n` +
        `  An episode that quotes nobody must say so: "no_quoted_guests": "<why>".`,
    );
  }
  return decl;
}

/**
 * Run `scripts/consent-gate.py` against one thread.
 *
 * The gate's contract, which this relies on and the wiring test pins:
 *   0  no reply since we asked
 *   2  a reply arrived — read it and honour it
 *   1  could not determine — treat as blocking
 */
function runGate(conversationId, opts) {
  const o = opts || {};
  const run = o.run || ((exe, args) => spawnSync(exe, args, { encoding: 'utf8' }));
  const exe = o.python || findPython(o.probe);
  if (!exe) {
    throw new ConsentBlocked(
      'no python on PATH to run scripts/consent-gate.py — set CONSENT_GATE_PYTHON.\n' +
        '  This blocks the upload rather than skipping the check.',
    );
  }
  const args = [GATE, conversationId];
  if (o.since) args.push('--since', o.since);
  const r = run(exe, args);
  return {
    status: r && typeof r.status === 'number' ? r.status : 1,
    stdout: (r && r.stdout) || '',
    stderr: (r && r.stderr) || '',
  };
}

/**
 * Block unless every thread this episode quotes is still silent.
 *
 * Returns the declaration on a clear pass; throws ConsentBlocked otherwise.
 * Nothing about this is advisory: an upload script calls it and the throw is
 * what stops the upload.
 */
function assertConsentClear(episodeDir, opts) {
  const o = opts || {};
  const log = o.log || console.log;
  const decl = readDeclaration(episodeDir);

  if (decl.threads.length === 0) {
    log(`[consent] ${path.basename(episodeDir)}: no quoted guests — ${decl.no_quoted_guests}`);
    return decl;
  }

  const blocked = [];
  for (const t of decl.threads) {
    const who = t.who || t.conversation_id;
    const r = runGate(t.conversation_id, o);
    if (r.stdout) log(r.stdout.trimEnd());
    if (r.status === 0) {
      log(`[consent] ${who}: clear`);
      continue;
    }
    // 2 is "they answered"; anything else is "we do not know", and the gate's
    // own docstring says an indeterminate result is blocking. Neither is a
    // reason to upload.
    const why =
      r.status === 2
        ? 'ANSWERED SINCE WE ASKED — read the reply and honour it'
        : `gate could not determine (exit ${r.status})`;
    blocked.push(`  ${who} [${t.conversation_id}]: ${why}${r.stderr ? `\n      ${r.stderr.trim()}` : ''}`);
  }

  if (blocked.length > 0) {
    throw new ConsentBlocked(
      `consent gate refused the upload for ${path.basename(episodeDir)}:\n${blocked.join('\n')}\n` +
        `  Fix the episode, or re-ask, before publishing. Do not bypass this by hand —\n` +
        `  GSP-040 was published by someone who meant well and did not re-read.`,
    );
  }
  log(`[consent] ${path.basename(episodeDir)}: all ${decl.threads.length} thread(s) clear`);
  return decl;
}

module.exports = { assertConsentClear, readDeclaration, runGate, findPython, ConsentBlocked, GATE };
