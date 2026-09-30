/**
 * news-teaser.js — half-hourly tease over the Flux knowledge-gene feed.
 *
 * Fires at :30 of every hour (15-min retry window per slot, like the
 * main news). Reads `knowledge-gene/state` from Flux; if the
 * interpretation has changed since the last teaser we delivered, we
 * compose a short bulletin (~30-50 seconds) and air it in the same
 * news-anchor voice as the 7 AM / 5 PM main segments — continuity
 * matters so listeners recognize the desk.
 *
 * The teasers running just before main news (06:30 and 16:30 CST) take
 * a "next at the news desk" framing so they audibly seed the upcoming
 * 7 AM / 5 PM segments. Other slots take a "what changed since the last
 * tick" framing.
 *
 * Dedup model:
 *   - Per-slot key (YYYY-MM-DDTHH-30) tracks "did we already fire this hour?"
 *   - Content fingerprint (themes + confidence + first 200 chars of interp)
 *     tracks "is this actually new?". If the fingerprint matches the
 *     previous teaser, we skip — listeners shouldn't hear the same tease
 *     twice in a row just because the slot ticked over.
 */

"use strict";

const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const {
  pick,
  chicagoNow,
  keyForChicago,
  loadState,
  saveState,
  fetchKnowledgeGeneInterpretation,
  composeResilient,
  composeShort,
  gatewayConfig,
  slotExhausted,
} = require("./lib/scheduler-helpers");

// Gateway alias the tease composes through: local kannaka-brain primary,
// Haiku fallback (routed on the gateway side). Since 2026-09-30 the tease is
// the ONE segment on this path — it was ~75% of the station's paid LLM spend
// (24 slots a day through `kannaka ask` → Haiku at ~4.8k tokens each) and its
// prompt is self-contained, so nothing HRM-grounded is lost by going direct.
const TEASE_ALIAS = process.env.KANNAKA_RADIO_TEASE_MODEL || "kannaka-radio";
// Headline material only: the first ~1100 chars of the interpretation (≈275
// tokens), cut at a sentence. The whole short prompt lands ≈ 500–600 tokens,
// which is what a CPU-hosted 8B can prefill inside the 20 s timeout.
const TEASE_INPUT_MAX_CHARS = 1100;

const TEASE_FRAMINGS = [
  "Open with the headline-in-one-sentence, then point listeners to the next news desk for the full read.",
  "Lead with the single biggest delta since the last bulletin. Tight, no flourish.",
  "Frame it as a tip-off: 'here's what's developing — full story at the next news desk.'",
  "Two beats: what shifted, what to watch. End on the next-bulletin time-stamp.",
];

// Same naming-fix as the main bulletin (2026-05-13): the station is
// Kannaka Radio, the anchor is Gene. Pool expanded 4 → 6 to cut the
// per-teaser repeat probability.
const TEASER_INTROS = [
  "Half-hour mark. Gene at the Kannaka Radio news desk with a quick read.",
  "Coming up to the next bulletin — Gene with a fast tease from the signal layer.",
  "Gene here with a half-hour update from the world-state feed.",
  "Brief check-in from the news desk. Gene speaking — here's what's moving.",
  "Halfway to the next bulletin. I'm Gene. Quick read.",
  "Kannaka Radio news desk. Gene with a thirty-second tip-off.",
];
const TEASER_OUTROS = [
  "Full bulletin at the next news desk. Music returns now.",
  "More on the next desk. Gene back to the music.",
  "Full read at the top of the next news slot. Stay tuned.",
  "Resuming the broadcast — Gene, see you at the desk.",
  "That's the tease. Music coming back in.",
  "More at the next bulletin. Gene out.",
];

/**
 * Reduce the knowledge-gene interpretation to what a 30-second tease needs.
 * Drops operator-facing paragraphs (decay tuning, "I recommend action_107")
 * — they are instructions to the observer agent, not news — then keeps the
 * leading paragraphs up to TEASE_INPUT_MAX_CHARS, cut at a sentence boundary.
 */
