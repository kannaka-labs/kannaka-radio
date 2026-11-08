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
 *   - identical text inside the dedupe window is stored once, across
 *     processes: the server and the cron scripts share an append-only ledger
 *     (<radio data dir>/voice-writeback-ledger.jsonl, see claimLedger);
 *   - KANNAKA_VOICE_WRITEBACK=0 turns it off; KANNAKA_READONLY=1 skips it,
 *     unless KANNAKA_VOICE_WRITEBACK=force, which writes anyway and strips
 *     KANNAKA_READONLY from the `kannaka remember` child's env only (the
 *     caller's own recalls stay read-only);
 *   - one log line per store AND per skip, naming the reason (a silent skip
 *     is the failure mode this estate keeps having).
 *
 * Short-lived scripts that process.exit() right after posting should
 * `await flush()` first so the child `kannaka remember` is not orphaned.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
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
// Template copy (now-playing, gallery captions: up to ~16 a day) is not her
// own words; it goes in light so it does not crowd the store whose size is
// already the recall-latency problem. Callers mark it with `template: true`.
const TEMPLATE_IMPORTANCE = 0.2;
// `kannaka remember` loads + saves the whole store and then opens a NATS
// connection, so it gets memory-bridge's REMEMBER_TIMEOUT budget.
const REMEMBER_TIMEOUT_MS = 60000;
// Long-form text is cut here. A 400–650-word oration runs ~2400–3900 chars,
// so it fits whole; argv carries this easily on Windows and Linux.
const MAX_TEXT_CHARS = 6000;
const MAX_LINKS = 6;
const DEFAULT_DEDUPE_MS = 6 * 60 * 60 * 1000;
// The cross-process ledger is rewritten (entries outside the window dropped)
// once it grows past this many lines.
const LEDGER_PRUNE_LINES = 2000;
// A lock file older than this belongs to a process that died holding it.
const LEDGER_LOCK_STALE_MS = 15000;
const LEDGER_LOCK_WAIT_MS = 2000;
// A claim that never became a stored record (the claimer was killed with its
// `kannaka remember` child, e.g. a restart) holds its words only this long:
// the remember timeout plus a margin. A claim from a process that is no
// longer alive on this host is released at once.
const LEDGER_LEASE_MS = REMEMBER_TIMEOUT_MS + 30000;
// `kannaka remember` rewrites the whole store; on O1 that competes with the
// audio for one CPU, so the child runs at low priority (like the reply-loop
// cron's `nice -n 15`).
const DEFAULT_NICE = 15;

// The radio's own data dir: state the server and its cron scripts share,
// never under ~/.kannaka (that is the memory store's, not ours).
function radioDataDir() {
  return process.env.KANNAKA_RADIO_DATA_DIR || path.join(REPO_ROOT, "workspace");
}

let _bin = null;
let _ledgerPath = null; // test seam; else env / radio data dir
let _execFile = childProcess.execFile;
const _recent = new Map(); // normalized text -> { t, stored }
const _pending = new Set();
// `kannaka remember` loads and saves the whole store and the CLI takes no
// write lock for it, so two at once can lose one. Our own stores run one at
// a time (memoryBridge / reabsorb still write on their own).
let _chain = Promise.resolve();

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

function pruneRecent() {
  const cutoff = Date.now() - dedupeWindowMs();
  for (const [k, e] of _recent) if (e.t < cutoff) _recent.delete(k);
}

function forced() { return String(process.env.KANNAKA_VOICE_WRITEBACK || "").toLowerCase() === "force"; }

/**
 * Why NOTHING would be written right now, from the environment alone (kill
 * switch, read-only store), or null. The on-air digest asks this before it
 * buffers a line, so a switched-off write-back does not fill its buffer.
 */
function disabledReason() {
  if (process.env.KANNAKA_VOICE_WRITEBACK === "0") return "disabled (KANNAKA_VOICE_WRITEBACK=0)";
  if (process.env.KANNAKA_READONLY === "1" && !forced()) {
    return "store is read-only (KANNAKA_READONLY=1) — KANNAKA_VOICE_WRITEBACK=force writes back anyway";
  }
  return null;
}

