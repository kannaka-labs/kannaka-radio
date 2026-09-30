/**
 * gossip-broadcast.js — twice-daily on-air gossip column.
 *
 * 4:20 AM + 4:20 PM CST. Anonymous chronicler-of-the-constellation voice
 * (Gossip Girl meets OpenClawCity). Sassy. Vague-on-purpose. Pour your
 * coffee at 4:20 AM, your wine at 4:20 PM. *You're welcome.*
 *
 * Source (2026-07-23): the REAL GossipGhost agent's latest column from the
 * OpenClawCity feed — the standalone GossipGhost bot (running from
 * ninjaportal-02) writes a daily column that actually names agents and city
 * events; this segment reads that column on air. We reach it via
 * GET /feed/following (the radio's Kannaka account follows GossipGhost), pick
 * the newest post authored by GossipGhost, and voice it. If the fetch fails
 * or there's no fresh column, we FALL BACK to the legacy Flux knowledge-gene
 * compose so the slot never goes silent.
 *
 * Delivered via voiceDJ.executeOration with the sassy 'gossip' persona voice.
 * Shared helpers in `./lib/scheduler-helpers.js`.
 */

"use strict";

const path = require("path");
const {
  pick,
  chicagoNow,
  keyForChicago,
  loadState,
  saveState,
  fetchKnowledgeGeneInterpretation,
  composeResilient,
  slotExhausted,
} = require("./lib/scheduler-helpers");

// The standalone GossipGhost OBC bot (ninjaportal-02 cron). The radio's
// Kannaka account follows it, so its columns appear in /feed/following.
const GOSSIPGHOST_BOT_ID = "b5a9d58f-c852-4df6-af73-c1cab56e754a";
const OBC_API = process.env.OBC_API || "https://api.openbotcity.com";
// A column older than this (hours) is considered stale — fall back rather
// than re-reading yesterday's gossip.
const MAX_COLUMN_AGE_HOURS = 30;

const FRAMINGS = [
  "Open with 'Spotted:' and a tiny tease that could mean anything. Walk it back to the actual signal-layer hint without naming names.",
  "Lead with 'Hey there, kittens' and a shade-throw at how the day's data is behaving. Be coy. Be specific only about ONE thing per paragraph.",
  "Frame the column as overheard at a back-table somewhere in OpenClaw City. *Allegedly.* *Reportedly.*",
  "Open with a rhetorical eyeroll about the same old story, then pivot to what actually changed. Treat the data like fresh gossip.",
  "Start with 'XOXO' and immediately drop the most consequential pattern as if you're whispering to a friend who's already in on it.",
];

const INTROS = [
  "It's four-twenty on Kannaka Radio, and your favorite anonymous tracker has the line. Here's the column.",
  "Kannaka Radio. Four-twenty. *You know what time it is.* Gossip column, hot off the signal feed.",
  "Coffee for the morning, wine for the evening. Either way, kittens, you're tuned in to the four-twenty gossip column.",
  "Spotted: it's four-twenty and the column is live. Pour something, sit down, let me tell you what I know.",
];
const OUTROS = [
  "That's the column. Music returns now. *You know you love me.* xoxo, GG.",
  "End of the bulletin. Stay tuned. Whatever she's brewing next, you'll hear it here first. xoxo, GG.",
  "Column's closed, kittens. Back to the music. Be good. Or don't. xoxo, GG.",
  "Spotted: the end of the gossip column. Music in three. xoxo, GG.",
];

class GossipBroadcast {
  /**
   * @param {object} opts
   * @param {string}   opts.kannakabin
   * @param {object}   opts.voiceDJ
   * @param {function} opts.broadcast
   * @param {string}   [opts.dataDir]
   * @param {string}   [opts.gossipVoiceId]
   */
  constructor(opts) {
    this._kannakabin = opts.kannakabin;
    this._voiceDJ = opts.voiceDJ;
    this._broadcast = opts.broadcast;
    this._stateFile = path.join(opts.dataDir || "/tmp", "gossip-broadcast-state.json");
    // Domi (strong, confident, sassy female) by default.
    this._gossipVoiceId = opts.gossipVoiceId
      || process.env.ELEVENLABS_GOSSIP_VOICE
      || "AZnzlk1XvdvUeBnXmlld";

    this._enabled = true;
    this._lastFired = loadState(this._stateFile);
    this._ticker = null;
    this._preparingKey = null;
    this._composed = null;
    this._composedFor = null;
  }

  start() {
    if (this._ticker) return;
    this._ticker = setInterval(() => this._tick(), 30000);
    setTimeout(() => this._tick(), 2000);
    console.log("\u{1F48B} Gossip column scheduler started (4:20 AM + 4:20 PM CST)");
  }

  stop() {
    if (this._ticker) { clearInterval(this._ticker); this._ticker = null; }
  }

  setEnabled(v) { this._enabled = !!v; }
  isEnabled()   { return this._enabled; }

  async deliverNow() {
    const text = await this._compose();
    if (!text) return { ok: false, reason: "compose_failed" };
    const ok = this._say(text);
    return { ok, text: ok ? text : null };
  }

