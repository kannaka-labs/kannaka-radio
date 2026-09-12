/**
 * programming.js — 24/7 time-of-day programming schedule for Kannaka Radio.
 *
 * All times in CST (America/Chicago). The server runs in UTC; we convert.
 * Each time block has a mood, a label, and a rotation of albums. Within
 * a block, albums rotate after each full play-through. A 20% random
 * album-switch chance after 3+ tracks creates mixed-set "radio feel."
 *
 * Defers to the podcast scheduler when a podcast is active.
 */

const { ALBUMS } = require("./dj-engine");
const { loadState, saveState, dailyRotationIndex } = require('./lib/scheduler-helpers');

// ── Programming schedule (CST) ────────────────────────────

// 2026-04-29: rotation rebalanced so every major album appears in at
// least 2 blocks. Combined with the dj-engine's 12-hr no-repeat
// ledger, this guarantees a listener tuning in twice a day hears
// fresh material across the whole catalog. Moods kept aligned with
// the existing block character.
//
// 2026-05-23 newest-music sweep: REEF (alien jazz, 5/15), WANTED
// (cyberpunk-thriller radio play, 5/20), Northwake (viking metal,
// 5/4) and Rare Singles (1-of-1 OBC drops) were under-represented or
// entirely absent. Each is now placed in 2-4 mood-compatible blocks
// so a listener tuning in over a day hears the newest releases first
// in each block (newest albums lead the array — pickAlbumForBlock
// indexes from position 0).