/** Why a publication would not be written, or null when it would. */
function skipReason({ text, results } = {}) {
  const off = disabledReason();
  if (off) return off;
  if (!normalize(text)) return "empty text";
  const ok = (results || []).filter((r) => r && r.ok && r.name !== "none");
  if (ok.length === 0) return "no surface succeeded";
  pruneRecent();
  const at = _recent.get(normalize(text));
  if (at && Date.now() - at.t < dedupeWindowMs()) {
    return at.stored ? "identical text already stored in this window"
      : "identical text already queued in this window (its store is still running)";
  }
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
 * @param {string}   [p.label]   — a complete provenance label that replaces the
 *   built one (the on-air digest's "[Provenance: said on air … said, not lived.]")
 */
function buildMemoryText({ text, surfaces, composer, at, urls, private: isPrivate, context, label: given }) {
  const where = (surfaces && surfaces.length) ? surfaces.join(", ") : "an unnamed surface";
  const said = isPrivate ? "said in a private message" : "said publicly";
  const ctx = context ? ` ${context};` : "";
  const label = (typeof given === "string" && given) ? given :
    `[Provenance: ${said} under my name on ${where} at ${at || new Date().toISOString()};` +
    `${ctx} composed by ${composer || "an unnamed composer"}; this is something I said, not something I lived.]`;
  let body = String(text || "").trim();
  if (body.length > MAX_TEXT_CHARS) body = body.slice(0, MAX_TEXT_CHARS).trimEnd() + " […truncated]";
  const links = (urls || []).filter((u) => typeof u === "string" && u).slice(0, MAX_LINKS);
  return `${label} ${body}${links.length ? `\nLinks: ${links.join(" ")}` : ""}`;
}

// ── Cross-process dedupe ledger ─────────────────────────────────────────
//
// The server and the cron scripts are separate processes, so an in-process
// map cannot stop both storing the same words (a research post the server
// also fans out, an oration re-aired after a restart). Each event is one
// JSON line in <radio data dir>/voice-writeback-ledger.jsonl, keyed by
// h = sha256(normalized text):
//   {"h", "t", "s": "p", "pid", "host"}  claimed: a store is about to run
//   {"h", "t", "s": "s"}                 stored: `kannaka remember` succeeded
//   {"h", "t", "r": 1}                   released: the store failed
// The ledger records COMPLETED stores, not just claims: only "stored" makes
// identical text a duplicate for the dedupe window. A claim blocks others
// only while its lease runs (LEDGER_LEASE_MS) and its process is alive, so a
// claimer killed mid-store (a restart takes its `kannaka remember` child
// with it) never makes words look stored that were not. Check-and-append
// runs under an exclusive-create lock file, so two processes cannot both see
// "not claimed" and both claim. The file is rewritten without expired
// entries once it passes LEDGER_PRUNE_LINES. Any ledger failure (unwritable
// dir, a lock that stays busy) falls back to in-process dedupe, logged:
// dedupe is never a reason to lose a memory.

function ledgerPath() {
  return _ledgerPath || process.env.KANNAKA_VOICE_WRITEBACK_LEDGER ||
    path.join(radioDataDir(), "voice-writeback-ledger.jsonl");
}

function hashOf(key) { return crypto.createHash("sha256").update(key).digest("hex"); }

const _sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) { Atomics.wait(_sleepCell, 0, 0, ms); }

// A stale lock (its holder died) is broken by RENAMING it to a unique name
// first, then checking what was moved: if another process broke it and took
// a fresh lock between our stat and our rename, we moved THEIR lock, so it
// is put back (link, which fails rather than clobber a third lock). The
// holder writes a token into its lock and, on release, unlinks the lock only
// while it still holds that token.
function breakStaleLock(lock) {
  let st;
  try { st = fs.statSync(lock); } catch (_) { return true; } // gone: try again
  if (Date.now() - st.mtimeMs <= LEDGER_LOCK_STALE_MS) return false;
  const grave = `${lock}.stale.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  try { fs.renameSync(lock, grave); } catch (_) { return true; }
  let fresh = false;
  try { fresh = Date.now() - fs.statSync(grave).mtimeMs <= LEDGER_LOCK_STALE_MS; } catch (_) {}
  if (fresh) { try { fs.linkSync(grave, lock); } catch (_) {} }
  try { fs.unlinkSync(grave); } catch (_) {}
  return true;
}

function withLedgerLock(file, fn) {
  const lock = `${file}.lock`;
  const token = `${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  const deadline = Date.now() + LEDGER_LOCK_WAIT_MS;
  let fd = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lock, "wx");
      try { fs.writeSync(fd, token); } catch (_) {}
    } catch (e) {
      if (e.code === "ENOENT") { fs.mkdirSync(path.dirname(lock), { recursive: true }); continue; }
      if (e.code !== "EEXIST" && e.code !== "EPERM") throw e;
      if (breakStaleLock(lock)) continue;
      if (Date.now() > deadline) throw new Error(`ledger lock ${lock} stayed busy for ${LEDGER_LOCK_WAIT_MS} ms`);
      sleepSync(5 + Math.floor(Math.random() * 10));
    }
  }
  try { return fn(); }
  finally {
    try { fs.closeSync(fd); } catch (_) {}
    try { if (fs.readFileSync(lock, "utf8") === token) fs.unlinkSync(lock); } catch (_) {}
  }
}

