/**
 * publication-ledger.js — an append-only record of every model-composed
 * publication: what the model was shown, what it wrote, what the guards said,
 * and whether it went out.
 *
 * voice-writeback.js remembers what Kannaka SAID in her own store; it keeps
 * no prompt, no source and no verdict, so nothing could say afterwards how
 * often a model put an invented memory in her mouth, or whether a gate
 * stopped it. This ledger is that evidence. scripts/confab-rate.js re-grades
 * it nightly under rule MR (rules v2) and writes rates with intervals.
 *
 * One JSON object per line in <radio data dir>/publication-ledger.jsonl
 * (KANNAKA_PUBLICATION_LEDGER overrides), created mode 0600:
 *
 *   v               1
 *   id              random row id
 *   ts              ISO time the row was written
 *   surface         gate surface: oration | oration-teaser | showcase |
 *                   narration | reply | research | dream | other
 *   surfaces        where it went (or would have gone), e.g. ["bluesky"]
 *   composer        who wrote it ("kannaka ask via …", "hosted model via …")
 *   model           the model id when known (else the configured one, marked)
 *   prompt, system  what the model was given (secrets redacted, capped)
 *   recall_rows     memory rows SHOWN to the model (support under rule MR)
 *   source_text     material the output was drafted from / given (support)
 *   context_text    shown but NOT support (the post being replied to: another
 *                   person's "I" is never Kannaka's)
 *   output          the text (redacted like the rest; the hash is of the
 *                   real text)
 *   output_sha256   sha256 of the output as published/drafted
 *   verdicts        { claims_guard: {ok, reasons}, mr_v2: {verdict, detail,
 *                   rules_sha256} }
 *   decision        published | blocked | regenerate | skipped | declined |
 *                   failed (every surface failed)
 *   published       true only when at least one surface took it
 *   reason          why it was not published, when it was not
 *   results         [{ name, ok, url? }]
 *   attempt         1-based draft attempt within one publication
 *   capture         "full" (call site gave prompt/support) | "output-only"
 *                   (voice-writeback's catch-all: no prompt, no support)
 *   truncated       field names that were cut to their cap
 *
 * Contract: append() never throws and never delays a post (synchronous
 * append of one line, a few KB). A failure is logged and returned, never
 * raised. The file is rotated to .1 … .N once it passes the size cap
 * (KANNAKA_PUBLICATION_LEDGER_MAX_BYTES, default 16 MiB; keep
 * KANNAKA_PUBLICATION_LEDGER_KEEP, default 6 rotated files).
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_KEEP = 6;
const FIELD_CAP = 16000;     // prompt / system / source / context / output
const ROW_CAP = 2000;        // one recall row
const MAX_ROWS = 50;
const ROTATE_LOCK_STALE_MS = 30000;

let _path = null; // test seam

// Same as voice-writeback's radioDataDir (not required from there: that
// module requires this one).
function radioDataDir() {
  return process.env.KANNAKA_RADIO_DATA_DIR || path.join(REPO_ROOT, "workspace");
}

// A test file (test/*.test.js) that exercises a gated path without pointing
// the ledger anywhere writes to a per-process temp file, never into the
// station's real ledger: `npm test` on the box that runs the radio would
// otherwise add fake publications to the evidence.
const RUNNING_A_TEST = !!(require.main && /[\\/]test[\\/][^\\/]+\.test\.js$/.test(require.main.filename || ""));
const TEST_PATH = path.join(os.tmpdir(), `pub-ledger-test-${process.pid}-${Date.now()}.jsonl`);

function ledgerPath() {
  if (_path) return _path;
  if (process.env.KANNAKA_PUBLICATION_LEDGER) return process.env.KANNAKA_PUBLICATION_LEDGER;
  return RUNNING_A_TEST ? TEST_PATH : path.join(radioDataDir(), "publication-ledger.jsonl");
}

function log(line) { console.log(`   [publication-ledger] ${line}`); }

// ── Secret redaction ─────────────────────────────────────────────────────
// Prompts are built from config, notes and other people's posts; none should
// hold a credential, but a ledger is the wrong place to find out one did.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bnsec1[02-9ac-hj-np-z]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, // Telegram bot token
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|private[_-]?key|jwt)\s*["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi,
];
const SECRET_ENV_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|JWT|NSEC|CREDENTIAL)/i;

function envSecrets() {
  const out = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_ENV_NAME.test(k) && typeof v === "string" && v.length >= 8) out.push(v);
  }
  return out.sort((a, b) => b.length - a.length);
}

function redact(text) {
  if (text == null) return text;
  let t = String(text);
  for (const v of envSecrets()) if (t.includes(v)) t = t.split(v).join("[REDACTED]");
  for (const re of SECRET_PATTERNS) {
    t = t.replace(re, (m, keep) => (typeof keep === "string" && m.startsWith(keep) ? `${keep}[REDACTED]` : "[REDACTED]"));
  }
  return t;
}

function cap(text, n, name, truncated) {
  if (text == null) return null;
  const s = redact(text);
  if (s.length <= n) return s;
  truncated.push(name);
  return `${s.slice(0, n)} […truncated ${s.length - n} chars]`;
}

function sha256(s) { return crypto.createHash("sha256").update(String(s == null ? "" : s), "utf8").digest("hex"); }

/** The row as it is written: capped, redacted, hashed. */
function buildRow(p = {}) {
  const truncated = [];
  const rows = Array.isArray(p.recall_rows || p.recallRows) ? (p.recall_rows || p.recallRows) : [];
  if (rows.length > MAX_ROWS) truncated.push("recall_rows");
  const results = Array.isArray(p.results) ? p.results.map((r) => ({
    name: r && r.name, ok: !!(r && r.ok), ...(r && r.url ? { url: String(r.url) } : {}),
  })) : [];
  const published = typeof p.published === "boolean" ? p.published : results.some((r) => r.ok && r.name !== "none");
  return {
    v: 1,
    id: p.id || crypto.randomBytes(8).toString("hex"),
    ts: p.ts || new Date().toISOString(),
    surface: p.surface || "other",
    surfaces: Array.isArray(p.surfaces) ? p.surfaces.map(String) : results.map((r) => r.name).filter(Boolean),
    composer: p.composer || null,
    model: p.model || null,
    prompt: cap(p.prompt, FIELD_CAP, "prompt", truncated),
    system: cap(p.system, FIELD_CAP, "system", truncated),
    recall_rows: rows.slice(0, MAX_ROWS).map((r) => cap(r && typeof r === "object" ? r.content : r, ROW_CAP, "recall_rows", truncated)),
    source_text: cap(p.source_text != null ? p.source_text : p.sourceText, FIELD_CAP, "source_text", truncated),
    context_text: cap(p.context_text != null ? p.context_text : p.contextText, FIELD_CAP, "context_text", truncated),
    output: cap(p.output, FIELD_CAP, "output", truncated),
    output_sha256: p.output == null ? null : sha256(p.output),
    verdicts: p.verdicts || {},
    decision: p.decision || (published ? "published" : "failed"),
    published,
    reason: p.reason || null,
    results,
    attempt: Number.isInteger(p.attempt) ? p.attempt : 1,
    capture: p.capture || "full",
    ...(truncated.length ? { truncated: [...new Set(truncated)] } : {}),
    host: os.hostname(),
    pid: process.pid,
  };
}

