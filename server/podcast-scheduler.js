/**
 * podcast-scheduler.js — Podcast episodes on the DJ channel.
 *
 * Schedule (2026-04-27 onward):
 *   - DAILY at 10:00 AM CST and 10:00 PM CST
 *   - One episode per day, rotating by day-of-week through the
 *     7 available episodes. Mon→ep[0], Tue→ep[1], ..., Sun→ep[6].
 *     If episode count != 7, falls back to (day-of-year % count).
 *   - Both the morning and evening airing on a given day play the
 *     SAME episode — second-chance replay.
 *
 * After the episode finishes, normal DJ programming resumes.
 *
 * `pickTodayEpisode()` is the public read of that rotation — the Door's
 * /api/schedule calls it so the printed line-up and the actual airing
 * can never disagree.
 *
 * Pre-show promo: 30 minutes before each airing, Kannaka announces
 * the upcoming podcast in her next talk segment via the _podcastPromo flag.
 */

const path = require("path");
const fs = require("fs");
const { dailyRotationIndex } = require("./lib/scheduler-helpers");

// Default show config = the original hardcoded Ghost Signals behavior.
// A second PodcastScheduler instance with a different `show` airs another
// program (e.g. The Story of Flaukowski at 9/21) with zero changes here.
const DEFAULT_SHOW = {
  label: "Ghost Signals Podcast",
  folder: "Ghost Signals Podcast",
  airHours: [10, 22],           // Chicago local hours, minute :00
  promoMinutesBefore: 30,
  intro: (epTitle) =>
    `It's podcast time. Today's episode: ${epTitle}. Settle in, turn it up, let the ghost signals speak.`,
};

/**
 * The episode number a release filename carries: "GSP-041-…" → 41,
 * "TSOF-E03-…" → 3, "GSP-007.mp3" → 7. null when there is none.
 */