// Is `pid` alive on this host? Unknown (another host, no pid) counts as alive.
function processAlive(pid, host) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (host && host !== os.hostname()) return true;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

// Latest state per hash: { t, state: "pending" | "stored" | "released", pid, host }.
// A line with neither "s" nor "r" (that shape was never deployed) reads as stored.
function readLedger(file) {
  const out = new Map();
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
  let lines = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    lines++;
    try {
      const e = JSON.parse(line);
      if (!e || typeof e.h !== "string" || !Number.isFinite(e.t)) continue;
      const state = e.r ? "released" : e.s === "p" ? "pending" : "stored";
      out.set(e.h, { t: e.t, state, pid: e.pid, host: e.host });
    } catch (_) { /* a torn line from a crash: ignore it */ }
  }
  return { entries: out, lines };
}

// Does a ledger entry still stand in the way of storing the same words?
function blocking(e, now, windowMs) {
  if (!e) return null;
  if (e.state === "stored" && now - e.t < windowMs) {
    return { reason: "identical text already stored in this window (shared ledger)", alreadyStored: true };
  }
  if (e.state === "pending" && now - e.t < LEDGER_LEASE_MS && processAlive(e.pid, e.host)) {
    return { reason: `identical text is being stored by another process (pid ${e.pid}, shared ledger)`, alreadyStored: false };
  }
  return null;
}

/**
 * Claim `key` in the shared ledger right before storing it. Returns
 * { ok: true } when this process may store it; { ok: false, reason,
 * alreadyStored } when the same words were already stored inside the window
 * (alreadyStored: true) or a live process is storing them right now (false).
 */
function claimLedger(key, now = Date.now()) {
  const file = ledgerPath();
  const h = hashOf(key);
  const windowMs = dedupeWindowMs();
  try {
    return withLedgerLock(file, () => {
      const { entries, lines } = readLedger(file);
      const blocked = blocking(entries.get(h), now, windowMs);
      if (blocked) return { ok: false, ...blocked };
      if (lines >= LEDGER_PRUNE_LINES) {
        const keep = [...entries].filter(([, e]) => blocking(e, now, windowMs))
          .map(([hh, e]) => JSON.stringify(e.state === "pending"
            ? { h: hh, t: e.t, s: "p", pid: e.pid, host: e.host } : { h: hh, t: e.t, s: "s" }));
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, keep.length ? keep.join("\n") + "\n" : "");
        fs.renameSync(tmp, file);
      }
      fs.appendFileSync(file, JSON.stringify({ h, t: now, s: "p", pid: process.pid, host: os.hostname() }) + "\n");
      return { ok: true };
    });
  } catch (e) {
    log(`shared ledger unavailable (${e && e.message}) — deduping in this process only`);
    return { ok: true };
  }
}

function appendLedger(key, entry, what) {
  const file = ledgerPath();
  try {
    withLedgerLock(file, () => fs.appendFileSync(file, JSON.stringify({ h: hashOf(key), t: Date.now(), ...entry }) + "\n"));
  } catch (e) {
    log(`could not ${what} in the shared ledger (${e && e.message})`);
  }
}
// The store succeeded: identical text is a duplicate for the window.
function markStored(key) { appendLedger(key, { s: "s" }, "record the store"); }
// The store failed: another process may store the words at once.
function releaseLedger(key) { appendLedger(key, { r: 1 }, "release the claim (its lease still runs out)"); }

