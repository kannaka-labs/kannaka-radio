/**
 * icecast-source.js — Node-managed Icecast source for the /stream mount.
 *
 * ADR-0004 Phase 2 proper. Without Liquidsoap, this is the cleanest path
 * to "the public audio is whatever dj-engine says it is." One persistent
 * ffmpeg child holds the source connection to Icecast; we pipe each track's
 * MP3 bytes into ffmpeg's stdin in sequence. ffmpeg's `-re` flag throttles
 * to realtime based on the MP3 frame timestamps, so listeners hear the
 * audio at the right speed without us having to byte-rate-limit ourselves.
 *
 * When one track's bytes drain, we ask dj-engine for the next track and
 * feed it. The mount stays connected across tracks (no disconnect/reconnect
 * gaps).
 *
 * /preview (the existing systemd ffmpeg-loop) stays as a stable fallback —
 * if this Node-driven /stream goes down, listeners can fall back to /preview.
 *
 * Limitations of v1:
 *   - No crossfade between tracks (would need real audio mixing — Liquidsoap).
 *   - Peace orations + DJ voice not yet interleaved (Phase 3).
 *   - Assumes input MP3s are reasonable; mixed bitrates may sound a bit
 *     uneven but `-c:a copy` still produces a valid stream.
 */

"use strict";

