"use strict";
/**
 * sound-library.js — the Kannaka Sound Library on the air: a bed under the
 * voice, a sting at the seams, the store's door chime after its ad.
 *
 * The clips are our own: 24 cues rendered by Stable Audio Open 1.0 from
 * Kannaka's prompts (2026-10-14, Stability AI Community License, cleared to
 * air), normalized to -18 LUFS, living on the radio's music disk at
 * SOUND_DIR (default /var/oled/kannaka/sound/{beds,stings,sfx}). The repo
 * never carries audio.
 *
 * Everything here is behind flags that default OFF, so the stream is
 * byte-identical until Nick turns a flag on:
 *   SOUND_BEDS=1    a bed under orations, the gossip column, the artist story
 *                   and the overnight DJ (never under music, a guest, or the
 *                   Featured Artist slot)
 *   SOUND_STINGS=1  station ident at the top of the hour, show intro/outro
 *                   around the podcast and TSOF, a bumper before the
 *                   commercial block, the door chime after the record-store ad
 *   SOUND_SFX=1     reserved; nothing uses it yet
 *
 * Voice hook for later: the Kannaka Piper voice is a persona engine choice in
 * voice-personas.json (piper.model), not a sound cue; nothing here touches it.
 */
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const DEFAULT_DIR = "/var/oled/kannaka/sound";
const KIND_DIR = { bed: "beds", sting: "stings", sfx: "sfx" };

/** Which bed sits under which kind of voice item. null = none. */
const BEDS = Object.freeze({
  oration: "cathedral-oration",
  gossip: "newsroom-tension",
  news: "newsroom-tension",
  story: "warm-piano-hearth",
  tsofPromo: "suspense-drone",
  djNight: "late-night-radio",
  djDay: null,
});

const STINGS = Object.freeze({
  ident: "station-ident",
  showIntro: "show-intro",
  showOutro: "show-outro",
  bumper: "commercial-bumper",
  chime: "store-door-chime",
});

/** Shows that get the intro/outro stings. The Featured Artist (a guest's
 *  set) and the Artist Story (it rides behind the oration) do not. */
const STING_SHOWS = /story of flaukowski|podcast|ghost signals/i;

const MIX_DEFAULTS = Object.freeze({ gainDb: -22, fadeIn: 0.5, fadeOut: 1.5 });

function readFlags(env = process.env) {
  return {
    beds: env.SOUND_BEDS === "1",
    stings: env.SOUND_STINGS === "1",
    sfx: env.SOUND_SFX === "1",
  };
}

function chicagoHour(now = new Date()) {
  return new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" })).getHours();
}

function isNight(hour) { return hour >= 22 || hour < 6; }

/**
 * The bed for a voice item, from the metadata its injector attached. Pure.
 * `kind` is set by the long-form callers ('oration' | 'gossip' | 'news' |
 * 'dj' | 'sting'); older callers only carry a label, which is matched here.
 */
function bedFor(meta, hour) {
  const m = meta || {};
  const label = String(m.label || "");
  if (m.noBed) return null;
  if (m.kind === "sting" || m.kind === "sfx" || m.kind === "bed") return null;
  if (/featured artist/i.test(label)) return null; // a guest's slot, never
  if (m.kind === "gossip" || m.kind === "news") return BEDS[m.kind];
  if (m.kind === "oration" || /peace oration/i.test(label)) return BEDS.oration;
  if (/artist story/i.test(label)) return BEDS.story;
  if (m.kind === "tsofPromo") return BEDS.tsofPromo;
  // A show's spoken intro is framed by the sting, not a bed.
  if (/\bintro$/i.test(label) && !/^DJ intro/i.test(label)) return null;
  if (m.kind === "dj" || /^DJ intro/i.test(label) || /^showcase:/i.test(label)) {
    return isNight(hour) ? BEDS.djNight : BEDS.djDay;
  }
  return null;
}

/** The record-store ad, by the title commercials.js gives its track. */
function isStoreAd(track) {
  return !!(track && track.commercial && /ghost signals records|usdc atm/i.test(String(track.title || "")));
}