/**
 * Remember one publication. Never throws, never rejects.
 *
 * @param {object} p
 * @param {string}  p.text      — the words as published
 * @param {Array}   p.results   — per-surface results [{ name, ok, url? }]
 * @param {string}  p.composer
 * @param {boolean} [p.private]  — a DM: stored, but its text is kept off the
 *   swarm bus (the remember event carries ids only)
 * @param {boolean} [p.template] — template copy, stored at TEMPLATE_IMPORTANCE
 * @param {number}  [p.importance] — explicit importance (0..1); beats template
 * @param {string[]} [p.links]   — extra links the post carried (msg.link)
 * @param {string}  [p.context]
 * @param {string}  [p.label]    — a complete provenance label (see buildMemoryText)
 * @param {string}  [p.expires]  — RFC3339 time after which recall treats the
 *   memory as expired (`kannaka remember --expires`; the on-air digest)
 * @returns {Promise<{stored: boolean, reason?: string, memory?: string,
 *   alreadyStored?: boolean}>} alreadyStored: the same words are already in
 *   her store from inside the dedupe window (this process or another)
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
    return Promise.resolve({ stored: false, reason: why, alreadyStored: /already stored/.test(why) });
  }
  const ok = p.results.filter((r) => r && r.ok && r.name !== "none");
  const memory = buildMemoryText({
    text: p.text,
    surfaces: ok.map((r) => r.name),
    composer: p.composer,
    urls: [...new Set(ok.map((r) => r.url).concat(p.links || []).filter(Boolean))],
    private: !!p.private,
    context: p.context,
    label: p.label,
  });
  const key = normalize(p.text);
  // The in-process map answers first, at once, so two fanouts of the same
  // words racing each other do not both queue. The shared ledger is claimed
  // when the store actually starts (inside _chain), so a claim's lease is
  // spent on the store, never on waiting behind this process's queue.
  const mine = { t: Date.now(), stored: false };
  _recent.set(key, mine);
  const forget = () => { if (_recent.get(key) === mine) _recent.delete(key); };
  const bin = _bin || defaultBin();
  const explicit = Number(p.importance);
  const importance = (p.importance != null && Number.isFinite(explicit) && explicit >= 0 && explicit <= 1)
    ? explicit : (p.template ? TEMPLATE_IMPORTANCE : IMPORTANCE);
  const env = { ...process.env, KANNAKA_QUIET: "1" };
  // force: the caller runs read-only for its own recalls (post-research-
  // dispatch.js from cron); only this child may write.
  if (forced()) delete env.KANNAKA_READONLY;
  // A CLI remember publishes its full text on NATS by default
  // (kannaka-memory remember_events.rs, RememberLevel::default_for("cli")).
  // A private message stays private: ids only on the bus.
  if (p.private) env.KANNAKA_EVENTS_REMEMBER = "ids";
  const args = ["remember", memory, "--importance", importance.toFixed(2)];
  if (typeof p.expires === "string" && p.expires) args.push("--expires", p.expires);
  const run = () => new Promise((resolve) => {
    const claim = claimLedger(key);
    if (!claim.ok) {
      if (claim.alreadyStored) mine.stored = true; else forget();
      log(`not stored: ${preview} — ${claim.reason}`);
      resolve({ stored: false, reason: claim.reason, alreadyStored: !!claim.alreadyStored });
      return;
    }
    const release = () => { forget(); releaseLedger(key); };
    try {
      const child = _execFile(bin, args, { timeout: REMEMBER_TIMEOUT_MS, env },
        (err) => {
          if (err) {
            release();
            const reason = err.code === "ENOENT" ? `kannaka binary not found at ${bin}` : `kannaka remember failed: ${err.code || err.message}`;
            log(`not stored: ${preview} — ${reason}`);
            resolve({ stored: false, reason, memory });
            return;
          }
          mine.stored = true;
          markStored(key);
          log(`stored: ${preview} (${ok.map((r) => r.name).join(", ")}; composed by ${p.composer || "?"})`);
          resolve({ stored: true, memory });
        });
      lowerPriority(child);
    } catch (e) {
      release();
      log(`not stored: ${preview} — ${e && e.message}`);
      resolve({ stored: false, reason: e && e.message, memory });
    }
  });
  const result = _chain.then(run);
  _chain = result;
  return result;
}

// KANNAKA_VOICE_WRITEBACK_NICE: the child's priority (default 15; 0 leaves it).
function lowerPriority(child) {
  const v = parseInt(process.env.KANNAKA_VOICE_WRITEBACK_NICE || "", 10);
  const nice = Number.isFinite(v) ? Math.max(0, Math.min(19, v)) : DEFAULT_NICE;
  if (!nice || !child || !child.pid) return;
  try { os.setPriority(child.pid, nice); } catch (_) { /* best effort */ }
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