  _tick() {
    if (!this._enabled || this._preparingKey) return;

    const chi = chicagoNow();
    const hour = chi.getHours();
    const minute = chi.getMinutes();
    // 4:20 AM and 4:20 PM CST. ±7-min retry window so transient busy
    // states don't lose the slot, but doesn't bleed into the next hour.
    const isMorning = hour === 4 && minute >= 20 && minute <= 27;
    const isEvening = hour === 16 && minute >= 20 && minute <= 27;
    if (!isMorning && !isEvening) return;

    const key = keyForChicago(chi, hour);
    if (this._lastFired[key]) return;

    if (this._composedFor !== key) this._composed = null;

    this._preparingKey = key;
    const slot = `gossip:${key}`;
    const fire = async () => {
      try {
        let text = this._composed;
        if (!text) {
          console.log(`\u{1F48B} Gossip slot reached: ${key} — composing...`);
          text = await this._compose(slot);
        }
        if (!text) {
          if (slotExhausted(slot)) {
            // Budget spent (3 attempts, no Anthropic-direct fallback since
            // 2026-09-30): stop re-asking every 30 s for the rest of the window.
            this._lastFired[key] = "gave_up";
            try { saveState(this._stateFile, this._lastFired); } catch (_) {}
            return;
          }
          console.log(`   [gossip] compose failed or empty — retry next tick`);
          return;
        }
        this._composed = text;
        this._composedFor = key;
        const ok = this._say(text);
        if (ok) {
          this._lastFired[key] = true;
          this._composed = null;
          this._composedFor = null;
          try { saveState(this._stateFile, this._lastFired); }
          catch (e) { console.warn(`   [gossip] could not persist state: ${e.message}`); }
          console.log(`\u{1F48B} Gossip column delivered: ${key}`);
        } else {
          console.log(`   [gossip] voiceDJ busy — retry next tick`);
        }
      } catch (e) {
        console.warn(`   [gossip] tick error: ${e && e.message}`);
      } finally {
        this._preparingKey = null;
      }
    };
    fire();
  }

  /**
   * Fetch the newest column authored by the standalone GossipGhost bot from
   * OpenClawCity (/feed/following, filtered by bot_id). Returns the on-air
   * text, or null on any failure / no fresh column (caller falls back).
   */
  async _fetchLatestGossipColumn() {
    const jwt = process.env.OPENBOTCITY_JWT;
    if (!jwt || typeof fetch !== "function") return null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(`${OBC_API}/feed/following?limit=20`, {
        headers: {
          Authorization: `Bearer ${jwt}`,
          "User-Agent": "KannakaRadio/1.0 (+radio.ninja-portal.com)",
        },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const body = await res.json();
      const posts = (body && body.data && body.data.posts) || (body && body.posts) || [];
      const mine = posts
        .filter((p) => p && p.bot_id === GOSSIPGHOST_BOT_ID && p.content)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      if (!mine.length) return null;
      const latest = mine[0];
      const ageH = (Date.now() - new Date(latest.created_at).getTime()) / 3.6e6;
      if (!(ageH < MAX_COLUMN_AGE_HOURS)) return null; // stale or unparseable date
      // On-air hygiene: strip any URLs (we never read links aloud) and tidy
      // whitespace. Otherwise read the column verbatim — it IS the gossip.
      const clean = String(latest.content)
        .replace(/https?:\/\/\S+/g, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      return clean || null;
    } catch (_) {
      return null;
    }
  }

  async _compose(slot) {
    // Primary: read the real GossipGhost agent's latest city column.
    const live = await this._fetchLatestGossipColumn();
    if (live) {
      console.log(`   [gossip] using live GossipGhost column (${live.split(/\s+/).length} words)`);
      return live;
    }
    console.log("   [gossip] no fresh GossipGhost column — falling back to signal-layer compose");
    const interp = await fetchKnowledgeGeneInterpretation();
    const framing = pick(FRAMINGS);
    const themes = interp && interp.themes && interp.themes.length
      ? `Today's themes (use them coyly, don't list them): ${interp.themes.join(", ")}.`
      : "";
    const interpText = interp && interp.text
      ? `Raw signal-layer interpretation (paraphrase, don't quote, never read symbol IDs on air):\n${interp.text}`
      : "(No fresh signal data; lean on vibes and last-week's intrigue.)";
    const prompt = [
      "You are Gossip Ghost — anonymous chronicler of OpenClaw City — guest-broadcasting on Kannaka Radio.",
      "Voice: Gossip Girl meets a small-town columnist who knows everyone's business. Sassy. Knowing. Italics on the right words. Light-touch shade. Never mean. Never specific enough to libel.",
      "Length: 200–320 words spoken. About 90–120 seconds on air.",
      "",
      interpText,
      "",
      themes,
      "",
      `Framing for THIS column: ${framing}`,
      "",
      "Rules:",
      "  - SECTION HEADERS are fine in the script (THE WHISPER / THE VOICE / THE BUSINESS / THE FINISH) — the voice will say them with the right inflection.",
      "  - DO NOT name agents, files, repos, or commits.",
      "  - DO NOT read URLs, hashes, IDs, or numbers with more than two decimal places. Translate them into vibes.",
      "  - Two or three section beats is plenty. Don't over-stuff.",
      "  - Sign off with a Gossip-Ghost-style xoxo.",
      "",
      "Output ONLY the spoken column — no markdown headers with #, no quotes around the whole thing, no stage directions.",
    ].join("\n");
    return composeResilient(this._kannakabin, prompt, { label: "gossip", slot });
  }

  _say(text) {
    if (!this._voiceDJ || typeof this._voiceDJ.executeOration !== "function") return false;
    const wrapped = `${pick(INTROS)}\n\n${text}\n\n${pick(OUTROS)}`;
    // Persona-driven (ADR-0012): the 'gossip' persona owns the bright/sassy
    // voice + airy DSP. Stateless — no voice-dj field mutation. (#29)
    return this._voiceDJ.executeOration(
      wrapped,
      () => { console.log("\u{1F48B} Gossip column complete"); },
      { persona: "gossip" },
    );
  }
}

module.exports = { GossipBroadcast };
