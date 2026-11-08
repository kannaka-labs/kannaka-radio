/**
 * on-air-digest.js — remember what the station SAYS on air, without one
 * memory per DJ line.
 *
 * voice-writeback.js stores what goes out under Kannaka's name in writing.
 * The station also speaks: DJ intros, talk segments, swarm and dream-end
 * lines, album-showcase narration, the news and gossip desks, in-house
 * commercials, show intros. None of it reached her store, so she could not
 * recall what she had said on air any more than she could recall the
 * 2026-11-06 red-shoes teaser.
 *
 * One memory per line would be hundreds a day in a store whose size is
 * already the recall-latency problem. So:
 *   - short lines are buffered and written as ONE digest per hour:
 *       [Provenance: said on air on Kannaka Radio between <t1> and <t2>;
 *       composed by <composers>; said, not lived.]
 *       - [Kannaka (DJ)] <line>
 *       - [Gene (News Anchor)] <line>
 *     Exact repeats (station IDs, a line heard on /stream and the web
 *     player) are kept once; the digest is cut to voice-writeback's 6000-char
 *     cap with a count of what was left out;
 *   - long-form pieces (news and gossip segments, album-showcase intros,
 *     an episode whose script sits beside its audio) are one memory per
 *     airing, at the publication importance;
 *   - the buffer is a small JSONL file under the radio's data dir (never
 *     under ~/.kannaka), so lines survive a restart; it is only emptied once
 *     the digest is stored (or the shared ledger says it already was);
 *   - shutdown flushes best-effort; what does not make it is flushed on the
 *     next start.
 *
 * What counts as "said on air": a voice file that actually finished
 * streaming on /stream (icecast-source onVoiceAired), a show/commercial
 * track that aired (onTrackAired), and DJ lines sent only to the web player
 * (the WS broadcast hook in server/index.js). The text of a voice file is
 * looked up in a registry that voice-dj's TTS fills (registerSpeech), so a
 * file that was rendered but never aired is never remembered.
 *
 * Peace orations are NOT recorded here: peace-oration.js remembers each one
 * itself (voice-writeback), and executeOration is told so (airMemory:false).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const voiceWriteback = require("./voice-writeback");

const HOUR_MS = 60 * 60 * 1000;
const CHECK_MS = 5 * 60 * 1000;
// Station patter, mostly model-composed: lighter than her published words.
const DIGEST_IMPORTANCE = 0.3;
const REGISTRY_MAX = 300;

function log(line) { console.log(`   [on-air-digest] ${line}`); }
function normalize(text) { return String(text || "").replace(/\s+/g, " ").trim(); }
const keyOf = (text) => normalize(text).toLowerCase();

// ── persona → speaker label (server/voice-personas.json) ────────────────
let _personas = null;
function speakerFor(persona) {
  if (!persona) return "Kannaka (DJ)";
  if (!_personas) {
    try { _personas = require("./voice-personas.json"); } catch (_) { _personas = {}; }
  }
  const p = _personas[persona] || (_personas.personas && _personas.personas[persona]);
  return (p && p.label) || persona;
}

// ── audio path → spoken text, filled at TTS time ────────────────────────
const _registry = new Map();
function registerSpeech(audioPath, info) {
  if (!audioPath || !info || !normalize(info.text)) return;
  _registry.set(path.resolve(audioPath), { ...info });
  while (_registry.size > REGISTRY_MAX) _registry.delete(_registry.keys().next().value);
}
function lookupSpeech(audioPath) {
  if (!audioPath) return null;
  return _registry.get(path.resolve(audioPath)) || null;
}

class OnAirDigest {
  /**
   * @param {object} o
   * @param {string}   o.file           the buffer file (JSONL)
   * @param {number}   [o.flushEveryMs] digest period (default 1 h)
   * @param {number}   [o.checkEveryMs]
   * @param {object}   [o.writeback]    voice-writeback (test seam)
   * @param {function} [o.now]
   */
  constructor(o = {}) {
    this._file = o.file;
    this._flushEveryMs = o.flushEveryMs || HOUR_MS;
    this._checkEveryMs = o.checkEveryMs || CHECK_MS;
    this._wb = o.writeback || voiceWriteback;
    this._now = o.now || (() => Date.now());
    this._buf = [];
    this._keys = new Set();
    this._timer = null;
    this._flushing = null;
    this._load();
  }

  _load() {
    if (!this._file) return;
    let raw = "";
    try { raw = fs.readFileSync(this._file, "utf8"); } catch (_) { return; }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e && normalize(e.text) && !this._keys.has(keyOf(e.text))) {
          this._buf.push(e);
          this._keys.add(keyOf(e.text));
        }
      } catch (_) { /* a torn last line from a crash */ }
    }
    if (this._buf.length) log(`resumed ${this._buf.length} buffered line(s) from ${path.basename(this._file)}`);
  }

  _persist() {
    if (!this._file) return;
    try {
      fs.mkdirSync(path.dirname(this._file), { recursive: true });
      const tmp = `${this._file}.tmp`;
      fs.writeFileSync(tmp, this._buf.map((e) => JSON.stringify(e)).join("\n") + (this._buf.length ? "\n" : ""));
      fs.renameSync(tmp, this._file);
    } catch (e) {
      log(`could not write the buffer file (${e.message}); lines are held in memory only`);
    }
  }

  /** Lines buffered and not yet written to her store. */
  pending() { return this._buf.length; }

  /**
   * Something the station said on air.
   * @param {object} e
   * @param {string}  e.text
   * @param {string}  [e.speaker]  — "Kannaka (DJ)", "Gene (News Anchor)", …
   * @param {string}  [e.composer] — who wrote the words
   * @param {boolean} [e.whole]    — a long-form piece: its own memory
   * @param {string}  [e.title]    — what the piece was, for a whole memory
   * @returns {string} what happened: "buffered" | "repeat" | "whole" | "empty"
   */
  record(e = {}) {
    try {
      const text = normalize(e.text);
      if (!text) return "empty";
      const at = new Date(e.at || this._now()).toISOString();
      const speaker = e.speaker || "Kannaka (DJ)";
      const composer = e.composer || "the station's voice pipeline";
      if (e.whole) {
        const voice = /^Kannaka\b/.test(speaker) ? "" : ` in the voice of ${speaker}`;
        this._wb.rememberPublication({
          text,
          results: [{ name: "Kannaka Radio (on air)", ok: true }],
          composer,
          importance: this._wb.IMPORTANCE,
          label: `[Provenance: said on air on Kannaka Radio at ${at}${e.title ? ` (${e.title})` : ""}${voice}; ` +
            `composed by ${composer}; said, not lived.]`,
        });
        return "whole";
      }
      const k = keyOf(text);
      if (this._keys.has(k)) return "repeat";
      const entry = { t: Date.parse(at), text, speaker, composer };
      this._buf.push(entry);
      this._keys.add(k);
      if (this._file) {
        try {
          fs.mkdirSync(path.dirname(this._file), { recursive: true });
          fs.appendFileSync(this._file, JSON.stringify(entry) + "\n");
        } catch (err) {
          log(`could not append to the buffer file (${err.message}); line held in memory only`);
        }
      }
      return "buffered";
    } catch (err) {
      log(`record failed: ${err && err.message}`);
      return "empty";
    }
  }

  /** The digest for `entries`: { text, label }. */
  build(entries) {
    const max = (this._wb.MAX_TEXT_CHARS || 6000) - 120;
    const lines = [];
    let used = 0;
    let dropped = 0;
    for (const e of entries) {
      const line = `- [${e.speaker}] ${e.text}`;
      if (used + line.length + 1 > max) { dropped++; continue; }
      lines.push(line);
      used += line.length + 1;
    }
    if (dropped) lines.push(`[…${dropped} more line(s) said in this window, not kept here]`);
    const t1 = new Date(Math.min(...entries.map((e) => e.t))).toISOString();
    const t2 = new Date(Math.max(...entries.map((e) => e.t))).toISOString();
    const composers = [...new Set(entries.map((e) => e.composer))].join(", ");
    return {
      composers,
      text: lines.join("\n"),
      label: `[Provenance: said on air on Kannaka Radio between ${t1} and ${t2}; composed by ${composers}; said, not lived.]`,
    };
  }

  /**
   * Write the buffered lines as ONE memory. Resolves { stored, reason };
   * never rejects. The buffer is emptied only when the digest was stored or
   * the shared ledger says identical text already was.
   */
  flush(reason = "hourly") {
    if (this._flushing) return this._flushing;
    if (this._buf.length === 0) return Promise.resolve({ stored: false, reason: "nothing buffered" });
    const taken = this._buf.slice();
    const digest = this.build(taken);
    log(`writing ${taken.length} line(s) as one digest (${reason})`);
    // Called now, not on a later tick, so voiceWriteback.flush() sees it in
    // flight (rememberPublication never throws).
    this._flushing = Promise.resolve(this._wb.rememberPublication({
      text: digest.text,
      results: [{ name: "Kannaka Radio (on air)", ok: true }],
      composer: digest.composers,
      importance: DIGEST_IMPORTANCE,
      label: digest.label,
    }))
      .then((r) => {
        const done = r && (r.stored || /identical text already stored/.test(r.reason || ""));
        if (done) {
          const gone = new Set(taken);
          this._buf = this._buf.filter((e) => !gone.has(e));
          this._keys = new Set(this._buf.map((e) => keyOf(e.text)));
          this._persist();
        } else {
          log(`digest not stored (${(r && r.reason) || "unknown"}); ${taken.length} line(s) stay buffered`);
        }
        return r || { stored: false };
      })
      .catch((e) => ({ stored: false, reason: e && e.message }))
      .finally(() => { this._flushing = null; });
    return this._flushing;
  }

  /** Flush when the oldest buffered line is a period old. */
  maybeFlush() {
    if (this._buf.length === 0) return null;
    const oldest = Math.min(...this._buf.map((e) => e.t));
    if (this._now() - oldest < this._flushEveryMs) return null;
    return this.flush("hourly");
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this.maybeFlush(), this._checkEveryMs);
    if (typeof this._timer.unref === "function") this._timer.unref();
    // Lines left over from before a restart that are already a period old.
    this.maybeFlush();
  }

  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }

  /** Best effort at shutdown, bounded: what does not finish stays on disk. */
  flushForShutdown(waitMs = 3000) {
    if (this._buf.length === 0) return Promise.resolve();
    let timer;
    return Promise.race([
      this.flush("shutdown"),
      new Promise((r) => { timer = setTimeout(r, waitMs); }),
    ]).then(() => clearTimeout(timer));
  }

  /**
   * A voice file finished streaming on /stream.
   * @param {{ path: string, meta?: object }} voice — meta.speech may carry
   *   { text?, speaker?, composer?, whole?, title?, skip? } over the registry.
   */
  aired(voice = {}) {
    const meta = voice.meta || {};
    const speech = meta.speech || {};
    if (speech.skip) return "skip";
    const reg = lookupSpeech(voice.path) || {};
    const text = speech.text || reg.text;
    if (!normalize(text)) return "empty";
    return this.record({
      text,
      speaker: speech.speaker || reg.speaker || speakerFor(reg.persona),
      composer: speech.composer || reg.composer,
      whole: !!speech.whole,
      title: speech.title || meta.label,
    });
  }

  /**
   * A track finished airing. Show episodes and commercials are the station
   * speaking; songs are not.
   * @param {object} track
   * @param {string} [musicDir]
   */
  trackAired(track, musicDir) {
    if (!track || !track.file) return "skip";
    try {
      // The featured-artist and artist-story slots air other artists' songs:
      // their intros are recorded as voice, the songs are not hers to claim.
      if (track.isPodcastScheduled && /^\[(?:FEATURED|STORY)\]/.test(String(track.title || ""))) return "skip";
      if (track.isPodcastScheduled) {
        const show = track.album || "a show";
        const title = track.title || path.basename(track.file);
        // A script beside the audio ("<stem>.script.txt") is remembered whole;
        // without one, the airing is a digest line.
        const abs = path.isAbsolute(track.file) ? track.file : path.join(musicDir || "", track.file);
        const scriptPath = abs.replace(/\.[^./\\]+$/, "") + ".script.txt";
        let script = "";
        try { script = fs.readFileSync(scriptPath, "utf8").trim(); } catch (_) {}
        if (script) {
          return this.record({
            text: script, whole: true, title: `${show}: ${title}`, speaker: "the show's cast",
            composer: `the episode script (${path.basename(scriptPath)})`,
          });
        }
        return this.record({
          text: `Aired the episode "${title}" (${show}); its script is not on disk here.`,
          speaker: "Kannaka Radio", composer: "the show schedule (podcast-scheduler)",
        });
      }
      if (track.commercial && track.sponsor) {
        return this.record({
          text: `Aired a sponsor spot: ${track.title || path.basename(track.file)}.`,
          speaker: "Kannaka (DJ)", composer: "advertiser copy (radio-ads)",
        });
      }
      if (track.commercial && track.theme) {
        return this.record({
          text: track.theme, speaker: "Kannaka (DJ)",
          composer: "in-house commercial script (server/commercials.js)",
        });
      }
    } catch (e) {
      log(`trackAired failed: ${e && e.message}`);
    }
    return "skip";
  }

  /**
   * A message the server sends to the web player. DJ lines that did not go
   * through /stream (inStream false) were heard only there; the ones that
   * did are recorded when they air.
   */
  fromBroadcast(msg) {
    if (!msg || typeof msg !== "object") return "skip";
    if (msg.type !== "dj_voice" && msg.type !== "dj_talk_segment") return "skip";
    if (msg.inStream) return "skip";
    return this.record({
      text: msg.text,
      speaker: "Kannaka (DJ)",
      composer: `voice-dj (${msg.source || msg.type})`,
    });
  }
}

// ── the server's instance, for modules that do not hold a reference ─────
let _default = null;
function setDefault(d) { _default = d || null; }
function getDefault() { return _default; }
/** record() on the server's digest; a no-op when none is running (scripts, tests). */
function say(entry) { return _default ? _default.record(entry) : "no-digest"; }

module.exports = {
  OnAirDigest, registerSpeech, lookupSpeech, speakerFor, setDefault, getDefault, say,
  DIGEST_IMPORTANCE,
  _clearRegistry: () => _registry.clear(),
};