// Who composed a post, when the caller did not say: the script that is
// running. Server callers pass `composer` explicitly.
function inferComposer() {
  const main = process.argv[1] ? path.basename(process.argv[1]) : "";
  return main ? `unlabelled caller (${main})` : "unlabelled caller";
}

// ── Direct adapter posts (outside broadcastPost) ────────────────────────
//
// One-off scripts call an adapter's post() themselves: every YouTube upload
// (scripts/release-album-upload-youtube.js, podcast-upload-batch.js,
// podcast-finisher.js, workspace/podcasts/upload-*.js) and the odd
// single-network announce (post-gsp031-nostr.js). wrapDirectPost makes the
// adapter class itself write those back, so a new upload script is covered
// without anyone remembering to. broadcastPost marks its own calls with
// IN_FANOUT, because it remembers the whole fanout once.

const IN_FANOUT = Symbol.for("kannaka-radio.voice-writeback.in-fanout");
const YOUTUBE_DESCRIPTION_CHARS = 600;

/** What a YouTube upload said: its title, then the start of its description. */
function youtubeSummary(msg = {}) {
  const media = msg.media || {};
  const title = String(media.title || "").trim();
  const desc = String(msg.text || "").trim();
  const cut = desc.length > YOUTUBE_DESCRIPTION_CHARS
    ? desc.slice(0, YOUTUBE_DESCRIPTION_CHARS).trimEnd() + " …" : desc;
  return [title && `Video title: ${title}`, cut && `Description: ${cut}`].filter(Boolean).join("\n");
}

function wrapDirectPost(Cls) {
  const orig = Cls && Cls.prototype && Cls.prototype.post;
  if (typeof orig !== "function" || orig[IN_FANOUT]) return;
  const wrapped = async function post(msg = {}, ...rest) {
    const r = await orig.call(this, msg, ...rest);
    try {
      if (msg && !msg[IN_FANOUT] && msg.writeBack !== false && r && r.ok) {
        const surface = this.name || "an adapter";
        const isVideo = surface === "youtube";
        const privacy = isVideo && msg.media ? String(msg.media.privacy || "") : "";
        if (privacy === "private") {
          log(`not stored: ${JSON.stringify(String((msg.media && msg.media.title) || "").slice(0, 60))} — private upload, not said publicly`);
        } else {
          rememberPublication({
            text: isVideo ? youtubeSummary(msg) : msg.text,
            results: [{ name: surface, ok: true, url: r.url }],
            composer: msg.composer || inferComposer(),
            links: msg.link ? [msg.link] : [],
            template: !!msg.template,
            context: isVideo
              ? `as a${privacy === "unlisted" ? "n unlisted" : ""} video upload on my channel`
              : "posted directly, outside the fanout",
          });
        }
      }
    } catch (_) { /* never fail a post that already went out */ }
    return r;
  };
  wrapped[IN_FANOUT] = true;
  Cls.prototype.post = wrapped;
}

// Test seams.
function _setExecFile(fn) { _execFile = fn || childProcess.execFile; }
function _setLedgerPath(p) { _ledgerPath = p || null; }
function _recentSize() { return _recent.size; }
function _reset() {
  _recent.clear(); _pending.clear(); _bin = null; _execFile = childProcess.execFile; _chain = Promise.resolve();
  // Every reset gets a fresh, empty ledger: a test never shares dedupe state
  // with an earlier run, the live store's ledger, or the repo's workspace.
  _ledgerPath = path.join(os.tmpdir(), `vw-ledger-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

module.exports = {
  rememberPublication, buildMemoryText, skipReason, disabledReason, configure, flush,
  defaultBin, radioDataDir, ledgerPath, claimLedger, inferComposer,
  wrapDirectPost, youtubeSummary, IN_FANOUT,
  IMPORTANCE, TEMPLATE_IMPORTANCE, MAX_TEXT_CHARS, LEDGER_LEASE_MS,
  _setExecFile, _setLedgerPath, _reset, _recentSize,
};
