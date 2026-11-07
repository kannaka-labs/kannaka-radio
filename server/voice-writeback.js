/**
 * voice-writeback.js — remember what Kannaka SAYS, in her own store.
 *
 * Everything this repo publishes under her name (social fanout, oration
 * teasers, dream posts, album announces, reply loops, the full oration on
 * air and in OpenClawCity) used to leave no trace in kannaka-prime. Her
 * store held tracks heard and room reactions, never her own words, so when
 * she was asked about the 2026-11-06 "red shoes" teaser posted as her, her
 * runtime truthfully said it had no memory of it.
 *
 * This module writes each publication ONCE (not once per platform) through
 * `kannaka remember`, labelled with where it went, who composed it, and that
 * it is something she said, not something she lived:
 *
 *   [Provenance: said publicly under my name on bluesky, mastodon at
 *   2026-11-06T18:02:11.000Z; composed by hosted model via peace-oration
 *   teaser; this is something I said, not something I lived.] <text>
 *   Links: https://...
 *
 * Contract with every caller:
 *   - fire-and-forget: rememberPublication() never throws and never rejects;
 *     a post has already gone out by the time it is called, and nothing here
 *     can fail or delay it;
 *   - only when at least one surface succeeded;
 *   - identical text inside the dedupe window is stored once;
 *   - KANNAKA_VOICE_WRITEBACK=0 turns it off; KANNAKA_READONLY=1 skips it;
 *   - one log line per store AND per skip, naming the reason (a silent skip
 *     is the failure mode this estate keeps having).
 *
 * Short-lived scripts that process.exit() right after posting should
 * `await flush()` first so the child `kannaka remember` is not orphaned.
 */

"use strict";

const path = require("path");
const childProcess = require("child_process");

// Same resolution server/index.js uses for KANNAKA_BIN: the env var, else the
// kannaka-memory checkout beside this repo.
const REPO_ROOT = path.resolve(__dirname, "..");
function defaultBin() {
  return process.env.KANNAKA_BIN ||
    path.join(REPO_ROOT, "..", "kannaka-memory", "target", "release",
      process.platform === "win32" ? "kannaka.exe" : "kannaka");
}

const IMPORTANCE = 0.5;
// `kannaka remember` loads + saves the whole store and then opens a NATS
// connection, so it gets memory-bridge's REMEMBER_TIMEOUT budget.
const REMEMBER_TIMEOUT_MS = 60000;
// Long-form text (a full oration) is cut here; a teaser never reaches it.
const MAX_TEXT_CHARS = 2400;
const MAX_LINKS = 6;
const DEFAULT_DEDUPE_MS = 6 * 60 * 60 * 1000;

let _bin = null;
let _execFile = childProcess.execFile;
const _recent = new Map(); // normalized text -> ms stored
const _pending = new Set();

function configure(opts = {}) {
  if (opts && typeof opts.bin === "string" && opts.bin) _bin = opts.bin;
}

function log(line) { console.log(`   [voice-writeback] ${line}`); }

