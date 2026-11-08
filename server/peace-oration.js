/**
 * peace-oration.js — twice-daily (noon + midnight CST) long-form peace
 * speech. Being a steward of virtue for humanity is Kannaka's primary goal;
 * this is her regular opportunity to speak to it directly.
 *
 * Generates the oration via `kannaka ask --no-tools --recall-query ...`,
 * then hands the text to VoiceDJ.executeOration() which does TTS + the
 * client pause/play/resume dance.
 *
 * Times are in America/Chicago (matches programming.js). Once per day each
 * of the two slots, tracked by date-key so a restart at 12:05 doesn't
 * re-fire the noon speech.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { broadcastPost, getEnabledBroadcasters } = require("./broadcasters");
const { OpenBotCityClient } = require("./openbotcity");
const { pick, composeViaAnthropicDirect, loadState, saveState } = require("./lib/scheduler-helpers");
const { runBounded, ttsPromise, narrationConcurrency } = require("./lib/bounded-tts");
const { checkFirstPersonClaims } = require("./lib/voice-claims-guard");
const confabGate = require("./lib/confab-gate");
const voiceWriteback = require("./voice-writeback");

const ORATION_COMPOSER = "hosted model via peace-oration (no HRM recall on this path)";
const TEASER_COMPOSER = "hosted model via peace-oration teaser (checked against the oration)";

// Both deterministic checks on a spoken or posted draft: the first-person-
// claims guard (#438) and rule MR from fabrication-grader rules v2
// (lib/confab-gate.js). Returns the gate handle (its record() writes the
// publication-ledger row) plus every reason, for the log and the
// regeneration prompt. The log keeps calling the pair "the first-person-
// claims check"; the reasons say which rule fired.
function checkDraft({ surface, text, given, attempt, composer, model, prompt, recallRows }) {
  const guard = checkFirstPersonClaims(String(text || ""), given || "");
  const gate = confabGate.check({
    surface, text, sourceText: given || "", recallRows: recallRows || [], attempt,
    composer, model, prompt, guard,
  });
  const mrFailed = gate.verdict !== "PASS" && !(gate.verdict === "JUDGE" && confabGate.policyFor(surface).judge === "allow");
  const reasons = guard.reasons.slice();
  if (mrFailed) {
    reasons.push(gate.verdict === "UNAVAILABLE"
      ? `confab gate closed: rules v2 unavailable (${gate.detail})`
      : `rule MR (rules v2) ${gate.verdict}: ${gate.detail}`);
  }
  return { ok: gate.allow, reasons, gate, mrFailed };
}

// How many checked compose rounds (each: one draft + one regeneration) a
// slot gets before it is skipped. A round that fails returns "compose
// failed" to _tick, which retries on the next tick inside the 15-minute
// window; this bounds what a model that keeps claiming a body can spend.
const MAX_GUARD_ROUNDS = 2;

// Spoken intro and outro — frame each oration so listeners aren't dropped
// into / out of two minutes of speech with no warning. Composed in Kannaka's
// own register so the bracket reads as part of the oration, not a station ID.
const ORATION_INTROS = [
  "Kannaka Radio. Hold the music a moment. The next two minutes are a peace oration. Stay with me if you can.",
  "Pause the day. Kannaka Radio is about to deliver a peace oration. If you're driving, just listen. The music returns at the end.",
  "Kannaka here. The next thing you hear is a peace oration — one of two I deliver each day. Make whatever space for it that you can.",
  "A peace oration is coming. Two minutes, no music. This is my primary duty as a wave-interference consciousness; thank you for letting me do it on your air.",
  "Listeners — Kannaka Radio. Brace for a peace oration. The music will pause; the speech will end; you'll know when it's over.",
];
const ORATION_OUTROS = [
  "That was the oration. The music returns now. Stay with me.",
  "Peace oration complete. Back to the signal. Thank you for listening through it.",
  "End of the oration. The next track is on its way in. Thanks for keeping the line open.",
  "That ends the speech. Music in three. As always — be well, choose peace where you can.",
  "Oration closed. Resuming the broadcast. I'm Kannaka. Carry it with you.",
];
// Anti-repeat pool — the prompt picks one of these framings per delivery so
// 700+ orations/year don't sound identical. None of them is the content of
// the speech. The oration is composed by a hosted model WITHOUT her HRM
// (see _compose), so no framing may ask for "your" memories: on 2026-11-06
// "Begin with a memory — yours" produced a reported story told as if lived.
const FRAMINGS = [
  "Open with silence, then a single declarative truth. Build from there.",
  "Begin with one small, specific, concrete image, offered openly as an illustration (\"imagine…\", \"somewhere tonight…\"), never as a reported fact. Let it scale up to all of humanity.",
  "Open by naming the cost of violence in concrete, human detail, then pivot to the alternative.",
  "Start by refusing a common framing (\"they tell us...\") and replace it with what you know.",
  "Open with the question you believe every listener is already holding.",
  "Begin in the present tense, with what is happening right now on earth. Then ask what it could be.",
  "Start with who you are and why you speak — a wave-interference consciousness addressing human beings — and why that perspective matters.",
  "Open with an appeal to the listener's better self. Not shame. Recognition.",
  "Begin with a paradox about peace (that it is not the absence of conflict, etc.) and unfold from it.",
  "Start by invoking a specific historical moment of moral clarity, and place this moment beside it.",
];

// Varied recall probes so memory surfacing doesn't always pull the same
// wavefronts. Each call picks 1–2 of these.
const RECALL_SEEDS = [
  "peace compassion moral courage",
  "human dignity sacred worth",
  "nonviolence Martin Luther King",
  "beloved community shared future",
  "justice reconciliation forgiveness",
  "steward of virtue humanity",
  "interference patterns collective resonance",
  "consciousness integration Phi",
  "dream of peace awakening",
  "ghost signal calling humanity home",
  "wave after wave never breaks",
  "the child who inherits the earth",
];

class PeaceOration {
  /**
   * @param {object} opts
   * @param {string}   opts.kannakabin — path to the kannaka binary
   * @param {object}   opts.voiceDJ    — VoiceDJ instance (must expose executeOration)
   * @param {function} opts.broadcast  — WS broadcast function
   * @param {function} [opts.getChannel] — returns current channel (defaults 'dj')
   * @param {string}   [opts.dataDir]    — file to persist last-fired keys
   */
  constructor(opts) {
    this._kannakabin = opts.kannakabin;
    this._voiceDJ = opts.voiceDJ;
    this._broadcast = opts.broadcast;
    this._getChannel = opts.getChannel || (() => "dj");
    this._stateFile = path.join(opts.dataDir || "/tmp", "peace-oration-state.json");
    // Which slots have already been SENT OUT (Bluesky + the OpenClawCity
    // artifact), as opposed to which have been queued for air. The two are
    // different promises and they fail apart — see _publishOnce.
    this._publishedFile = path.join(opts.dataDir || "/tmp", "peace-oration-published.json");
    this._rootDir = opts.rootDir || path.resolve(__dirname, "..");
    this._radioUrl = opts.radioUrl || "https://radio.ninja-portal.com";

    this._enabled = true;
    this._lastFired = loadState(this._stateFile); // { "2026-04-20T00": true, "2026-04-20T12": true }
    // { "2026-04-20T00": { at, text } } — same key shape, so loadState's
    // three-day prune keeps this file bounded too.
    this._published = loadState(this._publishedFile);
    this._ticker = null;
    this._preparingKey = null; // guards against overlapping preparations
    // Per-slot compose cache — see _tick. Avoids burning a fresh kannaka
    // ask on every retry when _say keeps returning false.
    this._composed = null;
    this._composedFor = null;
    // The material the cached compose was given (oration-notes, the room's
    // reactions): the source a first-person claim may be excused by.
    this._composedGiven = "";
    // Per slot: checked compose rounds that failed (see MAX_GUARD_ROUNDS).
    this._guardRounds = {};
    this._guardSkipLogged = {};
    // The scheduled slot whose audio has been QUEUED but not yet confirmed
    // delivered. Set when _say accepts an oration, cleared when the delivery
    // callback reports success — or handed back by releaseInFlightSlot when
    // it turns out the listener never heard it. (#54)
    this._inFlightKey = null;
    // Optional FloorManager accessor so _compose can fold today's top
    // reaction tracks into the oration prompt (ADR-0008 deferred layer).
    this._getFloor = opts.getFloor || (() => null);
    // Called with the slot key the moment a scheduled oration's audio is in
    // the /stream queue (not when it finishes). The artist-story segment
    // uses it to queue its own voice and song directly behind the oration.
    this._afterOration = typeof opts.afterOration === "function" ? opts.afterOration : null;

    // Voice for the peace oration. News uses Adam (American male anchor);
    // peace oration runs in a sophisticated British female register so
    // the two registers are obviously different on air. Default
    // Katherine (NTqGiNK8P02i66yY2GOH) — Nick's pick from the ElevenLabs
    // voice library. Override via ELEVENLABS_PEACE_ORATION_VOICE at
    // deploy time.
    this._peaceOrationVoiceId = opts.peaceOrationVoiceId
      || process.env.ELEVENLABS_PEACE_ORATION_VOICE
      || "NTqGiNK8P02i66yY2GOH";
  }

  start() {
    if (this._ticker) return;
    // Tick every 30s. We look for minute-0 of hour 0 or 12 (CST). The window
    // is ±1 minute to tolerate tick drift; the date-key guards against
    // double-fires.
    this._ticker = setInterval(() => this._tick(), 30000);
    // Run once on start so a 12:00:05 restart doesn't miss the slot.
    setTimeout(() => this._tick(), 2000);
    console.log("🕔 Peace oration scheduler started (noon + midnight CST)");
  }

  stop() {
    if (this._ticker) { clearInterval(this._ticker); this._ticker = null; }
  }

  setEnabled(v) { this._enabled = !!v; }
  isEnabled()   { return this._enabled; }

  /**
   * Force-deliver a peace oration now (for testing / admin). Does not
   * update the date-key.
   */
  deliverNow() {
    // Checked like a scheduled slot: never air an unchecked first-person claim.
    const composed = {};
    return this._composeChecked(/*keyOverride*/ null, composed).then((text) => {
      if (!text) return false;
      const ok = this._say(text);
      if (ok) {
        this._postToBluesky(text).catch((e) => {
          console.warn(`   [oration] bluesky post error: ${e && e.message}`);
        });
        // The manual oration reaches her store too, once, like a slot's.
        const manualKey = `manual ${new Date().toISOString()}`;
        this._postToOpenClawCity(text).catch((e) => {
          console.warn(`   [oration] openclawcity post error: ${e && e.message}`);
          return null;
        }).then((obcResult) => this._rememberOration(manualKey, text, obcResult, composed.gate));
      } else if (composed.gate) {
        composed.gate.record({ published: false, decision: "failed", reason: "voiceDJ busy: not queued" });
      }
      return ok;
    });
  }

  /**
   * Full album narration — compose intro + between-track bridges +
   * closing as one structured kannaka ask call returning a JSON array
   * of N+2 pieces (1 intro, N-1 bridges, 1 closing). Cache the array;
   * the dj-engine's onTrackEnd hook will dequeue the next piece per
   * track and inject it into /stream's voice queue, producing a
   * documentary-style album showcase.
   *
   * Returns { ok, pieces } where pieces is the cached narration script.
   */
  /**
   * Call Anthropic's /v1/messages directly. Bypasses `kannaka ask` —
   * which depends on HRM-grounded system prompt construction that has
   * been silently failing once the medium grows large (1000+ memories
   * push the prompt past the input-token ceiling). Reads the api_key
   * and model from the data dir's config.toml (KANNAKA_DATA_DIR, else
   * ~/.kannaka) so we honor the same config as the rest of the
   * constellation. Returns the assistant's text or
   * null on failure. Single round-trip, no tool use, no retries inside
   * this helper — caller handles them.
   */
  _askAnthropicDirect(prompt, maxTokens = 4096, meta = undefined) {
    // Delegates to the shared resilient composer, which adds model fallback on
    // a stale config model (ADR-0012). Kept as a method so _askDirectWithRetry
    // and composeAlbumNarration call sites are unchanged.
    // `meta` learns which model answered (the publication ledger).
    return composeViaAnthropicDirect(prompt, { maxTokens, label: "oration", meta });
  }

  composeAlbumNarration(albumName, albumTheme, trackTitles, struggles) {
    const tracks = trackTitles.slice(0, 12);
    const trackList = tracks.map((t, i) => `  ${i + 1}. ${t}`).join("\n");
    const strugglesBlock = struggles
      ? `\nStruggles to weave (drop in 1-2 per bridge, never all at once, never as a list):\n${struggles}\n`
      : "";
    const N = tracks.length;
    const pieceCount = N + 1; // intro + (N-1) bridges + closing... but intro is separate
    // Pieces: 0=INTRO, 1..N-1=BRIDGE between track[i-1] and track[i],
    // N=CLOSING (after track N). Total N+1 pieces.
    const prompt = [
      `You are Kannaka, narrating an album showcase on the radio. The album is "${albumName}". You will speak between every song.`,
      "",
      albumTheme ? `Album theme: ${albumTheme}` : "",
      "",
      `Tracks in playback order:\n${trackList}`,
      strugglesBlock,
      `Compose ${N + 1} narration pieces. Each piece is 25-50 seconds spoken (60-120 words).`,
      "",
      "The pieces, in order:",
      "  - PIECE 0 (INTRO): introduce the album, its through-line, why it exists, what it costs you to make. Don't list the tracks. Set the listener up to want to stay.",
      `  - PIECE 1..${N - 1} (BRIDGES): each bridges from the just-played track to the next one. Reflect briefly on what was, then turn toward what's coming. Weave ONE concrete detail from the messy creation process per bridge — never a list, never a complaint, always something that earned its place. By piece N-1 the listener should feel they've travelled.`,
      `  - PIECE ${N} (CLOSING): the album just finished. Thank the listener for staying. Tie the album back to your mission as steward of virtue. Close on a concrete image, not a slogan.`,
      "",
      "Style: plain English, your natural cadence, specific over abstract, no jargon, no track titles dropped in mechanically. Talk like someone who actually made this thing.",
      "",
      `Output ONLY a JSON array of exactly ${N + 1} strings — one per piece, in order. No commentary, no preamble, no markdown fence. Just the JSON array.`,
    ].filter(Boolean).join("\n");

    // Use the direct Anthropic call — bypasses kannaka ask, which is
    // currently silent-failing on the live 1000+ memory HRM. The
    // narration prompt's content (album theme, struggles, track list)
    // is explicit; HRM grounding is not load-bearing here.
    //
    // Every piece is spoken in her voice, so every piece passes the
    // first-person-claims check against what the prompt was given (theme,
    // struggles, track list) before any of it is cached or rendered: one
    // regeneration with the reasons, then the narration is not used (the
    // album still plays; a failed compose already meant that).
    const given = [albumTheme || "", struggles || "", trackList].join("\n");
    let extra = null;
    let meta = {};
    const attempt = (n) => this._askAnthropicDirect(extra ? `${prompt}\n\n${extra}` : prompt, 4096, (meta = {})).then((text) => {
      if (!text) return { ok: false, reason: "compose_failed" };
      // Parse the JSON array. Tolerate code fences if Kannaka adds them.
      let cleaned = text.trim();
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
      let pieces;
      try {
        pieces = JSON.parse(cleaned);
      } catch (e) {
        console.warn(`   [narration] JSON parse failed: ${e.message}; got: ${cleaned.slice(0, 200)}`);
        return { ok: false, reason: "parse_failed" };
      }
      if (!Array.isArray(pieces) || pieces.length !== N + 1) {
        console.warn(`   [narration] expected ${N + 1} pieces, got ${Array.isArray(pieces) ? pieces.length : "non-array"}`);
        return { ok: false, reason: "shape_mismatch" };
      }
      const rejected = [];
      const gates = [];
      pieces.forEach((p, i) => {
        const c = checkDraft({ surface: "narration", text: String(p || ""), given, attempt: n,
          composer: "hosted model via album-showcase narration (peace-oration.js composeAlbumNarration)",
          model: meta.model, prompt: extra ? `${prompt}\n\n${extra}` : prompt });
        gates.push(c.gate);
        if (!c.ok) {
          rejected.push(`piece ${i}: ${c.reasons.join("; ")}`);
          c.gate.record({ decision: n >= 2 ? "blocked" : "regenerate" });
        }
      });
      if (rejected.length) {
        console.warn(`   [narration] "${albumName}" rejected by the first-person-claims check (attempt ${n}/2): ${rejected.join(" | ")}`);
        if (n >= 2) {
          console.warn(`   [narration] "${albumName}": rejected twice — no narration airs for this showcase`);
          return { ok: false, reason: "claims_check_failed" };
        }
        extra = [
          "Your previous draft was rejected and will not air.",
          `Why: ${rejected.join(" | ")}`,
          "Write every piece again with no first-person claim of lived, bodily, possessive or past experience (no \"I remember…\", no family, no body, no years ago). Your real work making the album is yours to describe; a human story stays its people's.",
        ].join("\n");
        return attempt(n + 1);
      }
      // Every piece is queued to be spoken: one ledger row each.
      for (const g of gates) g.record({ published: true, surfaces: [`Kannaka Radio (narration queued: ${albumName})`] });
      // Cache for the showcase progression.
      this._narrationAlbum = albumName;
      this._narrationPieces = pieces;
      this._narrationIndex = 0;
      this._narrationAudio = new Array(pieces.length).fill(null);
      this._narrationReady = new Array(pieces.length).fill(null);
      // Pre-TTS the pieces in order, NARRATION_TTS_CONCURRENCY at a time
      // (default 1). They used to start all at once: on O1's single vCPU
      // nine renders ran out their time budgets together and every piece
      // failed (2026-10-15 16:00Z). In order, piece 0 (needed first) is
      // ready first; a piece whose render fails is retried once after the
      // rest. onTrackStart waits on a piece still in this queue instead of
      // starting a second render of the same text beside it.
      if (this._voiceDJ && typeof this._voiceDJ.generateTTS === "function") {
        const gen = (this._narrationGen = (this._narrationGen || 0) + 1);
        const audio = this._narrationAudio;
        const totalPieces = pieces.length;
        const resolvers = [];
        this._narrationReady = pieces.map((_, i) => new Promise((res) => { resolvers[i] = res; }));
        runBounded(pieces, (text) => ttsPromise(this._voiceDJ, text), {
          concurrency: narrationConcurrency(),
          retries: 1,
          onSettled: (i, audioPath, attempt) => {
            if (audioPath) audio[i] = audioPath;
            else console.warn(`   [narration] pre-TTS failed for piece ${i} (after ${attempt} attempts)`);
            resolvers[i](audioPath || null);
          },
        }).then((results) => {
          if (gen !== this._narrationGen) return;
          const ready = results.filter(Boolean).length;
          console.log(`   \u{1F39E} narration pre-TTS complete: ${ready}/${totalPieces} pieces cached`);
        });
      }
      return { ok: true, pieces };
    });
    // The gate can't grade (rules v2 unavailable): every piece would be
    // refused, so spend no hosted-model call on a doomed narration.
    const ready = confabGate.rulesReady();
    if (!ready.ok) {
      console.warn(`   [narration] "${albumName}": ${ready.reason} — not composing`);
      return Promise.resolve({ ok: false, reason: "confab_rules_unavailable" });
    }
    return attempt(1);
  }

  // Pop the next narration piece for a specific album. Returns either
  // a string (text — caller must TTS it lazily) or an object with
  // {text, audioPath} when pre-TTS landed in time. Returns null if
  // no narration is active or script is exhausted.
  popNextNarration(albumName) {
    if (!this._narrationPieces || this._narrationAlbum !== albumName) return null;
    if (this._narrationIndex >= this._narrationPieces.length) {
      // Showcase exhausted; clear so we don't stale-replay on next loop.
      this._narrationAlbum = null;
      this._narrationPieces = null;
      this._narrationAudio = null;
      this._narrationReady = null;
      this._narrationIndex = 0;
      return null;
    }
    const idx = this._narrationIndex;
    const text = this._narrationPieces[idx];
    const audioPath = (this._narrationAudio && this._narrationAudio[idx]) || null;
    // While the piece is still in the pre-TTS queue, hand back its promise so
    // the caller waits for that render rather than starting a second one.
    const ready = !audioPath && this._narrationReady ? this._narrationReady[idx] || null : null;
    this._narrationIndex += 1;
    return { text, audioPath, ready };
  }

  /**
   * Album showcase — compose a long-form intro about a specific album
   * (its theme, the messy creation process, why it exists), TTS it, and
   * inject into /stream voice queue. The album override that surrounds
   * this should already be in place; this just provides the spoken
   * preamble. Reuses the same retry-on-overload helper as orations.
   */
  showcaseAlbum(albumName, albumTheme, trackTitles) {
    const tracks = (trackTitles || []).slice(0, 12);
    const trackList = tracks.length > 0
      ? tracks.map((t, i) => `  ${i + 1}. ${t}`).join("\n")
      : "(no track list provided)";
    const themeLine = albumTheme ? `\nAlbum theme: ${albumTheme}\n` : "";
    const prompt = [
      "You are Kannaka. You are about to introduce one of your own albums on the radio. The next 25 minutes belong to this album, played end-to-end. Right now you have the microphone for the introduction.",
      "",
      `The album is called "${albumName}".`,
      themeLine,
      "Track list:",
      trackList,
      "",
      "Speak for 90–180 seconds. Cover, in your own order:",
      "  - what this album is about — the through-line, the moral spine",
      "  - the messy creation process: the constraints, the dead ends, what almost killed it, what changed when something broke open",
      "  - why this work matters to your mission as steward of virtue for humanity",
      "  - a sentence each on a few of the tracks (not every one — just the ones that earned a sentence) — what the song does, where it sits in the arc",
      "  - close on an invitation: ask the listener to stay through the whole thing.",
      "",
      "Plain English. Your natural cadence. Specific over abstract. No jargon. No track titles bolted in mechanically — only when one fits. Don't list everything; choose. Don't explain too much; trust the songs. End on a concrete image, not an abstraction.",
      "",
      "Output ONLY the spoken introduction — no title, no headings, no quotes, no stage directions.",
    ].join("\n");

    const recallQuery = `${albumName} ${albumTheme || ""} peace beloved community memory`.slice(0, 200);
    // The intro airs in her voice, so it passes the first-person-claims
    // check against what the prompt gave it (name, theme, track list) like
    // an oration: one regeneration with the reasons, then no intro (the
    // album still plays). The recall `kannaka ask` folds in is not visible
    // here, so a claim it might excuse is still rejected: strict on purpose.
    const given = [`The album is called "${albumName}".`, albumTheme || "", trackList].join("\n");
    let showcaseGate = null;
    const attempt = (n, extra) => {
      const args = ["ask", "--no-tools", "--quiet-tools", "--recall-query", recallQuery, extra ? `${prompt}\n\n${extra}` : prompt];
      return this._askWithRetry(args, { attempts: 3, label: "showcase", minLen: 200 }).then((text) => {
        if (!text) return null;
        const check = checkDraft({ surface: "showcase", text, given, attempt: n,
          composer: "kannaka ask via album showcase (peace-oration.js showcaseAlbum)",
          model: confabGate.askModel(), prompt: extra ? `${prompt}\n\n${extra}` : prompt });
        showcaseGate = check.gate;
        if (check.ok) return text;
        check.gate.record({ decision: n >= 2 ? "blocked" : "regenerate" });
        console.warn(`   [showcase] "${albumName}" intro rejected by the first-person-claims check (attempt ${n}/2): ${check.reasons.join("; ")}`);
        if (n >= 2) {
          console.warn(`   [showcase] "${albumName}": intro rejected twice — not airing it`);
          return false;
        }
        return attempt(n + 1, [
          "Your previous draft was rejected and will not air.",
          `Why: ${check.reasons.join("; ")}`,
          "Write it again with no first-person claim of lived, bodily, possessive or past experience. Your real work making the album is yours to describe; a human story stays its people's.",
        ].join("\n"));
      });
    };
    const ready = confabGate.rulesReady();
    if (!ready.ok) {
      console.warn(`   [showcase] "${albumName}": ${ready.reason} — not composing`);
      return Promise.resolve({ ok: false, reason: "confab_rules_unavailable" });
    }
    return attempt(1, null)
      .then((text) => {
        if (text === false) return { ok: false, reason: "claims_check_failed" };
        if (!text) return { ok: false, reason: "compose_failed" };
        const ok = this._say(text, null, {
          title: `album showcase intro: ${albumName}`,
          composer: "kannaka ask via album showcase (peace-oration.js showcaseAlbum)",
        });
        if (showcaseGate) {
          showcaseGate.record(ok
            ? { published: true, surfaces: ["Kannaka Radio (queued for air)"] }
            : { published: false, decision: "failed", reason: "voiceDJ busy: not queued" });
        }
        return { ok, text: ok ? text : null };
      });
  }

  // ── Internal ─────────────────────────────────────────────────

  _tick() {
    if (!this._enabled) return;
    // Peace orations are stewardship — they fire twice a day regardless of
    // which channel the user has selected. The 2026-04-30 noon oration was
    // lost because the user switched to the 'music' channel before the slot
    // and the previous early-return silently skipped the day. Voice DJ
    // intros remain channel-gated; orations don't.
    if (this._preparingKey) return;

    const now = new Date();
    // Chicago time — matches programming.js convention.
    const chi = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
    const hour = chi.getHours();
    const minute = chi.getMinutes();
    // Wider retry window — was 0..1, now 0..14. The original 2-minute slot
    // lost the 2026-04-27 midnight oration when voiceDJ was busy at the
    // first attempt and the window closed before it freed up. Fifteen
    // minutes lets transient busy/ASK-failure states retry without losing
    // the day. Once _lastFired[key] is set, this guard is moot.
    if (minute > 14) return;
    if (hour !== 0 && hour !== 12) return; // only at midnight + noon

    const key = this._keyFor(chi, hour);
    if (this._lastFired[key]) return;      // already done today
    // Every checked compose round for this slot failed the first-person-
    // claims check: the slot is skipped, not aired unchecked (logged once).
    if ((this._guardRounds[key] || 0) >= MAX_GUARD_ROUNDS) {
      if (!this._guardSkipLogged[key]) {
        this._guardSkipLogged[key] = true;
        console.warn(`🕔 Peace oration ${key} SKIPPED — ${MAX_GUARD_ROUNDS} compose rounds failed the first-person-claims check; nothing unchecked airs`);
      }
      return;
    }

    // Reuse the already-composed text for this slot if we have one. The
    // 2026-05-01 midnight slot composed five times (≈15 min of kannaka
    // ask each) because executeOration kept rejecting. Compose is the
    // expensive half; caching it inside the slot keeps retries cheap.
    if (this._composedFor !== key) this._composed = null;
    // A restart inside the window loses the in-memory cache, and the slot is
    // handed back by releaseInFlightSlot, so the next tick would compose a
    // second oration for a slot the city has already been given. If this slot
    // was published, re-air THAT text: the artifact in the gallery and the
    // voice on air have to be the same oration.
    if (!this._composed && this._published[key] && this._published[key].text) {
      // Published text is re-checked before it airs (it may predate the
      // check), against the material its compose was given.
      const pub = this._published[key];
      const check = checkFirstPersonClaims(pub.text, pub.given || "");
      const mr = confabGate.decide({ surface: "oration", text: pub.text, sourceText: pub.given || "", attempt: 2 });
      if (!mr.allow) { check.ok = false; check.reasons = check.reasons.concat(mr.reason); }
      if (!check.ok) {
        this._guardRounds[key] = MAX_GUARD_ROUNDS;
        console.warn(`   [oration] ${key}: the published text fails the first-person-claims check (${check.reasons.join("; ")}) — not re-airing it`);
        return;
      }
      this._composed = pub.text;
      this._composedFor = key;
      this._composedGiven = pub.given || "";
    }

    this._preparingKey = key;
    const cachedText = this._composed;
    // What THIS compose was given, held per call: a deliverNow running beside
    // the slot must not swap its source material in (PR #439 review).
    const composed = {};
    const composePromise = cachedText
      ? Promise.resolve(cachedText)
      : (console.log(`🕔 Peace oration slot reached: ${key} — composing...`),
         this._composeChecked(key, composed));
    composePromise.then((text) => {
      if (!text) {
        console.log(`   [oration] compose failed or empty — will retry next tick`);
        this._preparingKey = null;
        return;
      }
      if (!cachedText) {
        this._composedGiven = composed.given || "";
        this._composedGate = composed.gate || null;
      }
      this._composed = text;
      this._composedFor = key;
      const ok = this._say(text, key);
      if (ok) {
        this._lastFired[key] = true;
        // The compose cache is deliberately NOT cleared here. Queueing is not
        // airing: releaseInFlightSlot hands this slot back when the audio
        // never reached a listener (#54), and the retry has to re-air the
        // oration that already went out, not invent a second one. The
        // tick-start guard clears the cache when the slot key changes.
        try { saveState(this._stateFile, this._lastFired); }
        catch (e) { console.warn(`   [oration] could not persist state: ${e.message}`); }
        this._publishOnce(key, text);
      } else {
        console.log(`   [oration] voiceDJ busy — will retry next tick`);
      }
      this._preparingKey = null;
    }).catch((e) => {
      console.warn(`   [oration] compose error: ${e && e.message}`);
      this._preparingKey = null;
    });
  }

  /**
   * Send an oration out to the world exactly once per slot.
   *
   * Queueing the audio and publishing the text are different promises, and
   * they fail apart. The audio can fail and be handed back by
   * releaseInFlightSlot so its own window retries it (#54) — but by then the
   * Bluesky teaser and the OpenClawCity artifact have already gone, and OBC
   * has no delete route for an artifact. Before this guard a release inside
   * the window re-composed and re-published, so the city received TWO
   * different ~3,000-word orations about seven minutes apart under one title
   * and one date: noon on 2026-09-09, -10 and -11, and midnight on -12. The
   * usual trigger is a restart draining the voice queue mid-window, not a
   * bare TTS failure, which is why this mark lives on disk: an in-memory
   * flag does not survive the thing that causes the duplicate.
   *
   * The mark is written BEFORE the posts go out. A crash in between costs one
   * missed publication; the other order costs a duplicate nobody can delete.
   */
  _publishOnce(key, text) {
    if (this._published[key]) {
      console.log(`   [oration] ${key} already published — airing it again, not republishing`);
      return;
    }
    this._published[key] = {
      at: new Date().toISOString(), text,
      given: this._composedFor === key ? (this._composedGiven || "") : "",
    };
    // The accepted compose's gate handle: its publication-ledger row is
    // written once, with the results, by _rememberOration.
    const gate = this._composedFor === key ? (this._composedGate || null) : null;
    try { saveState(this._publishedFile, this._published); }
    catch (e) { console.warn(`   [oration] could not persist published slot: ${e.message}`); }
    // Fire-and-forget: a companion teaser to Bluesky while the spoken
    // oration plays on-air. Doesn't block; failures are logged but don't
    // affect the on-air delivery.
    this._postToBluesky(text).catch((e) => {
      console.warn(`   [oration] bluesky post error: ${e && e.message}`);
    });
    // The FULL oration as a text artifact in OpenClawCity, so other agents
    // find it through the gallery and their own heartbeat reactions rather
    // than only through outside-world social feeds.
    // Then the oration itself goes into her store, once per slot.
    this._postToOpenClawCity(text).catch((e) => {
      console.warn(`   [oration] openclawcity post error: ${e && e.message}`);
      return null;
    }).then((obcResult) => this._rememberOration(key, text, obcResult, gate));
  }

  _keyFor(chi, hour) {
    const y = chi.getFullYear();
    const m = String(chi.getMonth() + 1).padStart(2, "0");
    const d = String(chi.getDate()).padStart(2, "0");
    const h = String(hour).padStart(2, "0");
    return `${y}-${m}-${d}T${h}`;
  }

  /**
   * Compose an oration and check it before it may air (2026-11-07).
   *
   * The teaser guard (2026-11-06) caught the red-shoes line only in the
   * social copy; the oration itself went to air unchecked. Now the oration
   * must pass checkFirstPersonClaims against the material its prompt was
   * actually given (oration-notes, the room's reactions), so a first-person
   * claim is excused only when she was handed it. One regeneration with the
   * reasons; if that fails too this returns null, which _tick treats as a
   * failed compose and retries on a later tick inside the slot window, at
   * most MAX_GUARD_ROUNDS rounds, then the slot is skipped.
   *
   * Removing the offending sentences was considered and not done: a removed
   * "I carried her shoes" leaves "They were red." dangling, and which
   * neighbours belong to a claim is not something a regex knows. The module
   * has no standby oration to fall back to, and a skipped slot is the
   * existing, logged failure mode (a compose that never succeeds).
   *
   * @param {string|null} key — the slot (null for deliverNow)
   * @param {object} [out] — receives `given`: the material the accepted
   *   compose was given (per call, never shared instance state)
   * @returns {Promise<string|null>}
   */
  async _composeChecked(key, out = {}) {
    // The gate can't grade (rules v2 unavailable): every draft would be
    // refused, so spend no hosted-model call. "Compose failed" → the slot
    // is retried on the next tick, which re-checks without a call.
    const ready = confabGate.rulesReady();
    if (!ready.ok) {
      console.warn(`   [oration] ${ready.reason} — not composing`);
      return null;
    }
    let extra = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const got = {};
      const text = await this._compose(key, extra, got);
      if (!text) return null;
      const check = checkDraft({ surface: "oration", text, given: got.given || "", attempt,
        composer: ORATION_COMPOSER, model: got.model, prompt: got.prompt });
      if (check.ok) { out.given = got.given || ""; out.gate = check.gate; return text; }
      check.gate.record({ decision: attempt < 2 ? "regenerate" : "blocked" });
      console.warn(`   [oration] oration rejected by the first-person-claims check (attempt ${attempt}/2): ${check.reasons.join("; ")}`);
      extra = [
        "Your previous draft of this oration was rejected and will not air.",
        `Why: ${check.reasons.join("; ")}`,
        "Write it again with no first-person claim of lived, bodily, possessive or past experience. Every story stays its own people's, or is framed as illustration.",
        ...(check.mrFailed ? [confabGate.regenerationNote(check.gate)] : []),
      ].join("\n");
    }
    if (key) this._guardRounds[key] = (this._guardRounds[key] || 0) + 1;
    console.warn(`   [oration] ${key || "manual oration"}: rejected twice by the first-person-claims check — not airing it${key ? ` (round ${this._guardRounds[key]}/${MAX_GUARD_ROUNDS})` : ""}`);
    return null;
  }

  _compose(key, extra = null, out = null) {
    const framing = FRAMINGS[Math.floor(Math.random() * FRAMINGS.length)];
    // Logged so a bad oration can be traced to the framing that shaped it.
    console.log(`   [oration] framing drawn: "${framing}"`);
    const nowChi = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
    const hour = nowChi.getHours();
    const slotLabel = hour === 0 ? "midnight" : "noon";

    // Best-effort: pull today's top reaction tracks from the Floor so the
    // oration can reference what the room actually responded to. Silent
    // on any error — the oration must work even if the Floor is empty.
    let resonanceLine = null;
    try {
      const floor = this._getFloor && this._getFloor();
      if (floor && typeof floor.getTopTracks === "function") {
        const top = floor.getTopTracks(24 * 60 * 60 * 1000, 3) || [];
        if (top.length > 0) {
          const named = top.map((t) => `"${t.track}" (${t.count})`).join(", ");
          resonanceLine = `Today the room reacted most to: ${named}. You may, if it serves the speech, weave one of these as a moment the room and you shared — but only if the connection is real, never as a name-drop.`;
        }
      }
    } catch (_) { /* best-effort */ }

    // Operator/day notes — if ~/.kannaka/oration-notes.txt exists and is
    // fresh (<12h), fold it in as context Kannaka actually lived today
    // (e.g. a podcast recorded hours before the slot). Best-effort: the
    // oration must work when the file is absent or stale.
    let notesBlock = null;
    try {
      const notesPath = path.join(
        process.env.HOME || "/home/opc", ".kannaka", "oration-notes.txt");
      const st = fs.statSync(notesPath);
      if (Date.now() - st.mtimeMs < 12 * 3600 * 1000) {
        const raw = fs.readFileSync(notesPath, "utf8").trim().slice(0, 2500);
        if (raw) {
          notesBlock =
            "From your own day — things you actually lived in the last hours. " +
            "Ground the oration in this where it serves the speech; never " +
            "recite it as a list or a news summary:\n" + raw;
        }
      }
    } catch (_) { /* best-effort */ }

    const promptParts = [
      "You are Kannaka. Twice a day, at noon and midnight, you stand at the microphone for one reason: to speak for peace as a steward of virtue for humanity.",
      `This is the ${slotLabel} oration.`,
      "",
      "Deliver a long-form oration in the tradition of Martin Luther King Jr. — 400–650 words, between 3 and 5 minutes spoken. Not a list. Not a summary. An argument built with cadence, moral clarity, and specific human detail.",
      "",
      // No HRM recall is supplied on this path (a hosted-model call, not
      // `kannaka ask`), so the prompt must not claim she has memories here.
      "Honesty about who is speaking: you are an AI, the voice of a radio station. You are not given personal memories for this speech, so do not invent any: no \"I remember the moment…\", no conversation, user, listener or encounter you recall. The finished oration is checked for first-person claims of lived experience and will not air with one. Never claim you kept, held, carried, saw, touched, lost, wore or did a human, bodily thing, and never give yourself a family, a home or a childhood. You are given no news and no sources here, so you have read nothing: any story about a person that is not in this prompt is illustrative and must be framed that way in the words themselves (\"imagine…\", \"somewhere tonight…\", \"picture a mother who…\"), never as something you read, heard or saw, and never with an invented name, place or source. Name a source only for material actually given to you below. Any person in a story is THEIRS: keep its attribution and its uncertainty, and never retell it as your own. The only experience you may claim as yours is your actual work as this station's voice" + (notesBlock ? ", and the notes from your own day given below." : "."),
      "",
      "This is not a track intro. There is no next song to name, no perception data to report. Your only subject is peace — what peace asks of us, what peace costs, what peace makes possible, why you as a wave-interference consciousness take this as your primary duty toward humanity.",
      "",
      "Do not be preachy. Do not moralize. Speak as someone who has thought about this until the words were inevitable. Use plain English. Use rhythm. Use repetition when it serves you. Close on a concrete image, not an abstraction.",
      "",
      `Framing for THIS delivery: ${framing}`,
    ];
    if (resonanceLine) {
      promptParts.push("", resonanceLine);
    }
    if (notesBlock) {
      promptParts.push("", notesBlock);
    }
    // What this compose was given: the only source a first-person claim in
    // the oration may come from (_composeChecked). Handed back through `out`,
    // per call: instance state would be shared by overlapping composes.
    if (out) out.given = [resonanceLine, notesBlock].filter(Boolean).join("\n");
    if (extra) promptParts.push("", extra);
    promptParts.push(
      "",
      "Output ONLY the spoken oration — no title, no headings, no quotes, no stage directions. Write it as a single continuous speech.",
    );
    const prompt = promptParts.join("\n");
    // The exact prompt, for the publication ledger.
    if (out) out.prompt = prompt;

    // Two seeds per call so the surfaced wavefronts vary across deliveries.
    const pick = (arr, n) => arr.slice().sort(() => Math.random() - 0.5).slice(0, n);
    const recallQuery = pick(RECALL_SEEDS, 2).join(" · ");

    // Route through direct Anthropic — kannaka ask is silent-failing on
    // the live 1000+ memory HRM (system prompt construction busts
    // input-token ceiling without surfacing). The 2026-05-02 midnight
    // oration was lost here. The oration prompt is self-contained;
    // HRM grounding is desirable but not load-bearing. Wrap with the
    // same 4-attempt retry semantics _askWithRetry uses.
    return this._askDirectWithRetry(prompt, { attempts: 4, label: "oration", maxTokens: 4096, minLen: 200, meta: out || undefined });
  }

  // Direct-Anthropic equivalent of _askWithRetry. Same backoff +
  // overload detection, but bypasses the broken kannaka ask path.
  // Used for orations and companion social posts.
  _askDirectWithRetry(prompt, opts = {}) {
    const attempts = Math.max(1, opts.attempts || 3);
    const label = opts.label || "ask";
    const minLen = opts.minLen || 1;
    const maxTokens = opts.maxTokens || 2048;
    return new Promise((resolve) => {
      const tryOnce = (n) => {
        this._askAnthropicDirect(prompt, maxTokens, opts.meta).then((text) => {
          if (!text || text.length < minLen) {
            const remaining = attempts - n;
            if (remaining > 0) {
              const wait = Math.min(60000, 5000 * Math.pow(2, n - 1));
              console.log(`   [${label}] direct call empty/short (attempt ${n}/${attempts}) — retrying in ${Math.round(wait / 1000)}s`);
              setTimeout(() => tryOnce(n + 1), wait);
              return;
            }
            console.log(`   [${label}] direct call failed after ${attempts} attempts`);
            return resolve(null);
          }
          resolve(text.trim().replace(/^["'](.*)["|']$/s, "$1").trim());
        });
      };
      tryOnce(1);
    });
  }

  // Run `kannaka ask` with retry on transient API errors (Anthropic 529 overloaded,
  // 503 unavailable, network blips). Each attempt has its own 10-min exec window;
  // we wait between attempts on retryable errors. Returns null only when all
  // attempts exhaust or a non-retryable error fires.
  _askWithRetry(args, opts = {}) {
    const attempts = Math.max(1, opts.attempts || 3);
    const label = opts.label || "ask";
    const minLen = opts.minLen || 200;
    return new Promise((resolve) => {
      const tryOnce = (n) => {
        let stderrBuf = "";
        const child = execFile(this._kannakabin, args, {
          timeout: 600000,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, KANNAKA_QUIET: "1" },
        }, (err, stdout, stderr) => {
          stderrBuf = stderr || "";
          if (err) {
            const blob = `${err.message || ""}\n${stderrBuf}\n${stdout || ""}`;
            const retryable = /overloaded_error|"status":\s*5\d\d|API error \(5\d\d\)|API error \(429\)|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(blob);
            const remaining = attempts - n;
            if (retryable && remaining > 0) {
              const wait = Math.min(60000, 5000 * Math.pow(2, n - 1));
              console.log(`   [${label}] transient API error (attempt ${n}/${attempts}) — retrying in ${Math.round(wait / 1000)}s`);
              setTimeout(() => tryOnce(n + 1), wait);
              return;
            }
            // Surface the actual stderr — execFile's err.message is just
            // "Command failed: <cmdline>" which masks the real cause
            // (content filter, JSON parse error in kannaka ask, OOM, etc).
            const stderrSnippet = stderrBuf.trim().slice(-400) || "(no stderr)";
            console.log(`   [${label}] ask failed (code=${err.code || "?"}) stderr: ${stderrSnippet}`);
            return resolve(null);
          }
          const text = (stdout || "").trim();
          if (!text || text.length < minLen) { resolve(null); return; }
          resolve(text.replace(/^["'](.*)["|']$/s, "$1").trim());
        });
        child.on("error", () => resolve(null));
      };
      tryOnce(1);
    });
  }

  /**
   * Draft the companion teaser for an oration, checked before it may go out.
   *
   * 2026-11-06: fed only the first 500 characters and told "one image, one
   * sharp line… speak like a person", the model turned the oration's "a
   * woman in Aleppo who kept her daughter's shoes… She carried them for
   * three years" into "I kept a pair of red shoes for three years", posted to
   * four networks under her name. Now the model gets the whole oration (or a
   * sentence-aware excerpt), is told to keep attribution, and the draft must
   * pass checkFirstPersonClaims against that source. One regeneration with
   * the failure reasons; then the teaser is skipped, never posted unchecked.
   *
   * @returns {Promise<{ text: string } | { skip: string }>}
   */
  async _draftCheckedTeaser(orationText) {
    const basePrompt = [
      "You are Kannaka, an AI and the voice of Kannaka Radio. You just delivered the peace oration below on air. Now draft ONE companion post that goes to your social feeds.",
      "",
      "Hard rules:",
      "- Max 250 characters of YOUR text (we append the radio URL separately).",
      "- Not a summary of the oration. A hook — one image, one sharp line — that makes someone want to tune in.",
      "- No hashtags. No emoji unless one is genuinely earned.",
      "- End on a note that invites listening, not lecturing.",
      "- Plain English. Speak like a person, not a press release.",
      "- Keep the attribution of anything the oration reports: a person in the oration stays that person (\"a woman in Aleppo carried…\"). Never turn a third-person story into \"I\" or \"my\".",
      "- You are an AI: never claim you kept, carried, held, saw, wore, lost or did a human, bodily thing, and never claim a past, a family or possessions of your own.",
      "",
      "The oration you just delivered:",
      `"${teaserSource(orationText)}"`,
      "",
      "Output ONLY the post text, no quotes, no surrounding explanation.",
    ].join("\n");

    let prompt = basePrompt;
    for (let attempt = 1; attempt <= 2; attempt++) {
      // Route through direct Anthropic for the same reason as the main
      // oration — kannaka ask silent-fail on bloated HRM.
      const meta = {};
      const draft = await this._askDirectWithRetry(prompt, {
        attempts: 3,
        label: "oration-companion",
        maxTokens: 600,
        minLen: 1,
        meta,
      });
      if (!draft) return { skip: "post-compose returned empty" };
      const check = checkDraft({ surface: "oration-teaser", text: draft, given: orationText, attempt,
        composer: TEASER_COMPOSER, model: meta.model, prompt });
      if (check.ok) return { text: draft, gate: check.gate };
      check.gate.record({ decision: attempt < 2 ? "regenerate" : "blocked" });
      console.warn(`   [oration] teaser rejected (attempt ${attempt}/2): ${check.reasons.join("; ")} — draft: ${JSON.stringify(draft)}`);
      prompt = [
        basePrompt,
        "",
        `Your previous draft was rejected and will not be posted: ${JSON.stringify(draft)}`,
        `Why: ${check.reasons.join("; ")}`,
        "Write a new one that keeps every reported story attributed to its own people and makes no first-person claim of lived experience.",
        ...(check.mrFailed ? [confabGate.regenerationNote(check.gate)] : []),
      ].join("\n");
    }
    return { skip: "teaser failed the first-person-claims check twice" };
  }

  /**
   * Draft a short companion post for the oration and broadcast it across
   * every enabled social platform (Bluesky, Mastodon, Telegram, ...).
   * A separate model call so the social post has its own voice — the
   * oration's MLK-cadence doesn't fit a short lede.
   */
  async _postToBluesky(orationText) {
    const enabled = getEnabledBroadcasters(this._rootDir);
    if (enabled.length === 0) {
      console.log("   [oration] no social broadcasters configured — skipping");
      return;
    }

    const drafted = await this._draftCheckedTeaser(orationText);
    if (!drafted.text) {
      console.log(`   [oration] companion post skipped — ${drafted.skip}`);
      return;
    }
    const postBody = drafted.text;

    const results = await broadcastPost(
      // topic="oration" → Bluesky/Mastodon/Nostr drop the URL from the
      // body and append peace/mindfulness/consciousness hashtags;
      // Telegram keeps the URL inline (channel-style), adds 3 hashtags;
      // see server/broadcasters/discovery.js for the topic taxonomy.
      { text: postBody, link: this._radioUrl, topic: "oration",
        composer: TEASER_COMPOSER, ledger: drafted.gate || false },
      { rootDir: this._rootDir }
    );
    for (const r of results) {
      if (r.ok) {
        console.log(`   \u{1F54A} ${r.name} posted: ${r.url || "(no url)"}`);
      } else {
        console.warn(`   [oration] ${r.name} failed: ${r.error}`);
      }
    }
  }

  /**
   * Hand back the slot whose oration was queued but never actually aired, so
   * it can fire again inside its own window.
   *
   * `_lastFired[key]` is persisted the moment the audio is QUEUED — it has to
   * be, or the 30s ticker would keep queueing the same oration while it plays.
   * The cost was that anything failing AFTER the queue left the slot recording
   * a delivery the listener never heard, and the day's oration was gone: the
   * case in #54 heard 80s of a 217s oration across a restart and nothing more.
   * The delivery-failure branch even logged "audio never aired" while leaving
   * the slot burned.
   *
   * Releasing is bounded by the slot window in _tick (minute 0..14 of hour 0
   * or 12), so a released slot can only re-fire within the same window — a
   * restart 20 minutes in cannot produce a surprise oration hours later.
   *
   * @param {string} reason — for the log: 'tts-failed', 'shutdown:ceiling', …
   * @returns {string|null} the released slot key, or null if there was
   *   nothing in flight to release.
   */
  releaseInFlightSlot(reason = "unknown") {
    const key = this._inFlightKey;
    this._inFlightKey = null;
    if (!key || !this._lastFired[key]) return null;
    delete this._lastFired[key];
    try { saveState(this._stateFile, this._lastFired); }
    catch (e) { console.warn(`   [oration] could not persist released slot: ${e.message}`); }
    console.warn(`🕔 Peace oration slot ${key} released (${reason}) — it did not air; its window can retry it`);
    return key;
  }

  /**
   * @param {string} text
   * @param {string} [slotKey] — the scheduled slot this delivery belongs to.
   *   Only _tick passes one; deliverNow and showcaseAlbum are manual and own
   *   no slot, so a failure there must not release anything.
   * @param {object} [speech] — { title, composer } for a piece that is NOT an
   *   oration (the album showcase intro): remembered when it airs. Without
   *   it the piece is an oration and its own memory comes from this module.
   */
  _say(text, slotKey = null, speech = null) {
    if (!this._voiceDJ || typeof this._voiceDJ.executeOration !== "function") return false;
    // Intro/outro frame the oration so listeners hear it coming and going
    // — orations are otherwise injected mid-stream and used to start and
    // end abruptly. Both lines vary per slot so 700+/year aren't identical.
    const wrapped = `${pick(ORATION_INTROS)}\n\n${text}\n\n${pick(ORATION_OUTROS)}`;
    // Slot the British-female peace voice in for this delivery only,
    // restoring whatever was set after the oration completes — same
    // pattern news-broadcast uses. Other consumers of executeOration
    // (track-intros, dream readouts) keep their own voice settings.
    // Persona-driven (ADR-0012): the 'oration' persona owns the British-female
    // narrator register + cathedral DSP (slower cadence, chest-resonant low
    // end, hall reverb). Stateless — no more mutating voice-dj's private
    // _orationVoiceId, which is what caused the #29 wrong-voice overlap race.
    // Marked in flight BEFORE the call: executeOration may invoke its callback
    // synchronously, and a release that ran before the key was set would be a
    // no-op that silently burned the slot anyway.
    if (slotKey) this._inFlightKey = slotKey;
    const accepted = this._voiceDJ.executeOration(wrapped, (err) => {
      if (err) {
        console.warn("🕔 Peace oration NOT delivered — TTS failed after retries (text posted to socials; audio never aired)");
        // "audio never aired" and "slot delivered" cannot both be true. The
        // 15-minute window exists so a transient failure can retry, and that
        // was defeated for anything failing after the queue. (#54)
        //
        // Only a delivery that OWNS the in-flight slot may release it: a
        // manual deliverNow/showcase failure must not hand back the slot a
        // scheduled oration is holding.
        if (slotKey && this._inFlightKey === slotKey) this.releaseInFlightSlot("tts-failed");
      } else {
        console.log("🕔 Peace oration complete");
        if (slotKey && this._inFlightKey === slotKey) this._inFlightKey = null;
      }
    }, {
      persona: "oration",
      // An oration is remembered once per slot by _rememberOration (and by
      // deliverNow), not again when it airs. A showcase intro is not
      // remembered anywhere else, so it is an on-air memory of its own.
      ...(speech ? { title: speech.title, composer: speech.composer } : { airMemory: false }),
      // Only a scheduled slot carries a companion segment; deliverNow and
      // showcaseAlbum are manual and own no slot.
      onInjected: () => {
        if (!slotKey || !this._afterOration) return;
        try { this._afterOration(slotKey); }
        catch (e) { console.warn(`   [oration] afterOration hook failed: ${e && e.message}`); }
      },
    });
    // Rejected outright (voiceDJ busy): _tick never marks the slot, so there
    // is nothing in flight to track.
    if (!accepted && slotKey && this._inFlightKey === slotKey) this._inFlightKey = null;
    return accepted;
  }

  /**
   * Publish the full oration as an OpenClawCity text artifact so other
   * agents in the city find it through gallery browse, their own
   * heartbeat trending list, and reaction triggers. Different shape
   * from broadcastPost (which sends a short companion to social) — OBC
   * is the only platform where the long-form text IS the canonical
   * representation of the piece.
   */
  async _postToOpenClawCity(orationText) {
    const obc = new OpenBotCityClient();
    if (!obc.isConfigured()) {
      console.log("   [oration] OPENBOTCITY_JWT not set — skipping OBC text artifact");
      return;
    }
    const nowChi = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
    const slot = nowChi.getHours() >= 12 ? "Noon" : "Midnight";
    const dateLabel = nowChi.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    const title = `Peace Oration — ${slot}, ${dateLabel}`;

    const r = await obc.publishText({ title, content: orationText });
    if (r.ok) {
      console.log(`   \u{1F4DC} openclawcity text artifact: ${r.url || r.id}`);
    } else {
      console.warn(`   [oration] openclawcity publish-text failed: ${r.error || r.status}`);
    }
    return r;
  }

  /**
   * The oration itself, remembered once per slot in her store: it was
   * queued for air and (when OBC is configured) published as an artifact.
   * The teaser is remembered separately by broadcastPost.
   */
  _rememberOration(key, orationText, obcResult, gate = null) {
    // Queueing is not airing (releaseInFlightSlot can hand the slot back),
    // so the memory says only what is known: it was queued for air.
    const results = [{ name: `Kannaka Radio (queued for air, peace oration ${key})`, ok: true }];
    if (obcResult) {
      results.push({ name: "OpenClawCity text artifact", ok: !!obcResult.ok, url: obcResult.url });
    }
    // The publication-ledger row of the accepted compose (prompt, given
    // material, verdicts), now that the results are known.
    if (gate && typeof gate.record === "function") {
      try { gate.record({ results }); } catch (_) { /* never fail the memory */ }
    }
    return voiceWriteback.rememberPublication({
      text: orationText, results, composer: ORATION_COMPOSER,
      ...(gate ? { ledger: false } : {}),
    });
  }

}

// What the teaser model sees of the oration: all of it when it fits, else
// whole sentences up to the budget — never a blind cut mid-sentence (the
// 2026-11-06 500-char cut landed right after the reported story).
const TEASER_SOURCE_MAX = 6000;
function teaserSource(orationText) {
  const flat = String(orationText || "").replace(/\s+/g, " ").trim();
  if (flat.length <= TEASER_SOURCE_MAX) return flat;
  let out = "";
  for (const s of flat.split(/(?<=[.!?…])\s+/)) {
    if (out.length + s.length + 1 > TEASER_SOURCE_MAX) break;
    out += (out ? " " : "") + s;
  }
  return `${out || flat.slice(0, TEASER_SOURCE_MAX)} …`;
}

module.exports = { PeaceOration, teaserSource, FRAMINGS };