/**
 * Which stings a track change calls for. `actual` just started; `upcoming`
 * is the peeked next track. Both stings are queued on the voice queue, so
 * they air after `actual` drains: the chime right after the store ad, the
 * bumper right before the first commercial of a block. Pure.
 */
function stingsForTrackChange(actual, upcoming) {
  const out = [];
  if (!actual) return out;
  if (isStoreAd(actual)) out.push("chime");
  if (!actual.commercial && upcoming && upcoming.commercial) out.push("bumper");
  return out;
}

/** Top of the hour, once per hour, only in plain DJ programming. Pure. */
function identDue(state, hourKey, lastHourKey) {
  if (!state || state.channel !== "dj" || state.live || state.showPlaying) return false;
  if (state.minute !== 0) return false;
  return hourKey !== lastHourKey;
}

function showGetsStings(label) { return STING_SHOWS.test(String(label || "")); }

function probeAudio(file, cb) {
  execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=sample_rate,channels",
    "-of", "default=noprint_wrappers=1", file], { timeout: 20000 }, (err, stdout) => {
    if (err) return cb(err);
    const get = (k) => { const m = new RegExp(`^${k}=(\\S+)`, "m").exec(stdout); return m ? m[1] : null; };
    const dur = parseFloat(get("duration"));
    if (!(dur > 0)) return cb(new Error(`no duration for ${path.basename(file)}`));
    cb(null, { durationSec: dur, sampleRate: parseInt(get("sample_rate"), 10) || 24000, channels: parseInt(get("channels"), 10) || 1 });
  });
}

/**
 * Mix a bed under a rendered voice clip. The bed loops to the voice's length
 * at gainDb, fades in and out, and amix runs with normalize=0 so the voice
 * keeps exactly its level (measured: within 0.1 LU on a real DJ intro). The
 * output matches the voice's sample rate and channel count, so the stream
 * pipeline sees the same shape of file it would without a bed.
 */
function mixUnderVoice(voicePath, bedPath, outPath, opts, cb) {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  const o = Object.assign({}, MIX_DEFAULTS, opts || {});
  probeAudio(voicePath, (err, v) => {
    if (err) return cb(err);
    const dur = v.durationSec;
    const fadeIn = Math.min(o.fadeIn, dur / 2);
    const fadeOut = Math.min(o.fadeOut, dur / 2);
    const layout = v.channels === 1 ? "mono" : "stereo";
    const filter =
      `[1:a]atrim=0:${dur.toFixed(3)},aformat=channel_layouts=${layout},volume=${o.gainDb}dB,` +
      `afade=t=in:st=0:d=${fadeIn.toFixed(3)},afade=t=out:st=${Math.max(0, dur - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}[bed];` +
      `[0:a][bed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[out]`;
    const ext = path.extname(outPath).toLowerCase();
    const codec = ext === ".wav" ? ["-c:a", "pcm_s16le"] : ["-c:a", "libmp3lame", "-b:a", "96k"];
    const args = ["-y", "-nostdin", "-v", "error", "-i", voicePath, "-stream_loop", "-1", "-i", bedPath,
      "-filter_complex", filter, "-map", "[out]", "-t", dur.toFixed(3),
      "-ar", String(v.sampleRate), "-ac", String(v.channels), ...codec, outPath];
    const timeout = 60000 + Math.round(dur * 500);
    execFile(o.ffmpeg || "ffmpeg", args, { timeout }, (e2, _so, stderr) => {
      if (e2) return cb(new Error(`ffmpeg mix: ${(stderr || e2.message || "").toString().trim().split("\n").pop()}`));
      cb(null, outPath);
    });
  });
}

/** The clips on disk, by kind and name, with existence checks cached. */
class SoundLibrary {
  constructor(opts = {}) {
    this.dir = opts.dir || process.env.SOUND_DIR || DEFAULT_DIR;
    this._log = opts.log || console.warn.bind(console);
    // Lookups are cached, so a missing clip is logged once (again after rescan()).
    this._known = new Map();
  }
  _clip(kind, name) {
    if (!name) return null;
    const key = `${kind}/${name}`;
    if (this._known.has(key)) return this._known.get(key);
    const file = path.join(this.dir, KIND_DIR[kind], `kannaka-${kind}-${name}.mp3`);
    const hit = fs.existsSync(file) ? file : null;
    this._known.set(key, hit);
    if (!hit) this._log(`[sound] missing ${kind} "${name}" (${file}); airing without it`);
    return hit;
  }
  bed(name) { return this._clip("bed", name); }
  sting(name) { return this._clip("sting", name); }
  sfx(name) { return this._clip("sfx", name); }
  /** Forget cached lookups (a clip was added while running). */
  rescan() { this._known.clear(); }
}