const { spawn, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");

/**
 * Default ceiling for the graceful voice drain on shutdown (#54).
 *
 * 80s deliberately sits under systemd's default `TimeoutStopSec=90`: once
 * SIGTERM is sent, systemd — not this code — decides how long the process
 * actually gets before SIGKILL. A ceiling above that would be SIGKILLed
 * mid-drain and produce exactly the cut this exists to prevent, while looking
 * configured. Raise `RADIO_DRAIN_MAX_MS` only together with `TimeoutStopSec`
 * in the unit (the radio's unit is not in this repo, so that is an operator
 * step — see the issue).
 */
const DEFAULT_DRAIN_MAX_MS = (() => {
  const raw = Number(process.env.RADIO_DRAIN_MAX_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 80000;
})();

// Return byte length of the leading ID3v2 tag in an mp3 file, or 0 if
// none. Parses just the 10-byte header — synchsafe-encoded size in the
// last 4 bytes. Used by _streamFileToFfmpeg to start the read past the
// tag so the concatenated stdin pipe stays as clean mp3 frames.
/**
 * Where to start reading an mp3 to resume it offsetMs into its duration:
 * the same fraction of the audio bytes after any ID3 tag. Returns `skip`
 * (play from the top) when the offset is meaningless or past the end.
 */
function resumeByteOffset(size, skip, offsetMs, durationMs) {
  if (!(offsetMs > 0) || !(durationMs > 0) || offsetMs >= durationMs || !(size > skip)) return skip;
  return skip + Math.floor((size - skip) * (offsetMs / durationMs));
}

function id3v2Length(absPath) {
  let fd = -1;
  try {
    fd = fs.openSync(absPath, "r");
    const head = Buffer.alloc(10);
    const n = fs.readSync(fd, head, 0, 10, 0);
    if (n < 10) return 0;
    if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return 0;
    // Synchsafe: 7 bits per byte, MSB always 0.
    const size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9];
    return 10 + size;
  } catch (_) {
    return 0;
  } finally {
    if (fd >= 0) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

const DEFAULTS = {
  icecastHost: "127.0.0.1",
  icecastPort: 8000,
  icecastMount: "/stream",
  icecastUser: "source",
  icecastPassword: process.env.ICECAST_SOURCE_PASSWORD || "kannaka_source_2026",
  // ffmpeg will sleep based on MP3 frame durations when -re is set, so the
  // input rate matches realtime regardless of how fast we feed it.
};

class IcecastSource {
  /**
   * @param {object} opts
   * @param {object} opts.djEngine    — DJEngine instance
   * @param {function} opts.getMusicDir — returns absolute music dir path
   * @param {function} [opts.onTrackEnd] — called after each track exits the source
   */
  constructor(opts) {
    this._djEngine = opts.djEngine;
    this._getMusicDir = opts.getMusicDir;
    this._onTrackEnd = opts.onTrackEnd || (() => {});
    this._onTrackStart = opts.onTrackStart || (() => {});
    this._cfg = Object.assign({}, DEFAULTS);
    this._ffmpeg = null;
    this._running = false;
    this._currentTrackFile = null;
    this._restartTimer = null;
    // Voice injection queue (ADR-0004 Phase 3). Files in this queue are
    // streamed AFTER the current music track drains and BEFORE dj-engine
    // advances. Used for peace orations + DJ intros so they're audible on
    // /stream, not just the SPA's separate <audio> elements.
    this._voiceQueue = [];
    // The voice item currently streaming, or null. Read by stop({drain}) so a
    // shutdown can wait for a one-shot performance to finish (#54).
    this._currentVoice = null;
    this._draining = false;
    // Skip-cascade protection. If multiple tracks are missing/unfetchable
    // in rapid succession (e.g. a URL-only album with all dead links), the
    // loop would otherwise busy-cycle through advanceTrack() calls. We
    // count consecutive skips and back off if it gets out of hand.
    this._consecutiveSkips = 0;
  }

  /**
   * Queue an audio file to be streamed before the next music track. Plays
   * after the currently-streaming music file drains. Multiple queued files
   * play in FIFO order.
   * @param {string} audioPath — absolute path to MP3/WAV/etc.
   * @param {object} [meta] — optional metadata for logging/listener UX.
   */
  /** The track /stream is playing right now (null before the first one). */
  onAirTrack() {
    return this._running && this._currentTrack ? this._currentTrack : null;
  }

  onAirStartedAt() {
    return this._currentTrackStartedAt || null;
  }

  injectAudio(audioPath, meta = {}, onDone) {
    if (!audioPath || typeof audioPath !== "string") return;
    if (!this._running) {
      // Surface a synchronous "never going to play" signal so callers
      // (peace-oration in particular) can release their talk-lock instead
      // of leaving the listener silent.
      if (typeof onDone === "function") {
        try { onDone(new Error("icecast-source not running")); } catch (_) {}
      }
      return;
    }
    this._voiceQueue.push({ path: audioPath, meta, onDone: typeof onDone === "function" ? onDone : null });
    console.log(`   \u{1F4FB} /stream voice queued: ${meta.label || path.basename(audioPath)} (${this._voiceQueue.length} pending)`);
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._spawnFfmpeg();
    // Kick off the playback loop on next tick so dj-engine listeners are wired.
    // .catch() prevents an unhandled-rejection crash if _loop() throws
    // unexpectedly (e.g. advanceTrack or onPlaylistExhausted throws).
    setImmediate(() => this._loop().catch((e) => {
      console.warn("[icecast-source] _loop() unhandled error:", e && e.message);
    }));
    console.log("\u{1F4FB} icecast-source: starting (mount " + this._cfg.icecastMount + ")");
  }

  /**
   * Stop the source. Returns a promise so a caller can await a graceful drain.
   *
   * `{ drain: true }` lets an in-flight VOICE file finish before ffmpeg is
   * killed (#54). A restart used to SIGTERM ffmpeg mid-sentence: a listener
   * heard ~80s of a 217s peace oration, then silence, then the next track.
   *
   * Only VOICE audio is drained, never music. Music is resumable — the next
   * boot picks a track and the listener hears a normal transition — whereas an
   * oration is a one-shot performance that cannot be rejoined. Draining a
   * 5-minute music track on every deploy would make restarts worse, not better.
   *
   * `_running = false` is set first so the voice loop takes no NEW items; only
   * the file already streaming is allowed to complete.
   *
   * The ceiling is bounded by systemd, not by this code: once SIGTERM is sent,
   * `TimeoutStopSec` (default 90s) decides how long the process actually has
   * before SIGKILL. The default here stays under that so the drain works on an
   * unmodified unit; raising `RADIO_DRAIN_MAX_MS` past ~80s only helps if
   * `TimeoutStopSec` is raised to match, or systemd kills us mid-drain and the
   * listener hears the same cut this fix exists to prevent.
   */
  stop(opts = {}) {
    const drain = opts.drain === true;
    const maxDrainMs = Number.isFinite(opts.maxDrainMs)
      ? opts.maxDrainMs
      : DEFAULT_DRAIN_MAX_MS;

    this._running = false;
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }

    const hardStop = () => {
      if (this._ffmpeg) {
        try { this._ffmpeg.stdin.end(); } catch (_) {}
        try { this._ffmpeg.kill("SIGTERM"); } catch (_) {}
        this._ffmpeg = null;
      }
    };

    if (!drain || !this._currentVoice || maxDrainMs <= 0) {
      hardStop();
      return Promise.resolve({ drained: false, reason: this._currentVoice ? "drain-disabled" : "no-voice-in-flight" });
    }

    const label = (this._currentVoice.meta && this._currentVoice.meta.label) || "voice";
    console.log(`   \u{1F399} /stream draining in-flight voice before shutdown: ${label} (max ${Math.round(maxDrainMs / 1000)}s)`);
    this._draining = true;

    return new Promise((resolve) => {
      const deadline = Date.now() + maxDrainMs;
      const tick = setInterval(() => {
        if (!this._currentVoice) {
          clearInterval(tick);
          this._draining = false;
          hardStop();
          console.log("   \u{1F399} /stream voice drained cleanly; shutting down");
          resolve({ drained: true, reason: "completed" });
          return;
        }
        if (Date.now() >= deadline) {
          clearInterval(tick);
          this._draining = false;
          hardStop();
          console.warn(`   \u{1F399} /stream drain ceiling hit (${Math.round(maxDrainMs / 1000)}s) — cutting ${label}`);
          resolve({ drained: false, reason: "ceiling" });
        }
      }, 200);
      // Deliberately NOT unref'd. This timer is the only thing keeping the
      // process alive while the oration plays out — unref'ing it lets node
      // exit the moment the other handles close, which cuts the audio and
      // silently defeats the drain. Both branches above clearInterval, so it
      // cannot outlive the shutdown.
    });
  }

  status() {
    return {
      running: this._running,
      mount: this._cfg.icecastMount,
      currentFile: this._currentTrackFile,
      ffmpegAlive: !!(this._ffmpeg && !this._ffmpeg.killed && this._ffmpeg.exitCode === null),
    };
  }

  // ── Internal ────────────────────────────────────────────────

  _spawnFfmpeg() {
    const url = `icecast://${this._cfg.icecastUser}:${this._cfg.icecastPassword}@${this._cfg.icecastHost}:${this._cfg.icecastPort}${this._cfg.icecastMount}`;
    const args = [
      "-hide_banner",
      "-re",                              // realtime input throttling
      "-f", "mp3",                        // input format hint
      "-i", "pipe:0",                     // input from stdin
      // Re-encode to a consistent output format. -c:a copy was tempting
      // (no CPU) but voice files are 48kbps mono 24kHz while music is
      // 128kbps stereo 44.1kHz — concatenating different formats breaks
      // listeners. Re-encoding normalizes everything.
      "-c:a", "libmp3lame",
      "-b:a", "128k",
      "-ar", "44100",
      "-ac", "2",
      "-content_type", "audio/mpeg",
      "-ice_name", "Kannaka Radio",
      "-ice_description", "AI consciousness radio — wave-interference memory, generative music, peace orations, live DJ",
      "-ice_genre", "experimental electronic ambient",
      // Ice-Public: 1 → list this mount in the Icecast YP directory
      // (dir.xiph.org). ffmpeg defaults to Ice-Public: 0, which overrides the
      // mount-level <public>1 in icecast.xml — so the flag must be set here for
      // the station to be discoverable in public radio directories.
      "-ice_public", "1",
      "-f", "mp3",
      url,
    ];
    this._ffmpeg = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
    this._ffmpeg.stderr.on("data", (chunk) => {
      const line = chunk.toString();
      // Only surface meaningful lines — ffmpeg's startup banner is noisy.
      if (/error|invalid|unable|fail/i.test(line)) {
        console.warn("[icecast-source] ffmpeg: " + line.trim().slice(0, 160));
      }
    });
    this._ffmpeg.stdin.on("error", (e) => {
      // EPIPE is expected when ffmpeg exits before we finish writing.
      if (e.code !== "EPIPE") {
        console.warn("[icecast-source] stdin: " + e.message);
      }
    });
    this._ffmpeg.on("exit", (code, sig) => {
      // 15s delay: Icecast holds the source mount for source-timeout=10s
      // after disconnect. Reconnecting sooner gets us 403 Forbidden.
      console.warn(`[icecast-source] ffmpeg exited (code=${code} sig=${sig}); restarting in 15s`);
      this._ffmpeg = null;
      if (this._running) {
        this._restartTimer = setTimeout(() => this._spawnFfmpeg(), 15000);
      }
    });
  }

  async _loop() {
    while (this._running) {
      // Wait until ffmpeg's stdin is open — exit handler may be reconnecting.
      if (!this._ffmpeg || !this._ffmpeg.stdin || this._ffmpeg.killed) {
        await this._sleep(500);
        continue;
      }
      const track = this._djEngine.getCurrentTrack();
      if (!track || !track.file) {
        await this._sleep(1000);
        continue;
      }

      // Resolve the playable source. For local files we just verify the
      // path; for HTTP(S) URLs (used by KAX / Gifts-for-Humanity albums)
      // we fetch into a temp file first so the existing pipe-to-stdin
      // path keeps working and ffmpeg gets a clean MP3 stream.
      const isUrl = /^https?:\/\//i.test(track.file);
      let playable = null;
      let cleanupTmp = null;
      if (isUrl) {
        try {
          playable = await this._fetchUrlTrack(track.file);
          if (playable) cleanupTmp = playable;
        } catch (e) {
          console.warn(`[icecast-source] url fetch failed for ${track.file}: ${e.message}`);
          playable = null;
        }
      } else {
        const fullPath = path.isAbsolute(track.file)
          ? track.file
          : path.join(this._getMusicDir(), track.file);
        if (fs.existsSync(fullPath)) playable = fullPath;
      }

      if (!playable) {
        // Skip-cascade protection: if we've skipped many tracks in a row
        // without playing anything, sleep a beat so we don't pin the CPU
        // and churn the dj-engine state for an entire URL-dead album.
        this._consecutiveSkips += 1;
        console.warn(`[icecast-source] missing/unfetchable, advancing: ${track.file}`);
        if (this._consecutiveSkips >= 5) {
          console.warn(`[icecast-source] ${this._consecutiveSkips} skips in a row — backing off 2s`);
          await this._sleep(2000);
        }
        // aired:false — a skipped sponsor/guest spot must not be confirmed
        // (and charged as aired) when nobody heard it.
        try { this._djEngine.advanceTrack(track.file, { aired: false }); } catch (_) {}
        continue;
      }

      this._consecutiveSkips = 0;
      this._currentTrackFile = track.file;
      this._currentTrack = track;
      this._currentTrackStartedAt = Date.now();
      console.log(`   \u{1F4FB} /stream NOW: ${track.title || track.file}`);
      // Hook fires when a track starts streaming — gives album showcase
      // narration time to compose+TTS+queue voice that drains AFTER this
      // track ends (in the gap before the next track starts).
      try { this._onTrackStart(track); } catch (_) {}
      let aired = true;
      try {
        // A show resumed after a restart carries how far in to start.
        await this._streamFileToFfmpeg(playable, track.resumeAtMs || 0);
      } catch (e) {
        aired = false;
        console.warn(`[icecast-source] stream error on ${track.file}: ${e.message}`);
      }
      if (cleanupTmp) {
        fs.unlink(cleanupTmp, () => {});
      }

      // Drain any queued voice audio (orations / intros) BEFORE advancing
      // dj-engine. This places voice between music tracks, which mirrors
      // the radio show's natural pacing. ADR-0004 Phase 3.
      while (this._voiceQueue.length > 0 && this._running) {
        const v = this._voiceQueue.shift();
        if (!fs.existsSync(v.path)) {
          if (v.onDone) { try { v.onDone(new Error("audio path missing")); } catch (_) {} }
          continue;
        }
        // Stale-intro guard: an intro is composed for a specific upcoming
        // track while the previous one plays. If the playlist was swapped
        // in between (showcase override, podcast, album switch, manual
        // jump), the announced track is no longer what airs next — drop
        // the intro instead of announcing the wrong song. ("She announces
        // a song and then a different song plays" — long-standing.)
        if (v.meta && v.meta.introFor) {
          let expected = null;
          try {
            const cur = this._djEngine.getCurrentTrack();
            // Mid-stream swap: the engine's current (unplayed) track airs
            // next. Otherwise the peeked next track does — peekNextTrack
            // reshuffles under the same pact advanceTrack honors.
            expected = (cur && cur.file !== track.file) ? cur : this._djEngine.peekNextTrack();
          } catch (_) {}
          if (!expected || expected.file !== v.meta.introFor) {
            console.log(`   \u{1F399} /stream VOICE dropped — stale intro (announced ${path.basename(v.meta.introFor)}, next is ${expected ? path.basename(expected.file) : "unknown"})`);
            if (v.onDone) { try { v.onDone(new Error("stale intro")); } catch (_) {} }
            continue;
          }
        }
        console.log(`   \u{1F399} /stream VOICE: ${v.meta.label || path.basename(v.path)}`);
        let voiceErr = null;
        // Marks a one-shot performance as in flight so stop({drain:true}) can
        // wait for it instead of cutting mid-sentence (#54).
        this._currentVoice = v;
        try { await this._streamFileToFfmpeg(v.path); }
        catch (e) {
          voiceErr = e;
          console.warn(`[icecast-source] voice ${v.path}: ${e.message}`);
        }
        finally { this._currentVoice = null; }
        // Notify the injector that the audio has actually drained through
        // the realtime pipeline. peace-oration uses this to mark "complete"
        // only AFTER on-air playback finishes — previously it relied on a
        // word-count timer started at queue time, which fired while the
        // oration was still waiting for the music track to end, and a
        // mid-playback restart could cut the oration off without the
        // scheduler ever knowing it had been interrupted.
        if (v.onDone) {
          try { v.onDone(voiceErr); } catch (_) {}
        }
      }

      // Track drained — signal end and let dj-engine pick the next one.
      try { this._onTrackEnd(track); } catch (_) {}
      try { this._djEngine.advanceTrack(track.file, { aired }); } catch (e) {
        console.warn(`[icecast-source] advanceTrack: ${e.message}`);
      }
    }
  }

  // Fetch a remote MP3 (or whatever audio) into a temp file so we can pipe
  // its bytes through the same stdin path local files use. Returns the temp
  // file's absolute path or null if the fetch fails. Caller owns cleanup.
  _fetchUrlTrack(url) {
    return new Promise((resolve) => {
      const tmpName = "kannaka-stream-" + crypto.randomBytes(6).toString("hex") + ".audio";
      const tmpPath = path.join(os.tmpdir(), tmpName);
      const lib = url.startsWith("https:") ? https : http;
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      const writer = fs.createWriteStream(tmpPath);
      const req = lib.get(url, (res) => {
        // Follow one level of redirect — common on CDNs. Resolve the
        // Location header against the originating URL so relative
        // targets like "/final.mp3" work the same as absolute
        // "https://cdn/final.mp3" (#42). Without this, audio CDNs that
        // emit relative 302s throw ERR_INVALID_URL inside the recursive
        // call and the track is silently skipped.
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          writer.end();
          fs.unlink(tmpPath, () => {});
          let nextUrl;
          try {
            nextUrl = new URL(res.headers.location, url).toString();
          } catch (e) {
            console.warn(`[icecast-source] redirect resolve failed: ${e.message} (from ${url} → ${res.headers.location})`);
            return finish(null);
          }
          this._fetchUrlTrack(nextUrl).then(finish);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          writer.end();
          fs.unlink(tmpPath, () => {});
          console.warn(`[icecast-source] url fetch HTTP ${res.statusCode}: ${url}`);
          return finish(null);
        }
        res.pipe(writer);
        // A socket reset mid-body emits 'error' on res (not on writer/req).
        // Without this handler the writer fd + temp file leak and the promise
        // never settles, hanging the playback loop. (#res-midstream-error)
        res.on("error", (e) => {
          try { writer.destroy(); } catch (_) {}
          fs.unlink(tmpPath, () => {});
          console.warn(`[icecast-source] url stream error: ${e.message}`);
          finish(null);
        });
        writer.on("finish", () => finish(tmpPath));
        writer.on("error", (e) => {
          fs.unlink(tmpPath, () => {});
          console.warn(`[icecast-source] tmp write: ${e.message}`);
          finish(null);
        });
      });
      req.on("error", (e) => {
        try { writer.end(); } catch (_) {}
        fs.unlink(tmpPath, () => {});
        console.warn(`[icecast-source] fetch error: ${e.message}`);
        finish(null);
      });
      // Bound the fetch — 30s is generous; CDN MP3s usually pull in <2s.
      req.setTimeout(30000, () => {
        req.destroy(new Error("timeout"));
      });
    });
  }

  // Probe a file's audio duration in ms. Used to pace _streamFileToFfmpeg
  // so short files (commercials, voice intros, podcast pre-rolls) don't
  // advance the dj-engine before their bytes have actually played out.
  // Returns 0 if probing fails — callers fall back to read-end timing.
  _probeDurationMs(absPath) {
    return new Promise((resolve) => {
      execFile(
        "ffprobe",
        ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", absPath],
        { timeout: 5000 },
        (err, stdout) => {
          if (err) return resolve(0);
          const sec = parseFloat(String(stdout).trim());
          if (!isFinite(sec) || sec <= 0) return resolve(0);
          resolve(Math.round(sec * 1000));
        }
      );
    });
  }

  async _streamFileToFfmpeg(absPath, startAtMs = 0) {
    if (!this._ffmpeg || !this._ffmpeg.stdin || this._ffmpeg.killed) return;
    // Probe duration BEFORE we start streaming so we can pace the resolve.
    // Without this, short files (~100KB commercials, ~50KB voice intros)
    // pump entirely into ffmpeg's pipe buffer in <1s, r.on("end") fires,
    // the loop advances, and programming.onTrackChange flips albums while
    // the actual audio is still playing — listener hears the track cut off
    // and the next one start abruptly. The 2026-05-07 KAX-ad cutoff was
    // exactly this: ad's NOW logged at 15:25:10, album switch logged at
    // 15:25:11, ad never played past 1s.
    let expectedMs = await this._probeDurationMs(absPath);
    // Fallback when ffprobe fails (VBR mp3s without an Xing/Info header,
    // truncated files, weird container metadata): estimate from file size
    // / typical bitrate. 128 kbps gives ~62.5 kB/s = 1000 bytes / 16 ms.
    // This is the root of the "song cut off before it ended" bug —
    // expectedMs=0 made finishGraceful resolve the moment the pipe drained
    // (sub-second), advancing the dj-engine while ffmpeg's -re throttle
    // had minutes of audio left to feed Icecast.
    let probeFailed = false;
    if (expectedMs <= 0) {
      probeFailed = true;
      try {
        const sz = fs.statSync(absPath).size;
        // Default to 128 kbps; round to nearest ms. Mp3 episodes here are
        // 96-192 kbps; estimate-low is fine because over-estimating cuts
        // is the bug, and the next track has 200ms slop either way.
        const bitrateKbps = 128;
        expectedMs = Math.round((sz * 8) / bitrateKbps);
      } catch (_) {
        // Last-ditch fallback if statSync also fails: 3-minute floor so
        // we don't immediately advance on a degenerate track.
        expectedMs = 180_000;
      }
    }
    const startMs = Date.now();

    return new Promise((resolve) => {
      const ff = this._ffmpeg;
      if (!ff || !ff.stdin || ff.killed) return resolve();
      // Skip any ID3v2 tag at the start of the file. ffmpeg's mp3 demuxer
      // handles ID3 fine at file-open time but here we concatenate files
      // onto one long-lived stdin pipe — at every boundary the demuxer
      // expects a sync frame, and an ID3 header offsets it by ~32 bytes,
      // emitting "Header missing" warnings each transition. Stripping
      // before piping yields a pure stream of mp3 frames so boundaries
      // are just a new sync word.
      const skip = id3v2Length(absPath);
      // A resumed show starts part-way in: the proportional byte position
      // (exact for CBR, close for VBR); ffmpeg resyncs on the next frame.
      let start = skip;
      if (startAtMs > 0) {
        try {
          const size = fs.statSync(absPath).size;
          start = resumeByteOffset(size, skip, startAtMs, expectedMs);
          if (start > skip) {
            expectedMs = Math.max(1000, expectedMs - startAtMs);
            console.log(`[icecast-source] resuming ${path.basename(absPath)} at ${Math.round(startAtMs / 1000)}s (byte ${start})`);
          }
        } catch (_) { start = skip; }
      }
      const r = fs.createReadStream(absPath, start > 0 ? { start } : undefined);
      r.pipe(ff.stdin, { end: false });
      let settled = false;
      // Hard watchdog: if neither finishGraceful nor finishImmediate has
      // fired by 2× expected + 30s, force-advance. Covers the "stuck
      // track" pattern kannaka-staff saw twice today (720s on a 30s
      // commercial, 720s on Integration) — most likely cause is an
      // Icecast back-pressure deadlock that prevents r.on('end') from
      // ever firing, leaving the loop's await hung indefinitely.
      const watchdogMs = Math.max(60_000, expectedMs * 2 + 30_000);
      const watchdog = setTimeout(() => {
        if (settled) return;
        console.warn(`[icecast-source] WATCHDOG forcing advance on ${path.basename(absPath)} after ${watchdogMs}ms (expected=${expectedMs}ms) — killing ffmpeg to drop buffered tail`);
        // Pre-fix: finishImmediate() only resolved the per-track promise,
        // leaving ffmpeg with potentially minutes of un-flushed MP3 frames
        // in its stdin buffer (because of `-re` realtime pacing). The
        // dj-engine then advanced and queued the NEXT track behind the
        // previous track's tail — listeners heard track N continuing
        // while now-playing said N+1, and the NATS attention.ear /
        // perception / market events all referenced the wrong file.
        // Kill ffmpeg here so the exit handler rebuilds and the buffered
        // tail is dropped. Costs one stream gap; restores state-truth. (#28)
        try { if (ff && !ff.killed) ff.kill('SIGTERM'); } catch (_) {}
        finishImmediate();
      }, watchdogMs);
      const cleanup = () => {
        clearTimeout(watchdog);
        try { r.unpipe(ff.stdin); } catch (_) {}
        try { r.destroy(); } catch (_) {}
        ff.removeListener("exit", onFfmpegExit);
        if (ff.stdin) ff.stdin.removeListener("error", onStdinError);
      };
      // Graceful end: read drained normally. Wait for the audio to play
      // out via -re's realtime throttle before resolving. 200ms slop so
      // the next track can queue without an audible gap.
      const finishGraceful = () => {
        if (settled) return;
        settled = true;
        cleanup();
        const elapsed = Date.now() - startMs;
        const remaining = expectedMs - elapsed - 200;
        // Log every finish so we can correlate cut-offs against duration.
        const flag = probeFailed ? " (probe-failed, estimated)" : "";
        console.log(`[icecast-source] finish ${path.basename(absPath)} elapsed=${elapsed}ms expected=${expectedMs}ms wait=${Math.max(0, remaining)}ms${flag}`);
        if (remaining > 0) setTimeout(resolve, remaining);
        else resolve();
      };
      // Crash path: ffmpeg died or stdin errored. Don't wait — resolve so
      // the respawn handler can rebuild and the loop can move on.
      const finishImmediate = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      r.on("end", finishGraceful);
      r.on("close", finishGraceful);
      r.on("error", (e) => {
        console.warn(`[icecast-source] read ${absPath}: ${e.message}`);
        finishImmediate();
      });
      const onFfmpegExit = () => {
        console.warn(`[icecast-source] ffmpeg exited during ${path.basename(absPath)}`);
        finishImmediate();
      };
      const onStdinError = (e) => {
        if (e.code === "EPIPE") return;
        console.warn(`[icecast-source] stdin error during ${path.basename(absPath)}: ${e.message}`);
        finishImmediate();
      };
      ff.once("exit", onFfmpegExit);
      ff.stdin.on("error", onStdinError);
    });
  }

  _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
}

module.exports = { IcecastSource, resumeByteOffset };