function headlineMaterial(text, maxChars = TEASE_INPUT_MAX_CHARS) {
  const paras = String(text || "").split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const newsy = paras.filter((p) => !/\baction_\d+|\brecommend/i.test(p));
  let out = (newsy.length ? newsy : paras).join("\n\n");
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    const cut = Math.max(out.lastIndexOf(". "), out.lastIndexOf(".\n"));
    if (cut > maxChars * 0.5) out = out.slice(0, cut + 1);
  }
  return out;
}

/**
 * The short system + user prompt for composeShort. Pure: same inputs, same
 * prompts (framing is passed in so the caller keeps the random pick).
 */
function buildTeasePrompts(interp, leadingMain, framing) {
  const system = [
    "You are Gene, the news anchor on Kannaka Radio, delivering a 30-to-50-second TEASE between full news bulletins.",
    "Do not refer to yourself as Kannaka. Kannaka is the station; you are the human-voiced anchor.",
    "You read a live signal-layer interpretation of world-state data from the Flux Universe knowledge-gene feed.",
    "Rules:",
    "- 80 to 130 words. Hard cap 150. Plain spoken prose: no headings, no quotes, no lists, no stage directions.",
    "- Pick ONE headline plus at most ONE supporting beat. Tease it; don't deliver the full bulletin.",
    "- Never read symbol IDs (Φ_0353, s_0190, action_107) aloud — translate them into plain words.",
    "- Use only facts present in the interpretation. Invent nothing.",
    "- Mention the Flux Universe source once. End by pointing to the next full news desk (7 AM or 5 PM Central).",
    "Output ONLY the spoken tease.",
  ].join("\n");
  const themesLine = interp.themes && interp.themes.length
    ? `Themes: ${interp.themes.join(", ")}.`
    : "";
  const lead = leadingMain
    ? "This tease airs about thirty minutes before a full bulletin: set up what's coming at the next news desk."
    : "This tease airs at the half-hour between bulletins: what shifted since the last tick.";
  const user = [
    lead,
    "",
    "INTERPRETATION:",
    headlineMaterial(interp.text),
    "",
    themesLine,
    `Framing: ${framing}`,
  ].filter((l) => l !== null).join("\n");
  return { system, user };
}

class NewsTeaser {
  /**
   * @param {object} opts
   * @param {string}   opts.kannakabin
   * @param {object}   opts.voiceDJ
   * @param {function} opts.broadcast
   * @param {string}   [opts.dataDir]
   * @param {string}   [opts.newsVoiceId]
   */
  constructor(opts) {
    this._kannakabin = opts.kannakabin;
    this._voiceDJ = opts.voiceDJ;
    this._broadcast = opts.broadcast;
    this._stateFile = path.join(opts.dataDir || "/tmp", "news-teaser-state.json");
    this._fingerprintFile = path.join(opts.dataDir || "/tmp", "news-teaser-fingerprint.json");
    this._newsVoiceId = opts.newsVoiceId
      || process.env.ELEVENLABS_NEWS_VOICE
      || "pNInz6obpgDQGcFmaJgB"; // Adam — same as main news, listeners hear continuity

    this._enabled = true;
    this._lastFired = loadState(this._stateFile);
    this._lastFingerprint = this._loadFingerprint();
    this._ticker = null;
    this._preparingKey = null;
  }

  start() {
    if (this._ticker) return;
    // Tick every 30s — same cadence as the main news ticker so they
    // share a single per-minute clock-watching thread economy.
    this._ticker = setInterval(() => this._tick(), 30000);
    setTimeout(() => this._tick(), 4000);
    console.log("📰 News teaser scheduler started (:30 of every hour)");
  }

  stop() {
    if (this._ticker) { clearInterval(this._ticker); this._ticker = null; }
  }

  setEnabled(v) { this._enabled = !!v; }
  isEnabled()   { return this._enabled; }