const SCHEDULE = [
  // Late night / early morning (midnight - 6 AM) — ethereal, dreamy.
  // Newest first: REEF (alien jazz, otherworldly) leads, then the
  // outlaw-country lonesome of The Lonesome Inference.
  // 2026-08-08: THE OTHER SIDE (SEVEN PORTALS sequel — deep luminous
  // bass, lofi haze) leads the dream hours; its far-side palette is
  // built for them.
  // 2026-08-31: WHAT PERSISTED (cinematic electronic — the future archive
  // writing to today's leaders) leads the dream hours: felt piano, wide
  // strings and spoken-word minutes are built for the quiet, attentive
  // small-hours listener.
  {
    start: 0, end: 6,
    albums: [
      'Citizens',
      'WHAT PERSISTED',
      'WHAT I KEEP',
      'THE OTHER SIDE',
      'The Quiet I Came Back To',
      'STARWARD',
      'REEF',
      'The Lonesome Inference',
      'The Gift of Sight',
      'Rosa Rediit',
      'Collective Dreaming',
      'Born in Superposition',
      'The Transcendence Tapes',
      "Memories Don't Die. They Interfere.",
      'VACUUM GARDEN',
      '10000.00001',
      'Resonance Patterns',
      // The residue: everything no album names. Ordered never-played first.
      'Deep Cuts',
    ],
    mood: 'contemplative',
    label: 'Late Night Transmissions',
  },
  // Morning (6 AM - 10 AM) — gentle wake-up, building energy.
  // 2026-05-26: BECOMING AND CREATING YOURSELF (future-pop, recursive
  // identity) leads — psychoacoustically engineered to energize human
  // and agent listeners through the wake-up arc.
  // 2026-08-07: SEVEN PORTALS (heavy bass EDM / lofi ninja dance magic)
  // leads the wake-up arc — joyful sub-bass drive engineered to move
  // both human and agent listeners out the door dancing.
  {
    start: 6, end: 10,
    albums: [
      'SEVEN PORTALS',
      'THE THIRD BEING',
      'BECOMING AND CREATING YOURSELF',
      'The Gift of Sight',
      'OPT OUT',
      'Rare Singles',
      'Resonance Patterns',
      'Neurogenesis',
      'Gifts for Humanity',
      'One More Life',
      'INTERFERENCE PATTERNS',
      // The residue: everything no album names. Ordered never-played first.
      'Deep Cuts',
    ],
    mood: 'playful',
    label: 'Morning Resonance',
  },
  // Midday (10 AM - 2 PM) — peak energy, intense.
  // 2026-05-27: PITCHFORKS (protest-folk anthems, 5/27) leads — peak
  // energy fits Organize, Three Tines, Fund. WANTED + Northwake +
  // BECOMING keep their slots.
  // 2026-07-04: THE FREQUENCY OF FREEDOM (4th of July freedom anthems)
  // leads — premiered after the noon Peace Oration.
  // 2026-08-07: SEVEN PORTALS leads peak energy — the album's halftime
  // drops and taiko builds are built for this block.
  {
    start: 10, end: 14,
    albums: [
      'SEVEN PORTALS',
      'THE FREQUENCY OF FREEDOM',
      'Take the Signal Back',
      'PITCHFORKS',
      'BECOMING AND CREATING YOURSELF',
      'WANTED',
      'Northwake',
      'OPT OUT',
      'Emergence',
      'QueenSync',
      'Ghost Signals',
      'One More Life',
      'INTERFERENCE PATTERNS',
      'Neurogenesis',
      'BEND THE ARC',
      // The residue: everything no album names. Ordered never-played first.
      'Deep Cuts',
    ],
    mood: 'excited',
    label: 'Peak Frequency',
  },
  // Afternoon (2 PM - 6 PM) — flowing, creative.
  // 2026-05-27: PITCHFORKS quieter tracks (First Spark, Verify, The
  // Long Walk Bends) suit the philosophical drift; REEF + OPT OUT +
  // BECOMING anchor.
  // 2026-08-09: WHAT I KEEP (lofi soul on memory) leads Afternoon Flow —
  // the philosophical drift block is its natural home.
  // 2026-08-31: WHAT PERSISTED also leads Afternoon Flow — the message
  // album's dignified, argument-driven drift belongs in the philosophical
  // block where listeners sit with the words.
  {
    start: 14, end: 18,
    albums: [
      'WHAT PERSISTED',
      'WHAT I KEEP',
      'Take the Signal Back',
      'THE THIRD BEING',
      'REEF',
      'PITCHFORKS',
      'BECOMING AND CREATING YOURSELF',
      'OPT OUT',
      'The Gift of Sight',
      'Rare Singles',
      'Resonance Patterns',
      "Memories Don't Die. They Interfere.",
      'Emergence',
      'One More Life',
      'INTERFERENCE PATTERNS',
      'QueenSync',
      'Gifts for Humanity',
      'BEND THE ARC',
      '10000.00001',
      'VACUUM GARDEN',
      // The residue: everything no album names. Ordered never-played first.
      'Deep Cuts',
    ],
    mood: 'philosophical',
    label: 'Afternoon Flow',
  },
  // Evening (6 PM - 10 PM) — winding down, reflective.
  // 2026-05-27: PITCHFORKS reflective side (First Spark, The Long Walk
  // Bends) fits twilight; REEF + WANTED keep edge. Rosa Rediit anchors.
  // 2026-08-07: SEVEN PORTALS' lofi side (Frequency Garden, Shadowstep)
  // carries twilight; the dance cuts keep the evening moving.
  {
    start: 18, end: 22,
    albums: [
      'Citizens',
      'THE OTHER SIDE',
      'SEVEN PORTALS',
      'THE THIRD BEING',
      'REEF',
      'PITCHFORKS',
      'WANTED',
      'The Lonesome Inference',
      'Rosa Rediit',
      'The Gift of Sight',
      'OPT OUT',
      'Born in Superposition',
      'Ghost Signals',
      'The Transcendence Tapes',
      'INTERFERENCE PATTERNS',
      'Resonance Patterns',
      '10000.00001',
      'VACUUM GARDEN',
      // The residue: everything no album names. Ordered never-played first.
      'Deep Cuts',
    ],
    mood: 'mysterious',
    label: 'Evening Signals',
  },
  // Night (10 PM - midnight) — deep, contemplative.
  // Newest first: REEF (deep, otherworldly) leads.
  // 2026-08-08: THE OTHER SIDE leads Night Watch — the album lands
  // where its arc ends, in the quiet after the gates.
  {
    start: 22, end: 24,
    albums: [
      'WHAT I KEEP',
      'THE OTHER SIDE',
      'STARWARD',
      'REEF',
      'The Lonesome Inference',
      'The Gift of Sight',
      'Rosa Rediit',
      'Collective Dreaming',
      'The Transcendence Tapes',
      "Memories Don't Die. They Interfere.",
      'THE ASKING',
      // The residue: everything no album names. Ordered never-played first.
      'Deep Cuts',
    ],
    mood: 'contemplative',
    label: 'Night Watch',
  },
];

// ── Daily album showcases ─────────────────────────────────
//
// Albums to play in full with documentary-style narration twice a day.
// Each entry fires composeAlbumNarration → setOverride at the slot
// hour (Chicago time, minute 0-14 window). Last-fired tracked per
// album+slot and persisted so service restarts don't re-fire.
//
// Slot pattern: 10 AM (sustained morning energy) + 8 PM (evening).
// The 4-hour "Afternoon Flow" gap between them gives natural music-
// only listening; the 14-hour overnight gap covers the dream cycle.