/**
 * Everything index.js wires: the prepareVoice hook for icecast-source (null
 * when beds are off, so the queue items stay untouched), and the cue
 * controller for stings. `inject(path, meta)` queues a clip on /stream.
 */
function createSoundRuntime(opts = {}) {
  const env = opts.env || process.env;
  const flags = readFlags(env);
  const library = opts.library || new SoundLibrary({ dir: opts.dir || env.SOUND_DIR, log: opts.log });
  const log = opts.log || console.log.bind(console);
  const warn = opts.warn || console.warn.bind(console);
  const inject = opts.inject || (() => {});
  const nowHour = opts.nowHour || (() => chicagoHour());
  const mixer = opts.mixer || mixUnderVoice;

  const prepareVoice = !flags.beds ? null : (voicePath, meta) => new Promise((resolve) => {
    const bedName = bedFor(meta, nowHour());
    const bedPath = bedName ? library.bed(bedName) : null;
    if (!bedPath) return resolve(null);
    const outPath = `${voicePath}.bed-${bedName}${path.extname(voicePath) || ".mp3"}`;
    mixer(voicePath, bedPath, outPath, {}, (err, mixed) => {
      if (err) { warn(`[sound] bed "${bedName}" under ${(meta && meta.label) || path.basename(voicePath)} failed: ${err.message}; airing the voice alone`); return resolve(null); }
      log(`   \u{1F39A} [sound] bed "${bedName}" under ${(meta && meta.label) || path.basename(voicePath)}`);
      resolve(mixed);
    });
  });

  const stingNow = (key, label) => {
    if (!flags.stings) return false;
    const p = library.sting(STINGS[key]);
    if (!p) return false;
    inject(p, { label, kind: "sting" });
    return true;
  };

  let lastHourKey = null;
  let timer = null;
  const cues = {
    onTrackChange(actual, upcoming) {
      for (const s of stingsForTrackChange(actual, upcoming)) {
        stingNow(s, s === "chime" ? "Store door" : "Commercial bumper");
      }
    },
    beforeShowIntro(meta) {
      const label = meta && meta.label;
      if (showGetsStings(label)) stingNow("showIntro", `${String(label).replace(/ intro$/i, "")} sting`);
    },
    onShowEnd(label) {
      if (showGetsStings(label)) stingNow("showOutro", `${label} outro`);
    },
    tick(state, now = new Date()) {
      const chi = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
      const hourKey = `${chi.getFullYear()}-${chi.getMonth()}-${chi.getDate()}T${chi.getHours()}`;
      const st = Object.assign({ minute: chi.getMinutes() }, state || {});
      if (!identDue(st, hourKey, lastHourKey)) return false;
      lastHourKey = hourKey;
      return stingNow("ident", "Station ident");
    },
    startClock(getState, intervalMs = 20000) {
      if (!flags.stings || timer) return;
      timer = setInterval(() => { try { cues.tick(getState()); } catch (e) { warn(`[sound] clock: ${e.message}`); } }, intervalMs);
      if (timer.unref) timer.unref();
    },
    stopClock() { if (timer) { clearInterval(timer); timer = null; } },
  };

  if (flags.beds || flags.stings) log(`[sound] library ${library.dir}: beds=${flags.beds ? "on" : "off"} stings=${flags.stings ? "on" : "off"}`);
  return { flags, library, prepareVoice, cues };
}

module.exports = {
  DEFAULT_DIR, BEDS, STINGS, MIX_DEFAULTS,
  readFlags, bedFor, isStoreAd, stingsForTrackChange, identDue, showGetsStings, isNight,
  probeAudio, mixUnderVoice, SoundLibrary, createSoundRuntime,
};