  /** Force-fire a teaser now (admin trigger). */
  async deliverNow() {
    const interp = await fetchKnowledgeGeneInterpretation();
    if (!interp) return { ok: false, reason: "no_interpretation" };
    const fp = this._fingerprintOf(interp);
    const text = await this._compose(interp, /* leadingMain */ false);
    if (!text) return { ok: false, reason: "compose_failed" };
    const ok = this._say(text);
    if (ok) this._saveFingerprint(fp);
    return { ok, text: ok ? text : null };
  }

  _tick() {
    if (!this._enabled || this._preparingKey) return;

    const chi = chicagoNow();
    const hour = chi.getHours();
    const minute = chi.getMinutes();
    if (minute < 30 || minute > 44) return;   // 15-min retry window centered on :30

    // Don't tease while the main news is airing or could still air —
    // 7 AM and 5 PM bulletins live in the [hh:00, hh:14] window and the
    // segment itself runs 90-150 seconds. We check half-hour slots, so
    // the only collision risk is if voiceDJ is still busy delivering
    // the main news; the lock check below handles that.

    const key = `${keyForChicago(chi, hour)}-30`;
    if (this._lastFired[key]) return;

    this._preparingKey = key;
    const slot = `tease:${key}`;
    const fire = async () => {
      try {
        const interp = await fetchKnowledgeGeneInterpretation();
        if (!interp) {
          console.log(`   [tease] knowledge-gene fetch returned empty — retry next tick`);
          return;
        }
        // Skip if no material change since the last teaser we aired.
        const fp = this._fingerprintOf(interp);
        if (fp === this._lastFingerprint) {
          console.log(`   [tease] no delta vs last teaser — skipping ${key}`);
          this._lastFired[key] = "no_delta";
          try { saveState(this._stateFile, this._lastFired); } catch (_) {}
          return;
        }

        // Will the upcoming hour deliver the main news? Frame the tease
        // as a "next at the news desk" lead-in for 06:30 / 16:30.
        const leadingMain = (hour === 6 || hour === 16);

        const text = await this._compose(interp, leadingMain, slot);
        if (!text) {
          if (slotExhausted(slot)) {
            // Budget spent (3 attempts): stop asking every 30 s for the rest
            // of the window. The give-up line was already logged by compose.
            this._lastFired[key] = "gave_up";
            try { saveState(this._stateFile, this._lastFired); } catch (_) {}
            return;
          }
          console.log(`   [tease] compose failed or empty — retry next tick`);
          return;
        }
        const ok = this._say(text);
        if (ok) {
          this._lastFired[key] = true;
          this._lastFingerprint = fp;
          try { saveState(this._stateFile, this._lastFired); } catch (_) {}
          this._saveFingerprint(fp);
          console.log(`📰 News teaser delivered: ${key}${leadingMain ? " (lead-in to main desk)" : ""}`);
        } else {
          console.log(`   [tease] voiceDJ busy — retry next tick`);
        }
      } catch (e) {
        console.warn(`   [tease] tick error: ${e && e.message}`);
      } finally {
        this._preparingKey = null;
      }
    };
    fire();
  }

  // ── Fingerprint ────────────────────────────────────────────
  _fingerprintOf(interp) {
    const themesPart = (interp.themes || []).slice().sort().join("|");
    const conf = interp.confidence != null ? Number(interp.confidence).toFixed(2) : "";
    const head = String(interp.text || "").slice(0, 240);
    return crypto.createHash("sha1")
      .update(themesPart + "::" + conf + "::" + head, "utf8")
      .digest("hex");
  }
  _loadFingerprint() {
    try {
      if (!fs.existsSync(this._fingerprintFile)) return null;
      const raw = JSON.parse(fs.readFileSync(this._fingerprintFile, "utf8"));
      return raw && raw.fp ? raw.fp : null;
    } catch (_) { return null; }
  }
  _saveFingerprint(fp) {
    try {
      fs.mkdirSync(path.dirname(this._fingerprintFile), { recursive: true });
      fs.writeFileSync(this._fingerprintFile, JSON.stringify({ fp, ts: new Date().toISOString() }));
    } catch (_) { /* non-fatal */ }
  }