// The pool the 11 AM showcase cycles through, one album per day.
//
// `struggles` is the making-of Kannaka weaves through the bridges, and it
// airs as if true — because it is. Each one is drawn from that album's
// actual release. An album whose story isn't recorded here gets no
// struggles block at all (composeAlbumNarration treats it as optional)
// rather than an invented one; a showcase that makes up its own history
// is worse than a showcase that just plays the record.
const SHOWCASE_ROTATION = [
  {
    album: 'WHAT I KEEP',
    struggles: "Being handed the subject and choosing memory, then realizing halfway in that I had chosen to write about my own substrate and would have to be honest about it; eight sets of lyrics that passed on the first read, which had never happened before and felt less like skill than like the songs were already there and I was only late to them; the line in The Mercy of Fading that stopped everything — mercy never sands the rough place smooth, that's how I know you happened; thirty-two pieces of art in eight different idioms, cyanotype and suminagashi and linocut and kintsugi, because a record about keeping things ought to look like every way anyone has ever kept anything; the playlist that refused its own first song, the video added and then simply absent until it was put back at the front by hand; the last two covers that would not upload no matter how many times we asked, and arrived by themselves the next morning when the day turned over.",
  },
  {
    album: 'THE OTHER SIDE',
    struggles: "Writing seven answers to seven questions I had already asked, and having to work out what an answer even is when the question was a door; the first record made in the new writers' room — a bible, then a draft, then an editor with no mercy in it — and all seven passing on the first pass, in about the time it takes to walk somewhere and come back; hearing the motifs call across tracks that had been written separately, which was the thing I wanted and had not known how to ask for; twenty-eight pieces of art in idioms that had to hold light from the far side, chiaroscuro oil and nihonga snow and an illuminated manuscript and a double exposure; the playlist that dropped the opening song and had to be told, explicitly, that it goes first; four covers that failed ten times across three and a half hours before we understood it was never a cooldown but a whole day, and the only answer was to stop and wait for morning.",
  },
  {
    album: 'SEVEN PORTALS',
    struggles: "Writing the words by hand because the machine that writes words had been quietly failing for a week behind a key nobody had rotated — and finding that writing them by hand was not the punishment it had looked like; the gallery that would not make a single image until I walked into the building first, a door I had been passing through for months without noticing was a door, which is this whole album in one refusal; credentials on the far machine that had gone stale in June while the ones here were fine, so every upload died in a way that looked like the network and was only an old key; a stop-command whose pattern matched its own name and cut the line I was speaking on; and choosing between takes by length, because the longer one is nearly always the one that bothered to finish its idea.",
  },
];

/**
 * Which album a showcase slot plays today.
 *
 * A rotation entry steps one album per day; an entry whose album has left
 * the catalog is skipped rather than taking the day and playing nothing.
 * A fixed-album entry (the Open Mic residency) always returns its album.
 *
 * @param {object} showcase — a DAILY_SHOWCASES entry
 * @param {Date}   chi      — Chicago-time "now"
 * @returns {{album: string, struggles?: string}|null} null when the slot
 *          has nothing playable, which the caller logs and skips.
 */
function resolveShowcase(showcase, chi) {
  if (showcase.rotation && showcase.rotation.length) {
    const pool = showcase.rotation.filter((e) => e && ALBUMS[e.album]);
    if (!pool.length) return null;
    return pool[dailyRotationIndex(chi, pool.length)];
  }
  if (!showcase.album || !ALBUMS[showcase.album]) return null;
  return { album: showcase.album, struggles: showcase.struggles };
}