// ── Rotation ─────────────────────────────────────────────────────────────
function maxBytes() {
  const v = parseInt(process.env.KANNAKA_PUBLICATION_LEDGER_MAX_BYTES || "", 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_BYTES;
}
function keepCount() {
  const v = parseInt(process.env.KANNAKA_PUBLICATION_LEDGER_KEEP || "", 10);
  return Number.isFinite(v) && v >= 1 ? v : DEFAULT_KEEP;
}

// Rotate under an exclusive-create lock; a process that finds the lock held
// just appends (to the old file or the new: either way nothing is lost).
function rotateIfNeeded(file) {
  let st;
  try { st = fs.statSync(file); } catch (_) { return; }
  if (st.size < maxBytes()) return;
  const lock = `${file}.rotate.lock`;
  let fd;
  try { fd = fs.openSync(lock, "wx", 0o600); }
  catch (e) {
    try { if (Date.now() - fs.statSync(lock).mtimeMs > ROTATE_LOCK_STALE_MS) fs.unlinkSync(lock); } catch (_) {}
    return;
  }
  try {
    try { if (fs.statSync(file).size < maxBytes()) return; } catch (_) { return; }
    const keep = keepCount();
    try { fs.unlinkSync(`${file}.${keep}`); } catch (_) {}
    for (let i = keep - 1; i >= 1; i--) {
      try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch (_) {}
    }
    fs.renameSync(file, `${file}.1`);
    log(`rotated ${path.basename(file)} at ${st.size} bytes (keeping ${keep})`);
  } catch (e) {
    log(`rotation failed (${e && e.message}) — still appending`);
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(lock); } catch (_) {}
  }
}

/**
 * Append one row. Never throws.
 * @returns {{ ok: boolean, id?: string, error?: string, row?: object }}
 */
function append(p) {
  let row;
  try {
    row = buildRow(p);
    const file = ledgerPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfNeeded(file);
    const fd = fs.openSync(file, "a", 0o600);
    try { fs.writeSync(fd, JSON.stringify(row) + "\n"); }
    finally { fs.closeSync(fd); }
    try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort (Windows) */ }
    return { ok: true, id: row.id, row };
  } catch (e) {
    log(`row NOT written (${e && e.message}) — surface ${p && p.surface}, decision ${row && row.decision}`);
    return { ok: false, error: e && e.message, row };
  }
}

/** Every ledger file, oldest first (rotated .N … .1, then the live file). */
function ledgerFiles(file = ledgerPath()) {
  const out = [];
  for (let i = keepCount() + 4; i >= 1; i--) if (fs.existsSync(`${file}.${i}`)) out.push(`${file}.${i}`);
  if (fs.existsSync(file)) out.push(file);
  return out;
}

/** Rows with sinceMs <= ts < untilMs, from every file. Torn lines are skipped. */
function readRows({ sinceMs = 0, untilMs = Infinity, file } = {}) {
  const rows = [];
  for (const f of ledgerFiles(file || ledgerPath())) {
    let raw = "";
    try { raw = fs.readFileSync(f, "utf8"); } catch (_) { continue; }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch (_) { continue; }
      const t = Date.parse(r && r.ts);
      if (!Number.isFinite(t) || t < sinceMs || t >= untilMs) continue;
      rows.push(r);
    }
  }
  return rows;
}

function _setPath(p) { _path = p || null; }

module.exports = {
  append, buildRow, readRows, ledgerPath, ledgerFiles, redact, radioDataDir, sha256,
  FIELD_CAP, _setPath,
};