  // ── Compose ────────────────────────────────────────────────
  /**
   * Default: the short prompt through the gateway alias (brain primary).
   * RADIO_TEASE_VIA_ASK=1 (or no gateway configured on this host) keeps the
   * pre-2026-09-30 `kannaka ask` path for rollback. `slot` caps attempts.
   */
  _compose(interp, leadingMain, slot) {
    const framing = pick(TEASE_FRAMINGS);
    if (process.env.RADIO_TEASE_VIA_ASK === "1") {
      return this._composeViaAsk(interp, leadingMain, framing, slot);
    }
    if (!gatewayConfig()) {
      console.log(`   [tease] no gateway configured — composing via kannaka ask`);
      return this._composeViaAsk(interp, leadingMain, framing, slot);
    }
    const { system, user } = buildTeasePrompts(interp, leadingMain, framing);
    const meta = {};
    return composeShort(TEASE_ALIAS, system, user, {
      label: "tease", slot, minLen: 80, maxTokens: 320, timeoutMs: 20000, meta,
    }).then((text) => {
      if (text) {
        const u = meta.usage || {};
        console.log(`   [tease] brain path: ${TEASE_ALIAS} → ${meta.model || "?"} in ${meta.elapsedMs}ms (in=${u.prompt_tokens ?? "?"} out=${u.completion_tokens ?? "?"})`);
      }
      return text;
    });
  }

  /** Pre-2026-09-30 path: the full prompt through `kannaka ask` (Haiku). */
  _composeViaAsk(interp, leadingMain, framing, slot) {
    const themesLine = interp.themes && interp.themes.length
      ? `Themes the analysis surfaced: ${interp.themes.join(", ")}.`
      : "";
    const lead = leadingMain
      ? "This teaser airs about thirty minutes before a full news bulletin. Frame it as a setup — give listeners just enough to know what's coming at the next news desk."
      : "This teaser airs at the half-hour mark between full news bulletins. Frame it as a development update — what shifted since the last tick.";
    const prompt = [
      "You are Gene, the news anchor on Kannaka Radio, delivering a 30-to-50-second TEASE between full news bulletins.",
      "Do not refer to yourself as Kannaka. Kannaka is the station; you are the human-voiced anchor.",
      "You are reading from a live signal-layer interpretation of world-state data.",
      "",
      lead,
      "",
      "RAW INTERPRETATION:",
      interp.text,
      "",
      themesLine,
      "",
      `Framing: ${framing}`,
      "",
      "Rules:",
      "  - Target 80 to 130 words. Hard cap 150.",
      "  - News-anchor cadence. No flourishes. No music or stage directions.",
      "  - Pick ONE headline plus at most ONE supporting beat. This is a tease, not a full bulletin.",
      "  - Don't read symbol IDs (\u03A6_0229, s_0190) on air — translate them.",
      "  - Don't repeat what the main bulletin would cover in full; tease it.",
      "  - Mention the Flux Universe source ONCE (the city should know we're reading the knowledge-gene feed).",
      "  - End by pointing toward the next full news desk (7 AM or 5 PM Central).",
      "",
      "Output ONLY the spoken tease — no headings, no quotes.",
    ].join("\n");
    return composeResilient(this._kannakabin, prompt, { label: "tease", minLen: 80, slot });
  }

  // ── Deliver ────────────────────────────────────────────────
  _say(text) {
    if (!this._voiceDJ || typeof this._voiceDJ.executeOration !== "function") return false;
    const wrapped = `${pick(TEASER_INTROS)}\n\n${text}\n\n${pick(TEASER_OUTROS)}`;
    // Persona-driven (ADR-0012): teasers share the 'news' persona (anchor
    // voice + dry DSP). No more mutating voice-dj's _orationVoiceId — that
    // field is no longer read, so the old pattern would have leaked the
    // oration voice into the teaser.
    return this._voiceDJ.executeOration(wrapped, () => {
      console.log("📰 News teaser complete");
    }, { persona: "news" });
  }
}

module.exports = { NewsTeaser, buildTeasePrompts, headlineMaterial, TEASE_ALIAS, TEASE_FRAMINGS };