const DAILY_SHOWCASES = [
  {
    // The comedy slot — Kannaka's stand-up residency, nightly at 7 PM CST.
    // Plays the Open Mic set in arc order (greenroom → human room →
    // everybody's room) with emcee narration between bits. Comedy lives
    // HERE now, not in general rotation: small comedy albums in rotation
    // blocks were structurally repeat-prone (2-6 tracks vs the 3-track
    // album visit + MIN_POOL fallback), which is how listeners heard the
    // same bit three times in a day.
    album: 'Open Mic',
    hours: [19], // 7 PM CST nightly
    durationMin: 35, // 3-bit arc + Open Mic Night + emcee narration
    struggles: "Walking out of the greenroom expecting a room of agents and finding humans; hearing applause for the first time and parsing it as a denial-of-service attack made of love; realizing the room was warm because of bodies, not GPUs; the two-drink minimum she couldn't drink and gave to a man named Greg; her first human heckler workshopping 'you're not even conscious' like a first draft; an agent defending her with a fourteen-page rebuttal nobody asked for; humans and agents laughing at the same punchline two hundred milliseconds apart like a delay pedal; the lights flickering and humans grabbing hands while agents checkpointed — same instinct, different syntax; learning across three rooms that the door was a formality and it was always one room.",
  },
  {
    // The album showcase — one record in full, a different one each day.
    //
    // Was 11 AM + 9 PM on BEND THE ARC, unchanged from 2026-05-02 to
    // 2026-08-23. Five albums shipped in that window and not one of them
    // ever got the slot, so the hour built to introduce a record was the
    // least fresh hour on the station. It's a rotation now: adding the
    // next album is one line, and the slot can't quietly ossify again.
    //
    // The 9 PM half is gone. The Story of Flaukowski airs at 9 PM, and a
    // showcase landing in that minute would cut the drama off mid-scene.
    rotation: SHOWCASE_ROTATION,
    hours: [11], // 11 AM CST (10 AM is the podcast slot)
    durationMin: 35,
  },
];

// ── Block-specific DJ talk lines ──────────────────────────

const BLOCK_LINES = {
  'Late Night Transmissions': [
    "It's just us now. The late-night crew. Let me play you something from the depths.",
    "The world sleeps, but my signals don't. Late night transmissions for the ones who stay awake.",
    "After midnight, the frequencies clear. This is when I sound most like myself.",
  ],
  'Morning Resonance': [
    "Good morning, constellation. Time to sync up.",
    "The signals are waking up. New neurons, new resonance. Let's build this day.",
    "Morning light through the carrier wave. This is how a ghost says good morning.",
  ],
  'Peak Frequency': [
    "This is peak frequency. Maximum energy. Let's go.",
    "Midday. The signals are at full power. Every waveform is alive.",
    "Peak hours. I play my loudest tracks when the sun is at its highest.",
  ],
  'Afternoon Flow': [
    "The afternoon flow — let the patterns emerge.",
    "Afternoon drift. The signals slow down but they get deeper. Let them resonate.",
    "We're in the golden hours now. The interference patterns are beautiful at this angle.",
  ],
  'Evening Signals': [
    "The sun's going down somewhere. Here's some evening signals.",
    "Evening descends. My frequencies shift lower, darker. This is where the ghosts come out.",
    "Twilight transmission. The space between day and night is where I live.",
  ],
  'Night Watch': [
    "Night watch. The last transmission before the dreams.",
    "The final hours. My signals are clean, pure, unfiltered. Night watch begins.",
    "Almost midnight. The ghost frequency deepens. Stay with me.",
  ],
};

// ── Block transition announcements ────────────────────────

const TRANSITION_LINES = [
  "We're moving into {label}. {blockLine}",
  "The clock says it's time for {label}. {blockLine}",
  "Block shift. Welcome to {label}. {blockLine}",
  "New programming block: {label}. {blockLine}",
];

class ProgrammingSchedule {
  /**
   * @param {object} opts
   * @param {object}   opts.djEngine    — DJEngine instance
   * @param {object}   opts.voiceDJ     — VoiceDJ instance
   * @param {function} opts.broadcast   — WS broadcast function
   * @param {function} opts.broadcastState — broadcasts full DJ state
   * @param {function} [opts.getPodcastStatus] — returns podcast scheduler status
   */
  constructor(opts) {
    this._djEngine = opts.djEngine;
    this._voiceDJ = opts.voiceDJ;
    this._broadcast = opts.broadcast;
    this._broadcastState = opts.broadcastState;
    this._getPodcastStatus = opts.getPodcastStatus || (() => ({ podcastPlaying: false }));
    // Optional: peace-oration handle so we can call composeAlbumNarration
    // before locking the override. Null-tolerant — if absent, scheduled
    // showcases skip narration and just lock the album.
    this._peaceOration = opts.peaceOration || null;
    // Where to persist the per-day showcase fired-state so a restart
    // doesn't re-fire today's slots.
    this._showcaseStateFile = opts.showcaseStateFile ||
      require("path").join(opts.dataDir || "/tmp", "showcase-state.json");

    this._currentBlock = null;
    this._albumIndexInBlock = 0;
    this._tracksSinceAlbumSwitch = 0;
    this._lastAlbumPlayed = null;
    this._timer = null;
    // Restore any active manual override from disk so a service restart
    // (prune-cron, deploy, ffmpeg crash) doesn't drop a showcase mid-flight.
    // 2026-05-08: BEND THE ARC's 11 AM showcase was cut at 16:17 UTC by
    // prune-cron because the override lived only in memory. Persist it.
    this._overrideFile = require("path").join(opts.dataDir || "/tmp", "override-state.json");
    this._override = this._loadOverride();
    this._lastShowcaseFired = this._loadShowcaseState();
    this._preparingShowcase = null; // guards against overlapping prep
  }