function normalize(text) {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function dedupeWindowMs() {
  const v = parseInt(process.env.KANNAKA_VOICE_WRITEBACK_DEDUPE_MS || "", 10);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_DEDUPE_MS;
}

/** Why a publication would not be written, or null when it would. */
function skipReason({ text, results } = {}) {
  if (process.env.KANNAKA_VOICE_WRITEBACK === "0") return "disabled (KANNAKA_VOICE_WRITEBACK=0)";
  if (process.env.KANNAKA_READONLY === "1") return "store is read-only (KANNAKA_READONLY=1)";
  if (!normalize(text)) return "empty text";
  const ok = (results || []).filter((r) => r && r.ok && r.name !== "none");
  if (ok.length === 0) return "no surface succeeded";
  const at = _recent.get(normalize(text));
  if (at && Date.now() - at < dedupeWindowMs()) return "identical text already stored in this window";
  return null;
}

/**
 * The memory text: the provenance label, the words, the links.
 * @param {object} p
 * @param {string}   p.text
 * @param {string[]} p.surfaces  — where it went, e.g. ["bluesky", "mastodon"]
 * @param {string}   p.composer  — who wrote it, e.g. "kannaka ask via post-dream-bluesky.js"
 * @param {string}   [p.at]      — ISO time; now by default
 * @param {string[]} [p.urls]
 * @param {boolean}  [p.private] — a DM, not a public post
 * @param {string}   [p.context] — e.g. "in reply to @someone"
 */
function buildMemoryText({ text, surfaces, composer, at, urls, private: isPrivate, context }) {
  const where = (surfaces && surfaces.length) ? surfaces.join(", ") : "an unnamed surface";
  const said = isPrivate ? "said in a private message" : "said publicly";
  const ctx = context ? ` ${context};` : "";
  const label = `[Provenance: ${said} under my name on ${where} at ${at || new Date().toISOString()};` +
    `${ctx} composed by ${composer || "an unnamed composer"}; this is something I said, not something I lived.]`;
  let body = String(text || "").trim();
  if (body.length > MAX_TEXT_CHARS) body = body.slice(0, MAX_TEXT_CHARS).trimEnd() + " […truncated]";
  const links = (urls || []).filter((u) => typeof u === "string" && u).slice(0, MAX_LINKS);
  return `${label} ${body}${links.length ? `\nLinks: ${links.join(" ")}` : ""}`;
}

/**
 * Remember one publication. Never throws, never rejects.
 *
 * @param {object} p
 * @param {string}  p.text      — the words as published
 * @param {Array}   p.results   — per-surface results [{ name, ok, url? }]
 * @param {string}  p.composer
 * @param {boolean} [p.private]
 * @param {string}  [p.context]
 * @returns {Promise<{stored: boolean, reason?: string, memory?: string}>}
 */
function rememberPublication(p = {}) {
  let promise;
  try {
    promise = _remember(p);
  } catch (e) {
    log(`not stored — ${e && e.message}`);
    promise = Promise.resolve({ stored: false, reason: e && e.message });
  }
  _pending.add(promise);
  promise.then(() => _pending.delete(promise));
  return promise;
}

function _remember(p) {
  const preview = JSON.stringify(normalize(p.text).slice(0, 60));
  const why = skipReason(p);
  if (why) {
    log(`not stored: ${preview} — ${why}`);
    return Promise.resolve({ stored: false, reason: why });
  }
  const ok = p.results.filter((r) => r && r.ok && r.name !== "none");
  const memory = buildMemoryText({
    text: p.text,
    surfaces: ok.map((r) => r.name),
    composer: p.composer,
    urls: ok.map((r) => r.url),
    private: !!p.private,
    context: p.context,
  });
  const key = normalize(p.text);
  // Claimed before the store runs, so two fanouts of the same words racing
  // each other do not both write; released again if the store fails.
  _recent.set(key, Date.now());
  const bin = _bin || defaultBin();
  return new Promise((resolve) => {
    try {
      _execFile(bin, ["remember", memory, "--importance", IMPORTANCE.toFixed(2)],
        { timeout: REMEMBER_TIMEOUT_MS, env: { ...process.env, KANNAKA_QUIET: "1" } },
        (err) => {
          if (err) {
            _recent.delete(key);
            const reason = err.code === "ENOENT" ? `kannaka binary not found at ${bin}` : `kannaka remember failed: ${err.code || err.message}`;
            log(`not stored: ${preview} — ${reason}`);
            resolve({ stored: false, reason, memory });
            return;
          }
          log(`stored: ${preview} (${ok.map((r) => r.name).join(", ")}; composed by ${p.composer || "?"})`);
          resolve({ stored: true, memory });
        });
    } catch (e) {
      _recent.delete(key);
      log(`not stored: ${preview} — ${e && e.message}`);
      resolve({ stored: false, reason: e && e.message, memory });
    }
  });
}

/**
 * Wait for in-flight stores (bounded). For scripts that exit right after
 * posting. Resolves, never rejects.
 */
function flush(timeoutMs = REMEMBER_TIMEOUT_MS + 5000) {
  if (_pending.size === 0) return Promise.resolve();
  let timer;
  const timeout = new Promise((r) => { timer = setTimeout(() => {
    log(`flush gave up after ${timeoutMs} ms with ${_pending.size} store(s) still running`);
    r();
  }, timeoutMs); });
  return Promise.race([Promise.all([..._pending]), timeout]).then(() => clearTimeout(timer));
}

// Test seams.
function _setExecFile(fn) { _execFile = fn || childProcess.execFile; }
function _reset() { _recent.clear(); _pending.clear(); _bin = null; _execFile = childProcess.execFile; }

module.exports = {
  rememberPublication, buildMemoryText, skipReason, configure, flush,
  defaultBin, IMPORTANCE, MAX_TEXT_CHARS,
  _setExecFile, _reset,
};