function episodeNumber(fileName) {
  const m = /^[A-Za-z]+[-_ ]?E?(\d{1,4})(?=[-_ .]|$)/i.exec(path.basename(String(fileName)));
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Turn an episode filename stem into something readable on a schedule.
 * "TSOF-E03-The-Whisper-Cathedral" → "E03 · The Whisper Cathedral".
 * A stem that doesn't carry the SHOW-E0N- prefix just loses its
 * separators, so a differently-named drop still reads as prose rather
 * than as a filename.
 */
function prettyEpisodeTitle(stem) {
  const s = String(stem == null ? "" : stem).trim();
  if (!s) return "";
  const m = s.match(/^[A-Za-z]+-(E\d+)-(.+)$/);
  if (m) return `${m[1].toUpperCase()} · ${m[2].replace(/[-_]+/g, " ").trim()}`;
  return s.replace(/[-_]+/g, " ").trim();
}

class PodcastScheduler {
  /**
   * @param {object} opts
   * @param {object}   opts.djEngine    — DJEngine instance
   * @param {object}   opts.voiceDJ     — VoiceDJ instance
   * @param {function} opts.broadcast   — WS broadcast function
   * @param {function} opts.broadcastState — broadcasts full DJ state
   * @param {function} opts.getMusicDir — returns MUSIC_DIR
   * @param {object}   [opts.show]      — show config overriding DEFAULT_SHOW
   */
  constructor(opts) {
    this._djEngine = opts.djEngine;
    this._voiceDJ = opts.voiceDJ;
    this._broadcast = opts.broadcast;
    this._broadcastState = opts.broadcastState;
    this._getMusicDir = opts.getMusicDir;
    this._show = Object.assign({}, DEFAULT_SHOW, opts.show || {});

    this._podcastPlaying = false;
    this._savedDJState = null;
    this._lastTriggeredMinute = null; // "YYYY-MM-DD HH:mm" to prevent re-trigger
    this._lastPromoMinute = null;
    this._timer = null;
  }

  /**
   * Start the scheduler. Checks every 60 seconds.
   */
  start() {
    console.log(`[podcast-scheduler] Started — ${this._show.label}, daily at ${this._show.airHours.join(" + ")}h Chicago, day-of-week rotation`);
    this._timer = setInterval(() => this._tick(), 60000);
    // Run once immediately to catch restart-during-window
    this._tick();
  }

  /**
   * Pick today's episode index. JS Date#getDay returns 0=Sun..6=Sat.
   * We map Mon=0..Sun=6 so the work-week kicks the rotation off, but
   * any rotation works as long as it's deterministic per-day.
   *
   * If we have exactly 7 episodes, this gives one per day of week.
   * If the count differs, we fall back to (day-of-year % count) so
   * the rotation still cycles cleanly without re-airing the same
   * episode two days running.
   */
  _episodeIndexFor(chicago, episodeCount) {
    if (episodeCount <= 0) return 0;
    if (episodeCount === 7) {
      const jsDay = chicago.getDay();           // 0=Sun..6=Sat
      const monAligned = (jsDay + 6) % 7;        // 0=Mon..6=Sun
      return monAligned;
    }
    // Any other count steps one per day through the list — the same
    // rule the album showcase rotation uses, kept in one place.
    return dailyRotationIndex(chicago, episodeCount);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Get the list of episode files from this show's music subfolder.
   */
  _getEpisodes() {
    const podcastDir = path.join(this._getMusicDir(), this._show.folder);
    if (!fs.existsSync(podcastDir)) return [];
    return fs.readdirSync(podcastDir)
      .filter(f => /\.(mp3|wav|flac|m4a|ogg)$/i.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  }

  /**
   * Which episode airs today, and why. Single source of truth for both
   * the airing and anything that *displays* the line-up (the Door's
   * /api/schedule) — so the schedule can never advertise an episode
   * other than the one that actually plays.
   *
   * Pure and side-effect free (bar the stat calls); safe to call per
   * request.
   *
   * @returns {{file: string, title: string, index: number, total: number,
   *            reason: "new-release"|"rotation"}|null} null when the
   *          show's folder is missing or holds no audio.
   */
  pickTodayEpisode() {
    const episodes = this._getEpisodes();
    if (episodes.length === 0) return null;

    // ── New-release priority ────────────────────────────────
    // A freshly released episode preempts the rotation for its first
    // 48 hours (both slots, both days), then the day-of-week rotation
    // resumes. Deterministic across restarts with no state file.
    //
    // This used to key on mtime alone, and mtime is one flag away from
    // lying: `cp -p`, `rsync -a`, `scp -p`, `tar -x`, a backup restore or
    // a sync tool all land a brand-new GSP-041 wearing its source's OLD
    // mtime, and the release was silently demoted to the rotation (#327).
    //
    // Now:
    //   - the candidate is the highest-numbered episode (GSP-041,
    //     TSOF-E08 …) — by construction the newest release, and immune to
    //     an old episode being re-tagged or re-encoded. Unnumbered
    //     folders keep the old newest-mtime candidate.
    //   - it is fresh when it LANDED on this box within the window:
    //     max(mtime, ctime). ctime is set by the filesystem when the file
    //     is created here and cannot be carried over by a
    //     timestamp-preserving copy. (A later rename/chmod also bumps it,
    //     which at worst re-extends the newest episode's own window.)
    const NEW_RELEASE_MS = 48 * 60 * 60 * 1000;
    const release = this._newestRelease(episodes);
    const nowMs = this._nowMs();
    if (release) release.fresh = nowMs - release.landedMs < NEW_RELEASE_MS;
    const diag = release ? {
      file: release.file,
      number: release.number,
      mtime: new Date(release.mtimeMs).toISOString(),
      landed: new Date(release.landedMs).toISOString(),
      fresh: release.fresh,
    } : null;
    if (release && release.fresh) {
      return {
        file: release.file,
        title: release.file.replace(/\.[^.]+$/, ""),
        index: episodes.indexOf(release.file),
        total: episodes.length,
        reason: "new-release",
        release: diag,
      };
    }

    const idx = this._episodeIndexFor(this._chicagoNow(), episodes.length);
    return {
      file: episodes[idx],
      title: episodes[idx].replace(/\.[^.]+$/, ""),
      index: idx,
      total: episodes.length,
      reason: "rotation",
      release: diag,
    };
  }

  /** Wall clock for the new-release window; a method so tests can move it. */
  _nowMs() {
    return Date.now();
  }

  /**
   * The episode most likely to be the latest release, with the times the
   * new-release rule needs. Highest episode number wins (ties: latest to
   * land); a folder with no numbered episodes falls back to newest mtime,
   * the pre-#327 rule. null when nothing could be stat'd.
   */
  _newestRelease(episodes) {
    const dir = path.join(this._getMusicDir(), this._show.folder);
    const rows = [];
    for (const f of episodes) {
      try {
        const st = fs.statSync(path.join(dir, f));
        rows.push({
          file: f,
          number: episodeNumber(f),
          mtimeMs: st.mtimeMs,
          landedMs: Math.max(st.mtimeMs, st.ctimeMs),
        });
      } catch (_) { /* unstattable file — rotation fallback covers it */ }
    }
    if (rows.length === 0) return null;
    const numbered = rows.filter((r) => r.number !== null);
    if (numbered.length > 0) {
      const top = Math.max(...numbered.map((r) => r.number));
      return numbered.filter((r) => r.number === top)
        .reduce((a, b) => (b.landedMs > a.landedMs ? b : a));
    }
    // Unnumbered: newest by mtime, judged by mtime (legacy behaviour).
    const r = rows.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
    return { ...r, landedMs: r.mtimeMs };
  }

  /**
   * Get current time in Chicago timezone.
   */
  _chicagoNow() {
    const now = new Date();
    // toLocaleString gives us a parseable date string in Chicago time
    const chicagoStr = now.toLocaleString("en-US", { timeZone: "America/Chicago" });
    return new Date(chicagoStr);
  }

  /**
   * Minute key for dedup (prevents re-triggering within the same minute).
   */
  _minuteKey(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  _tick() {
    const chicago = this._chicagoNow();
    const hour = chicago.getHours();
    const min = chicago.getMinutes();
    const minuteKey = this._minuteKey(chicago);

    // ── Pre-show promo (promoMinutesBefore each airing) ─────
    const nowMinutes = hour * 60 + min;
    const isPromo = this._show.airHours.some(
      (h) => nowMinutes === h * 60 - this._show.promoMinutesBefore);

    if (isPromo && this._lastPromoMinute !== minuteKey) {
      this._lastPromoMinute = minuteKey;
      this._voiceDJ._podcastPromo = true;
      console.log(`[podcast-scheduler] Promo flag set — ${this._show.label} in ${this._show.promoMinutesBefore} minutes`);
    }

    // ── Airing trigger — this show's configured hours, :00 ──
    const isAirtime = min === 0 && this._show.airHours.includes(hour);

    if (isAirtime && !this._podcastPlaying && this._lastTriggeredMinute !== minuteKey) {
      this._lastTriggeredMinute = minuteKey;
      this._startScheduledPodcast();
    }
  }

  /**
   * Start TODAY'S podcast episode on the DJ channel.
   *
   * One episode per slot, picked by day-of-week so the same episode
   * airs morning and evening (second-chance replay), and a different
   * episode the next day. After the episode finishes, normal DJ
   * programming resumes.
   */
  async _startScheduledPodcast() {
    // Only interrupt DJ channel
    if (this._djEngine.state.channel !== "dj") {
      console.log(`[podcast-scheduler] ${this._show.label}: not on DJ channel, skipping`);
      return;
    }

    // Never hijack another scheduled show mid-episode (two scheduler
    // instances share one engine; each only knows its own flag).
    const curMeta = this._djEngine.state.playlistMeta &&
      this._djEngine.state.playlistMeta[this._djEngine.state.currentTrackIdx];
    if (curMeta && curMeta.isPodcastScheduled) {
      console.log(`[podcast-scheduler] ${this._show.label}: another scheduled show is airing, skipping this slot`);
      return;
    }

    const pick = this.pickTodayEpisode();
    if (!pick) {
      console.log(`[podcast-scheduler] ${this._show.label}: no episodes found`);
      return;
    }
    const todayEpisode = pick.file;
    const epTitle = pick.title;
    console.log(pick.reason === "new-release"
      ? `[podcast-scheduler] ${this._show.label}: new-release priority — ${todayEpisode}`
      : `[podcast-scheduler] ${this._show.label}: today's episode (idx ${pick.index}/${pick.total}) — ${todayEpisode}`);
    // Say what the new-release gate saw, so a rotation pick over a fresh
    // release is greppable instead of silent (#327).
    if (pick.release) {
      console.log(`[podcast-scheduler] ${this._show.label}: newest release ${pick.release.file} ` +
        `(mtime ${pick.release.mtime}, landed ${pick.release.landed}) → ${pick.reason}`);
    }

    // Save current DJ state for restoration after the episode finishes
    this._savedDJState = {
      currentAlbum: this._djEngine.state.currentAlbum,
      currentTrackIdx: this._djEngine.state.currentTrackIdx,
    };

    this._podcastPlaying = true;

    // Friendly intro line — references the episode by its cleaned-up name.
    // The DJ engine's voice-dj already exists for richer intros; this is
    // the explicit "we're switching channels for the next half hour" cue.
    const introText = this._show.intro(epTitle);

    this._voiceDJ.generateTTS(introText, (err, audioPath, text) => {
      if (!err && audioPath) {
        this._broadcast({
          type: "dj_talk_segment",
          text: text,
          audioUrl: "/audio-voice/" + path.basename(audioPath),
          duration: 8000,
          mood: "excited",
          timestamp: new Date().toISOString(),
        });
        console.log(`[podcast-scheduler] DJ intro broadcast`);
      }

      // After the intro plays out, load just today's one episode.
      setTimeout(() => {
        this._playAllPodcastEpisodes([todayEpisode]);
      }, err ? 1000 : 9000);
    });
  }

  /**
   * Replace the DJ playlist with ALL podcast episodes and start playback.
   * @param {string[]} episodeFiles — sorted filenames from _getEpisodes()
   */
  _playAllPodcastEpisodes(episodeFiles) {
    const podcastTracks = episodeFiles.map((f, i) => {
      const relPath = path.join(this._show.folder, f);
      const title = f.replace(/\.[^.]+$/, "");
      return {
        title: `[PODCAST] ${title}`,
        album: this._show.folder,
        trackNum: i + 1,
        totalTracks: episodeFiles.length,
        file: relPath,
        theme: `Kannaka Radio — ${this._show.label}`,
        isPodcastScheduled: true,
      };
    });

    // Replace the entire playlist with the podcast episodes
    this._djEngine.state.playlist = podcastTracks.map(t => t.file);
    this._djEngine.state.playlistMeta = podcastTracks;
    this._djEngine.state.currentTrackIdx = 0;
    this._djEngine.state.currentAlbum = this._show.folder;

    // Trigger state update so clients start playing episode 1
    this._broadcastState();

    // Broadcast a specific event so clients know it's podcast time
    this._broadcast({
      type: "podcast_scheduled",
      episode: `All ${episodeFiles.length} episodes`,
      totalEpisodes: episodeFiles.length,
      timestamp: new Date().toISOString(),
    });

    console.log(`[podcast-scheduler] Full podcast playlist loaded: ${episodeFiles.length} episodes`);

    // Synchronous end-of-podcast: when the last episode drains and the
    // engine would wrap the playlist, restore the saved album INSIDE
    // advanceTrack — before the wrapped track 0 (the same episode) can
    // start streaming again. The poll below stays as a backup for the
    // playlist-rebuilt-externally path.
    this._djEngine._onPlaylistExhausted = () => {
      this._onPodcastEnd();
      return true; // playlist replaced — engine plays its track 0
    };

    // Monitor for when all episodes finish (playlist exhausted)
    this._waitForPodcastEnd();
  }

  /**
   * Poll until the DJ has advanced past the last podcast episode,
   * or the playlist was rebuilt (no more isPodcastScheduled tracks).
   */
  _waitForPodcastEnd() {
    const totalEpisodes = this._djEngine.state.playlist.length;
    // Snapshot now: when the music track icecast-source was streaming ends
    // and calls advanceTrack(), the engine will see currentTrackIdx=0 (the
    // freshly-loaded podcast) and push the podcast track to history as
    // "just played" — even though it hasn't streamed a frame yet. End
    // condition #2 fires immediately if we don't gate on a real playback
    // having happened. We require an elapsed minimum AND a fresh history
    // entry whose playedAt postdates this snapshot.
    const startedAt = Date.now();
    const MIN_PLAYBACK_MS = 60 * 1000; // smallest sane episode is well over a minute

    const checkInterval = setInterval(() => {
      const currentIdx = this._djEngine.state.currentTrackIdx;
      const currentMeta = this._djEngine.state.playlistMeta[currentIdx];
      const elapsed = Date.now() - startedAt;

      // End conditions:
      // 1. Playlist was rebuilt externally (no podcast tracks left).
      //    Same elapsed gate so the spurious "first advance after replace"
      //    can't trigger this path either.
      if ((!currentMeta || !currentMeta.isPodcastScheduled) && elapsed > MIN_PLAYBACK_MS) {
        clearInterval(checkInterval);
        this._onPodcastEnd();
        return;
      }

      // 2. We've looped back to track 0 after playing through all episodes
      //    (advanceTrack wraps around). Check if we already played enough.
      //    We detect this by checking if the last track in history is the
      //    final podcast episode AND that history entry was stamped after
      //    we started — otherwise the just-replaced playlist's faux history
      //    push would end the podcast on the first poll.
      const history = this._djEngine.state.history;
      if (history.length > 0 && elapsed > MIN_PLAYBACK_MS) {
        const lastPlayed = history[history.length - 1];
        if (lastPlayed && lastPlayed.isPodcastScheduled &&
            lastPlayed.trackNum === totalEpisodes && currentIdx === 0 &&
            (lastPlayed.playedAt || 0) > startedAt) {
          clearInterval(checkInterval);
          this._onPodcastEnd();
          return;
        }
      }
    }, 5000);

    // Safety timeout: after 4 hours, force-end the podcast state
    // (7 episodes could be long; 4h is generous)
    setTimeout(() => {
      clearInterval(checkInterval);
      if (this._podcastPlaying) {
        this._onPodcastEnd();
      }
    }, 4 * 60 * 60 * 1000);
  }

  /**
   * Restore DJ state after all podcast episodes finish.
   */
  _onPodcastEnd() {
    if (!this._podcastPlaying) return; // already restored (hook + poll can both fire)
    this._podcastPlaying = false;
    this._djEngine._onPlaylistExhausted = null;
    console.log("[podcast-scheduler] All podcast episodes finished, resuming DJ");

    if (this._savedDJState) {
      // Restore the album that was playing before the podcast
      const { currentAlbum } = this._savedDJState;
      this._savedDJState = null;
      if (currentAlbum) {
        this._djEngine.loadAlbum(currentAlbum);
      }
    }

    this._broadcastState();
  }

  getStatus() {
    return {
      podcastPlaying: this._podcastPlaying,
      savedState: this._savedDJState,
      lastTriggered: this._lastTriggeredMinute,
    };
  }
}

module.exports = { PodcastScheduler, prettyEpisodeTitle, episodeNumber };