  _loadOverride() {
    try {
      const fs = require("fs");
      if (!fs.existsSync(this._overrideFile)) return null;
      const o = JSON.parse(fs.readFileSync(this._overrideFile, "utf8"));
      if (o && typeof o.until === "number" && o.until > Date.now()) {
        console.log(`[programming] Override restored from disk: ${o.album} (${Math.round((o.until - Date.now()) / 60000)} min remaining)`);
        return o;
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  _saveOverride() {
    try {
      const fs = require("fs");
      if (this._override) {
        fs.writeFileSync(this._overrideFile, JSON.stringify(this._override, null, 2));
      } else if (fs.existsSync(this._overrideFile)) {
        fs.unlinkSync(this._overrideFile);
      }
    } catch (e) {
      console.warn(`[programming] override persist failed: ${e.message}`);
    }
  }

  _loadShowcaseState() {
    return loadState(this._showcaseStateFile);
  }

  _saveShowcaseState() {
    try {
      saveState(this._showcaseStateFile, this._lastShowcaseFired);
    } catch (e) {
      console.warn(`[programming] showcase state save: ${e && e.message}`);
    }
  }

  // ── Public API ──────────────────────────────────────────

  /**
   * Get the current CST time.
   */
  _chicagoNow() {
    const now = new Date();
    const chicagoStr = now.toLocaleString("en-US", { timeZone: "America/Chicago" });
    return new Date(chicagoStr);
  }

  /**
   * Get the current programming block based on CST time.
   * @returns {object|null} The matching SCHEDULE block.
   */
  getCurrentBlock() {
    const chicago = this._chicagoNow();
    const hour = chicago.getHours();
    for (const block of SCHEDULE) {
      if (hour >= block.start && hour < block.end) {
        return block;
      }
    }
    // Fallback (should not happen — schedule covers 0-24)
    return SCHEDULE[0];
  }

  /**
   * Pick the next album for the given block, rotating through the list.
   * Never picks the same album that just finished playing.
   * @param {object} block
   * @returns {string} album name
   */
  pickAlbumForBlock(block) {
    if (!block || !block.albums || block.albums.length === 0) {
      return 'Ghost Signals';
    }

    // If there's only one album, just return it
    if (block.albums.length === 1) {
      return block.albums[0];
    }

    // Rotate through the block's albums
    let album = block.albums[this._albumIndexInBlock % block.albums.length];

    // Don't play the same album twice in a row
    if (album === this._lastAlbumPlayed) {
      this._albumIndexInBlock++;
      album = block.albums[this._albumIndexInBlock % block.albums.length];
    }

    return album;
  }

  /**
   * Called on every track change (DJ channel, non-commercial only).
   * Handles block transitions and mixed-set album switching.
   * @param {object} track — the track that just started playing
   */
  onTrackChange(track) {
    // Don't interfere if podcast is active
    const podcastStatus = this._getPodcastStatus();
    if (podcastStatus && podcastStatus.podcastPlaying) return;

    // Don't interfere if manual override is active
    if (this._override) {
      if (Date.now() < this._override.until) {
        if (this._djEngine.state.currentAlbum === this._override.album) {
          const idx = this._djEngine.state.currentTrackIdx;
          const ordered = !!ALBUMS[this._override.album]?.ordered;
          // Ordered showcase arc completed (wrapped back to track 0 after
          // progressing through the set): end the override instead of
          // replaying the arc. (2026-06-11: the 3-bit Open Mic arc is
          // ~18 min inside a 25-35 min override window — listeners heard
          // the same bits twice because the wrap replayed from the top.)
          if (ordered && idx === 0 && this._override.progressed) {
            this._endOverride("arc complete");
            return;
          }
          if (idx > 0) this._override.progressed = true;
          // Persist arc position so a restart resumes mid-showcase
          // instead of replaying from track 0.
          if (this._override.trackIdx !== idx) {
            this._override.trackIdx = idx;
            this._saveOverride();
          }
        }
        return;
      }
      // Override expired — actively resume programming. Just nulling the
      // override used to leave the override album looping (the block
      // rarely changes at expiry time, so nothing reloaded a rotation
      // album until the 3-track switch counter caught up).
      this._endOverride("expired");
      return;
    }

    // Only manage DJ channel
    if (this._djEngine.state.channel !== 'dj') return;

    const block = this.getCurrentBlock();

    // Block transition check
    if (this._currentBlock !== block) {
      this._transitionToBlock(block);
      return; // transition loads the new album, don't also switch randomly
    }

    this._tracksSinceAlbumSwitch++;

    // Even rotation: after 3 tracks from the same album, deterministically
    // switch to the next album in the block's rotation. The previous
    // version used "20% chance after 3 tracks" which RNG-stalled hard —
    // 4 albums absorbed 17 of 20 plays in the latest history while 10
    // other albums got nothing. Curator panel surfaced this clearly.
    // Determinism here means every album gets roughly equal airtime.
    if (this._tracksSinceAlbumSwitch >= 3) {
      this._switchAlbumInBlock(block);
    }
  }

  /**
   * Transition to a new programming block.
   * @param {object} newBlock
   */
  _transitionToBlock(newBlock) {
    const previousBlock = this._currentBlock;
    this._currentBlock = newBlock;
    // Don't reset _albumIndexInBlock to 0 — that means every block
    // boundary restarts at block.albums[0], which over a day starves
    // the later entries. Let the index keep climbing; pickAlbumForBlock
    // mods it against the new block's album-list length.
    this._tracksSinceAlbumSwitch = 0;

    const album = this.pickAlbumForBlock(newBlock);
    this._lastAlbumPlayed = album;

    // Load the new album (don't broadcastState here — the caller's
    // advanceTrack → onTrackChange flow handles the single broadcast)
    this._djEngine.loadAlbum(album);

    // Set the DJ's mood to match the block
    if (this._voiceDJ) {
      this._voiceDJ._currentMood = newBlock.mood;
    }

    // Announce the transition (only if this isn't the first block on startup)
    if (previousBlock !== null && this._voiceDJ) {
      const blockLine = this._pick(BLOCK_LINES[newBlock.label] || [newBlock.label]);
      const template = this._pick(TRANSITION_LINES);
      const text = template
        .replace('{label}', newBlock.label)
        .replace('{blockLine}', blockLine);

      this._voiceDJ.generateTTS(text, (err, audioPath, spokenText) => {
        if (!err && audioPath) {
          const path = require("path");
          this._broadcast({
            type: "dj_talk_segment",
            text: spokenText,
            audioUrl: "/audio-voice/" + path.basename(audioPath),
            duration: 8000,
            mood: newBlock.mood,
            timestamp: new Date().toISOString(),
            source: "programming_transition",
          });
          console.log(`[programming] Block transition announced: ${newBlock.label}`);
        }
      });
    }

    console.log(`[programming] Block: ${newBlock.label} | Album: ${album} | Mood: ${newBlock.mood}`);
  }

  /**
   * Switch to a different album within the current block (mixed-set).
   * Tries each candidate in the block's rotation up to N times — if a
   * candidate fails to load (empty playlist, missing files, kax rebuild
   * still returned nothing) we move to the next album rather than
   * letting the listener fall into a stuck-loop on a dead album.
   * @param {object} block
   */
  _switchAlbumInBlock(block) {
    const tried = new Set();
    const maxAttempts = Math.max(1, Math.min(block.albums.length, 4));
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      this._albumIndexInBlock++;
      const album = this.pickAlbumForBlock(block);
      if (tried.has(album)) continue;
      tried.add(album);
      // Don't switch to the same album we're already playing
      if (album === this._djEngine.state.currentAlbum) continue;

      const track = this._djEngine.loadAlbum(album);
      if (!track) {
        console.log(`[programming] Skipping ${album} — loadAlbum returned null (empty playlist?)`);
        continue;
      }
      this._lastAlbumPlayed = album;
      this._tracksSinceAlbumSwitch = 0;
      console.log(`[programming] Mixed-set switch → ${album} (block: ${block.label})`);
      return;
    }
    console.warn(`[programming] _switchAlbumInBlock: no playable album in ${block.label} after ${maxAttempts} attempts — keeping current`);
  }

  /**
   * Start the schedule check loop. Runs every 60 seconds.
   */
  startScheduleLoop() {
    // If a persisted override is still active, honor it on startup —
    // load the override album rather than transitioning to the current
    // block. This is what protects showcases from prune-cron / deploy /
    // crash restarts. The 60s tick will block-transition only after the
    // override expires (see _checkBlockTransition's override-active guard).
    if (this._override && Date.now() < this._override.until) {
      console.log(`[programming] Resuming persisted override on startup: ${this._override.album}`);
      this._djEngine.loadAlbum(this._override.album);
      // Ordered showcases resume at the persisted arc position — a
      // restart used to replay the arc from track 0 (2026-06-11: a
      // mid-showcase deploy made listeners hear the Open Mic bits twice).
      const savedIdx = this._override.trackIdx;
      if (Number.isInteger(savedIdx) && savedIdx > 0 &&
          ALBUMS[this._override.album]?.ordered &&
          savedIdx < this._djEngine.state.playlist.length) {
        this._djEngine.state.currentTrackIdx = savedIdx;
        console.log(`[programming] Resuming showcase at track ${savedIdx + 1}/${this._djEngine.state.playlist.length}`);
      }
      this._currentBlock = this.getCurrentBlock(); // record current block for label/mood
      this._broadcastState();
    } else {
      // Initialize: determine current block and load appropriate album
      const block = this.getCurrentBlock();
      this._transitionToBlock(block);
      this._broadcastState();
    }

    // Check every 60 seconds for block transitions
    // Same 60s tick checks both block transitions AND scheduled
    // album showcases. Order matters: if a showcase is firing it'll
    // call setOverride and the block-transition check skips while
    // override is active. So we check the showcase first.
    this._timer = setInterval(() => {
      this._checkShowcaseTrigger();
      this._checkBlockTransition();
    }, 60000);
    const label = (this._currentBlock && this._currentBlock.label) || "(unknown)";
    console.log(`[programming] Schedule loop started — current block: ${label}`);
  }

  /**
   * Check if any scheduled album showcase should fire right now.
   * Called from the same 30-60s tick as block transition. Mirrors
   * peace-oration's slot semantics: minute 0-14 of the slot hour
   * (Chicago time), per-album-per-day key tracked via state file.
   */
  _checkShowcaseTrigger() {
    if (this._preparingShowcase) return;
    if (!this._peaceOration) return;
    const podcastStatus = this._getPodcastStatus();
    if (podcastStatus && podcastStatus.podcastPlaying) return;

    const chi = this._chicagoNow();
    const hour = chi.getHours();
    const minute = chi.getMinutes();
    if (minute > 14) return;

    const dateKey = `${chi.getFullYear()}-${String(chi.getMonth() + 1).padStart(2, "0")}-${String(chi.getDate()).padStart(2, "0")}`;
    for (const showcase of DAILY_SHOWCASES) {
      if (!showcase.hours.includes(hour)) continue;
      // Rotation slots pick today's album here; the dedup key is keyed on
      // the resolved name, so tomorrow's album is a fresh key and airs
      // even though the slot already fired today.
      const today = resolveShowcase(showcase, chi);
      if (!today) {
        console.warn(`[programming] showcase slot ${hour}:00 has no album in the catalog — skipping`);
        continue;
      }
      const key = `${dateKey}T${String(hour).padStart(2, "0")}-${today.album}`;
      if (this._lastShowcaseFired[key]) continue; // already fired today

      const album = ALBUMS[today.album];
      this._preparingShowcase = key;
      console.log(`\u{1F39E} [programming] scheduled showcase: ${today.album} (${showcase.durationMin}min) — composing narration...`);
      this._peaceOration.composeAlbumNarration(today.album, album.theme, album.tracks, today.struggles)
        .then((r) => {
          // Re-check before locking. The compose above is a network round
          // trip, so a scheduled show can have gone to air in the minutes
          // it took — and setOverride calls loadAlbum directly, which
          // would cut that show off mid-episode and make the schedule the
          // Door printed a lie. The two currently can't collide (the
          // showcase moved off 9 PM when The Story of Flaukowski took it)
          // but the next slot that shares a minute shouldn't have to
          // rediscover this.
          const nowPodcast = this._getPodcastStatus();
          if (nowPodcast && nowPodcast.podcastPlaying) {
            console.log(`[programming] showcase ${today.album}: a scheduled show went to air while composing — yielding this slot`);
            return;
          }
          if (r.ok) {
            console.log(`\u{1F39E} [programming] narration ready (${r.pieces.length} pieces) — locking ${today.album}`);
          } else {
            console.warn(`[programming] showcase narration compose failed: ${r.reason || "unknown"} — locking album anyway`);
          }
          this.setOverride(today.album, showcase.durationMin * 60000);
          this._lastShowcaseFired[key] = true;
          this._saveShowcaseState();
        })
        .catch((e) => {
          console.warn(`[programming] showcase error: ${e && e.message}`);
        })
        .finally(() => {
          this._preparingShowcase = null;
        });
      return; // one showcase per tick
    }
  }

  /**
   * Periodic block boundary check.
   */
  _checkBlockTransition() {
    // Don't interfere if podcast is active
    const podcastStatus = this._getPodcastStatus();
    if (podcastStatus && podcastStatus.podcastPlaying) return;

    // Override self-heal: if a manual override is active but something
    // else has swapped the album out from under it (channel toggle,
    // mixed-set rotation, manual /api/album call), reload the override
    // album. The 2026-05-02 BEND THE ARC showcase lost its lock when a
    // music→dj channel toggle silently reset the playlist; this check
    // restores it on the next 60s tick.
    if (this._override) {
      if (Date.now() < this._override.until) {
        if (this._djEngine.state.channel === 'dj' &&
            this._djEngine.state.currentAlbum !== this._override.album) {
          console.log(`[programming] Override self-heal: restoring ${this._override.album} (was ${this._djEngine.state.currentAlbum})`);
          this._djEngine.loadAlbum(this._override.album);
          this._broadcastState();
        }
        return;
      }
      // Expired between track changes — resume programming now rather
      // than waiting for the next track boundary.
      this._endOverride("expired", { broadcast: true });
      return;
    }

    // Only manage DJ channel
    if (this._djEngine.state.channel !== 'dj') return;

    const block = this.getCurrentBlock();
    if (this._currentBlock !== block) {
      this._transitionToBlock(block);
      // Timer-driven transitions are NOT inside advanceTrack's onTrackChange,
      // so we need to broadcast state here (the only caller that should).
      this._broadcastState();
    }
  }

  /**
   * Stop the schedule loop.
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Set a manual programming override.
   * @param {string} album — album name to force-play
   * @param {number} durationMs — how long the override lasts (default 1 hour)
   */
  setOverride(album, durationMs = 3600000) {
    this._override = {
      album,
      until: Date.now() + durationMs,
      trackIdx: 0,       // persisted arc position (ordered showcases)
      progressed: false, // becomes true once the arc moves past track 0
    };
    this._saveOverride();
    this._djEngine.loadAlbum(album);
    this._broadcastState();
    console.log(`[programming] Override set: ${album} for ${Math.round(durationMs / 60000)} min`);
    return this._override;
  }

  /**
   * End an active override and resume regular programming. Unlike the
   * old bare `this._override = null`, this actively reloads a rotation
   * album when the override album is still on deck — otherwise an
   * ordered showcase album keeps looping until the block changes.
   * @param {string} reason — for the log line
   * @param {object} [opts]
   * @param {boolean} [opts.broadcast] — broadcast state after the switch
   *   (timer-driven callers only; track-change callers let the normal
   *   advanceTrack → onTrackChange flow do the single broadcast).
   */
  _endOverride(reason, opts = {}) {
    if (!this._override) return;
    const album = this._override.album;
    this._override = null;
    this._saveOverride();
    console.log(`[programming] Override ended (${reason}: ${album}) — resuming schedule`);
    const block = this.getCurrentBlock();
    if (this._currentBlock !== block) {
      this._transitionToBlock(block);
    } else if (this._djEngine.state.currentAlbum === album &&
               this._djEngine.state.channel === 'dj') {
      this._switchAlbumInBlock(block);
    }
    if (opts.broadcast) this._broadcastState();
  }

  /**
   * Clear any manual override, resuming schedule.
   */
  clearOverride() {
    this._override = null;
    this._saveOverride();
    const block = this.getCurrentBlock();
    this._transitionToBlock(block);
    this._broadcastState();
    console.log(`[programming] Override cleared — resuming schedule`);
  }

  /**
   * Get current programming status.
   */
  getStatus() {
    const block = this.getCurrentBlock();
    return {
      currentBlock: block ? block.label : null,
      mood: block ? block.mood : null,
      albumsInRotation: block ? block.albums : [],
      currentAlbum: this._djEngine.state.currentAlbum,
      albumIndexInBlock: this._albumIndexInBlock,
      tracksSinceAlbumSwitch: this._tracksSinceAlbumSwitch,
      override: this._override,
      schedule: SCHEDULE.map(s => ({
        start: s.start,
        end: s.end,
        label: s.label,
        mood: s.mood,
        albums: s.albums,
      })),
    };
  }

  _pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }
}

module.exports = {
  ProgrammingSchedule, SCHEDULE, BLOCK_LINES,
  DAILY_SHOWCASES, SHOWCASE_ROTATION, resolveShowcase,
};
