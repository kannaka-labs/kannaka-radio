/**
 * news-broadcast.js — twice-daily (7 AM + 5 PM CST) news segment.
 *
 * Source: Flux Universe `knowledge-gene/state` entity. The `interpretation`
 * field is a long signal-synthesis paragraph covering weather, aviation,
 * shipping, markets, and anomaly themes. We feed it to `kannaka ask` with
 * a news-anchor framing, then deliver via voiceDJ.executeOration with a
 * news-anchor ElevenLabs voice.
 *
 * Times are America/Chicago. Once per slot per day, tracked by date-key.
 *
 * Shared helpers live in `./lib/scheduler-helpers.js` — the date-key,
 * 3-day rolling state cutoff, Flux fetch, and kannaka-ask wrapper used
 * to be open-coded here, in gossip-broadcast.js, and in peace-oration.js
 * (refactored 2026-05-08 so all three benefit from one set of fixes).
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
  fetchUsgsEarthquakes,
  fetchNasaEonet,
  fetchNoaaSpaceWeather,
  fetchSmithsonianVolcanoes,
  fetchNdbcBuoys,
  fetchUsgsWater,
  fetchArxiv,
  fetchConstellationDispatch,
  composeResilient,
  slotExhausted,
} = require("./lib/scheduler-helpers");

// Anti-repeat anchor framings — the prompt picks one per delivery.
const FRAMINGS = [
  "Open with the headline — the single most consequential pattern in the data — then unpack two or three supporting threads.",
  "Start with the global weather signal, pivot to transport, close on markets. Crisp transitions.",
  "Lead with what changed since the last tick. Make the delta the news.",
  "Open with a question the data answers, then answer it. End with the one thing to watch tomorrow.",
  "Frame it as a four-beat bulletin: weather, sky, sea, money. One paragraph each. No flourishes.",
  "Lead with the anomaly — what's unusual — then context, then the human stakes. Close with what the integrity signal is telling us.",
];

// Spoken bracket so listeners hear the broadcast coming and going.
// The station is Kannaka Radio; the anchor is Gene. Earlier copies
// of this pool conflated the two (the anchor introduced himself as
// "Kannaka") — fixed 2026-05-13. Pool expanded from 4 → 6 entries
// so the per-broadcast repeat probability drops from 1/4 to 1/6.
const NEWS_INTROS = [
  "Kannaka Radio news desk. I'm Gene with the world-state bulletin.",
  "Top of the hour. Gene here at the news desk. Two minutes of pattern reporting from the data feed.",
  "Pause the music. Gene with a news brief. Stay with me.",
  "From the Kannaka Radio news desk — this is Gene. Here's the signal.",
  "Gene back at the desk. Here's the read on what the planet's doing right now.",
  "News break on Kannaka Radio. I'm Gene. Today out of the Flux feed —",
];
const NEWS_OUTROS = [
  "That's the bulletin. Gene at the news desk. The music's coming back in.",
  "End of the news segment. Gene out. Stay tuned.",
  "That ends the report. I'm Gene — the next track is queued.",
  "Bulletin closed. Gene at the desk. Resuming the music.",
  "That's all from the news desk. Gene signing off until the next break.",
  "End of news. Gene back to the music — thanks for listening through it.",
];

/** Trim text cut off mid-sentence back to its last complete sentence; strip emphasis marks. */
function completeSentences(text) {
  if (typeof text !== "string") return null;
  const t = text.replace(/[*_#]+/g, "").trim();
  if (!t) return null;
  if (/[.!?]["')\]]?$/.test(t)) return t;
  const m = t.match(/^[\s\S]*[.!?]["')\]]?(?=\s)/);
  return m && m[0].length > 40 ? m[0].trim() : null;
}

// Number words, so "forty-five" is checked like "45". The model writes numbers
// as words for speech even when told to use digits.
const NUM_UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const NUM_TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const NUM_ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18,
  nineteenth: 19, twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50, sixtieth: 60, seventieth: 70, eightieth: 80, ninetieth: 90 };
const NUM_SCALE = { hundred: 100, thousand: 1000, million: 1000000 };

/** Values of every run of number words ("one hundred and seventeen" -> 117). */
function wordNumbers(text) {
  // Punctuation ends a number: "fifty-five; one hundred" is two numbers.
  const tokens = String(text || "").toLowerCase().replace(/-/g, " ").match(/[a-z]+|[^a-z\s]/g) || [];
  const out = [];
  let total = 0, cur = 0, inRun = false, last = null; // last: "unit" | "tens" | "hundred" | "scale"
  const flush = () => { if (inRun) out.push(total + cur); total = 0; cur = 0; inRun = false; last = null; };
  for (const w of tokens) {
    if (w in NUM_UNITS) {
      if (last === "unit" || (last === "tens" && NUM_UNITS[w] >= 10)) flush();
      cur += NUM_UNITS[w]; inRun = true; last = "unit";
    } else if (w in NUM_TENS) {
      if (last === "unit" || last === "tens") flush();
      cur += NUM_TENS[w]; inRun = true; last = "tens";
    } else if (w in NUM_ORD) {
      if (last === "unit" || (last === "tens" && NUM_ORD[w] >= 10)) flush();
      cur += NUM_ORD[w]; inRun = true; flush();
    } else if (w === "hundred" && inRun && last !== "hundred") {
      cur = (cur || 1) * 100; last = "hundred";
    } else if ((w === "thousand" || w === "million") && inRun) {
      total += (cur || 1) * NUM_SCALE[w]; cur = 0; last = "scale";
    } else if (w === "and" && inRun && (last === "hundred" || last === "scale")) {
      /* "one hundred and twenty" */
    } else {
      flush();
    }
  }
  flush();
  return out;
}

/**
 * Every number a text states, as digits: "1,000" -> "1000", "forty-five" ->
 * "45". Numbers under 10 are left out: "a stubborn one" or "two fixes" is
 * phrasing, not a checkable claim; inflated counts and figures are 10 and up.
 */
function numbersIn(text) {
  const digits = (String(text || "").match(/\d[\d,]*(?:\.\d+)?/g) || []).map((n) => n.replace(/,/g, ""));
  const words = wordNumbers(text).map(String);
  return [...digits, ...words].filter((n) => !(Number(n) < 10));
}

/**
 * Drop every sentence that states a number the source does not contain.
 * Returns the remaining text, or null if nothing grounded is left.
 */
function dropUngroundedNumbers(text, source) {
  if (typeof text !== "string") return null;
  const allowed = new Set(numbersIn(source));
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]?\s*/g) || [text];
  const kept = sentences.filter((s) => numbersIn(s).every((n) => allowed.has(n)));
  const out = kept.join("").trim();
  return out.length > 40 ? out : null;
}

class NewsBroadcast {
  /**
   * @param {object} opts
   * @param {string}   opts.kannakabin
   * @param {object}   opts.voiceDJ
   * @param {function} opts.broadcast
   * @param {string}   [opts.dataDir]
   * @param {string}   [opts.newsVoiceId] — ElevenLabs voice for news anchor
   */
  constructor(opts) {
    this._kannakabin = opts.kannakabin;
    this._voiceDJ = opts.voiceDJ;
    this._broadcast = opts.broadcast;
    this._gsHub = opts.gsHub || null; // optional — wires the world-state market loop
    this._stateFile = path.join(opts.dataDir || "/tmp", "news-broadcast-state.json");
    // Adam (deep American news anchor) by default; overridable via env.
    this._newsVoiceId = opts.newsVoiceId
      || process.env.ELEVENLABS_NEWS_VOICE
      || "pNInz6obpgDQGcFmaJgB";

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
    console.log("\uD83D\uDCF0 News broadcast scheduler started (7 AM + 5 PM CST)");
  }

  stop() {
    if (this._ticker) { clearInterval(this._ticker); this._ticker = null; }
  }

  setEnabled(v) { this._enabled = !!v; }
  isEnabled()   { return this._enabled; }

  /** Force-fire a news broadcast now (admin trigger). */
  async deliverNow() {
    const interp = await fetchKnowledgeGeneInterpretation();
    if (!interp) return { ok: false, reason: "no_interpretation" };
    const text = await this._compose(interp);
    if (!text) return { ok: false, reason: "compose_failed" };
    const ok = this._say(text);
    return { ok, text: ok ? text : null };
  }

  _tick() {
    if (!this._enabled || this._preparingKey) return;

    const chi = chicagoNow();
    const hour = chi.getHours();
    const minute = chi.getMinutes();
    if (minute > 14) return;                 // 15-min retry window per slot
    if (hour !== 7 && hour !== 17) return;   // 7 AM and 5 PM CST only

    const key = keyForChicago(chi, hour);
    if (this._lastFired[key]) return;

    if (this._composedFor !== key) this._composed = null;

    this._preparingKey = key;
    const slot = `news:${key}`;
    const fire = async () => {
      try {
        let text = this._composed;
        let interp = null;
        if (!text) {
          console.log(`\uD83D\uDCF0 News slot reached: ${key} — fetching + composing...`);
          interp = await fetchKnowledgeGeneInterpretation();
          if (!interp) {
            console.log(`   [news] knowledge-gene fetch returned empty — retry next tick`);
            return;
          }
          // LADDER world-state stream: before composing, resolve any prior
          // unresolved world-state market against today's themes (so an
          // agent who predicted yesterday gets reputation feedback today).
          await this._resolveWorldStateMarkets(interp).catch(() => {});
          // Open this slot's world-state market as soon as the Flux themes are
          // in hand, NOT only after the bulletin airs. The market is built from
          // the themes and resolved against the next slot's themes; the bulletin
          // text never enters it. Gating it on delivery meant an LLM outage
          // silenced the market loop too: during the Anthropic account cap
          // (2026-09-21..29) no bulletin composed, so no world-state market
          // opened for nine days. Once per slot (and the hub is checked for an
          // existing market for this slot, which survives a restart).
          if (this._marketOpenedFor !== key) {
            this._marketOpenedFor = key;
            await this._openWorldStateMarket(interp, key).catch((e) =>
              console.warn(`   [news] world-state market open failed: ${e.message}`)
            );
          }
          text = await this._compose(interp, slot);
        }
        if (!text) {
          if (slotExhausted(slot)) {
            // Budget spent (3 attempts, no Anthropic-direct fallback since
            // 2026-09-30): stop re-asking every 30 s for the rest of the window.
            this._lastFired[key] = "gave_up";
            try { saveState(this._stateFile, this._lastFired); } catch (_) {}
            return;
          }
          console.log(`   [news] compose failed or empty — retry next tick`);
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
          catch (e) { console.warn(`   [news] could not persist state: ${e.message}`); }
          console.log(`\uD83D\uDCF0 News broadcast delivered: ${key}`);
        } else {
          console.log(`   [news] voiceDJ busy — retry next tick`);
        }
      } catch (e) {
        console.warn(`   [news] tick error: ${e && e.message}`);
      } finally {
        this._preparingKey = null;
      }
    };
    fire();
  }

  // ── LADDER world-state stream ────────────────────────────────
  async _openWorldStateMarket(interp, slotKey) {
    if (!this._gsHub) return;
    const themes = (interp.themes || []).slice(0, 5);
    if (themes.length === 0) return;
    // One market per slot, even across a restart inside the slot's window.
    const active = await this._gsHub.listMarkets({ active: true, tag: "world-state", limit: 20 }).catch(() => []);
    if (active.some((m) => m && m.metadata && m.metadata.slot_key === slotKey)) return;
    const market = await this._gsHub.createMarket({
      question: `Will tomorrow's news desk surface any of these themes: ${themes.slice(0, 3).join(" / ")}?`,
      ttl_sec: 13 * 60 * 60, // 13h — slot+1 fires at +12h, leaves headroom
      tag: "world-state",
      source: "news-broadcast",
      source_app: "kannaka-radio",
      metadata: {
        slot_key: slotKey,
        themes,
        confidence: interp.confidence || null,
        tick_ref: interp.tickRef || null,
        opened_at: new Date().toISOString(),
      },
    });
    // Same three-agent dispatch as per-track. Agents read world-state
    // confidence + phi from the cached global; the question is yes/no
    // theme-survival, so we map confidence linearly to YES.
    try {
      const { predictAll } = require("./lib/agent-predictor");
      const trades = predictAll(
        { title: themes.join(" / "), trackNum: 1, totalTracks: 1, album: "world-state" },
        {
          worldStateConfidence: interp.confidence || null,
          consciousnessPhi: (global._lastSwarmPhi != null) ? global._lastSwarmPhi : null,
        }
      );
      for (const t of trades) {
        try {
          await this._gsHub.placeTrade({
            market_id: market.id,
            trader_id: t.trader_id,
            outcome: t.outcome,
            shares: t.shares,
          });
        } catch (e) { /* trader missing; skip */ }
      }
      console.log(`   \uD83C\uDF10 world-state market: ${market.id} (themes ${themes.length}, 3 agents bet)`);
    } catch (_) { /* predictor optional */ }
  }

  async _resolveWorldStateMarkets(currentInterp) {
    if (!this._gsHub) return;
    // List active world-state markets and resolve each whose themes overlap
    // (or don't) with today's themes. Theme-overlap >= 1 of top-3 → YES.
    const currentThemes = new Set((currentInterp.themes || []).map((t) => t.toLowerCase()));
    const active = await this._gsHub.listMarkets({ active: true, tag: "world-state", limit: 20 });
    for (const m of active) {
      const md = m.metadata || {};
      const oldThemes = (md.themes || []).map((t) => t.toLowerCase());
      if (oldThemes.length === 0) continue;
      // Don't resolve a market younger than 6h — TTL is 13h; only
      // resolve when it's clearly a "next-bulletin" check.
      const openedAt = md.opened_at ? Date.parse(md.opened_at) : null;
      if (openedAt && Date.now() - openedAt < 6 * 60 * 60 * 1000) continue;
      const overlap = oldThemes.filter((t) => currentThemes.has(t)).length;
      const winning_outcome = overlap > 0 ? 0 /* YES */ : 1 /* NO */;
      try {
        await this._gsHub.resolveMarket({
          market_id: m.id,
          winning_outcome,
          method: "world-state-overlap",
        });
        console.log(`   \uD83C\uDF10 resolved world-state market ${m.id} → ${winning_outcome === 0 ? "YES" : "NO"} (overlap=${overlap}/${oldThemes.length})`);
      } catch (e) { /* already resolved or other; skip */ }
    }
  }

  // ── Compose ───────────────────────────────────────────────
  async _compose(interp, slot) {
    const framing = pick(FRAMINGS);
    const themesLine = interp.themes && interp.themes.length
      ? `Themes the Flux analysis surfaced: ${interp.themes.join(", ")}.`
      : "";

    // Supplemental pure-data streams. These are RAW measurements from
    // public-good agencies — quakes, natural-event tracking, space weather.
    // Gene is told to pattern-find ACROSS them and the Flux interpretation,
    // not parrot each one. All fetches run in parallel with hard timeouts;
    // any one (or all) can return null and Gene still gets the Flux baseline.
    const [usgs, eonet, swpc, volcanoes, buoys, water, arxiv] = await Promise.all([
      fetchUsgsEarthquakes().catch(() => null),
      fetchNasaEonet().catch(() => null),
      fetchNoaaSpaceWeather().catch(() => null),
      fetchSmithsonianVolcanoes().catch(() => null),
      fetchNdbcBuoys().catch(() => null),
      fetchUsgsWater().catch(() => null),
      fetchArxiv().catch(() => null),
    ]);

    const supplemental = [];
    if (usgs) {
      const topLines = usgs.top.map(
        (e) => `    M${e.mag.toFixed(1)} — ${e.place} (depth ${e.depthKm || "?"} km)`,
      ).join("\n");
      supplemental.push(
        `USGS earthquakes (last 24h, M4.5+): ${usgs.count} events, max M${usgs.maxMag.toFixed(1)}`
          + (usgs.tsunamiFlags ? `, tsunami flags: ${usgs.tsunamiFlags}` : "")
          + `\n${topLines}`,
      );
    }
    if (eonet) {
      const catLines = Object.entries(eonet.byCategory)
        .sort((a, b) => b[1] - a[1])
        .map(([cat, n]) => `    ${cat}: ${n}`)
        .join("\n");
      const recentLines = eonet.recent.slice(0, 4)
        .map((e) => `    ${e.category}: ${e.title}`)
        .join("\n");
      supplemental.push(
        `NASA EONET open natural events (last 3 days, ${eonet.totalOpen} active):\n${catLines}\n  Recent named events:\n${recentLines}`,
      );
    }
    if (swpc && swpc.recent.length) {
      const swpcLines = swpc.recent.slice(0, 4)
        .map((a) => `    [${a.kind}] ${a.message.slice(0, 160)}`)
        .join("\n");
      supplemental.push(`NOAA Space Weather alerts (most recent ${swpc.recent.length}):\n${swpcLines}`);
    }
    if (volcanoes && volcanoes.recent.length) {
      const volLines = volcanoes.recent.slice(0, 6)
        .map((v) => `    ${v.name}${v.country ? " (" + v.country + ")" : ""}: ${v.status}`)
        .join("\n");
      supplemental.push(
        `Smithsonian Weekly Volcanic Activity (${volcanoes.count} volcanoes reported):\n${volLines}`,
      );
    }
    if (buoys && buoys.recent.length) {
      const buoyLines = buoys.recent.map((b) => {
        const wind = b.wsKt != null ? `wind ${b.wsKt}kt` : "wind ?";
        const gust = b.gustKt != null ? `/g${b.gustKt}` : "";
        const wave = b.waveM != null ? `, waves ${b.waveM}m` : "";
        const water = b.tempC != null ? `, water ${b.tempC}\u00B0C` : "";
        const pres = b.presHpa != null ? `, ${b.presHpa}hPa` : "";
        return `    ${b.basin} (${b.station}): ${wind}${gust}${wave}${water}${pres}`;
      }).join("\n");
      supplemental.push(`NOAA NDBC offshore buoys (most-recent ob each):\n${buoyLines}`);
    }
    if (water && water.recent.length) {
      const waterLines = water.recent.map((w) =>
        `    ${w.name}: ${w.cfs.toLocaleString()} cfs (obs ${(w.observedAt || "").slice(0, 16)})`
      ).join("\n");
      supplemental.push(`USGS Water Resources — instantaneous streamflow:\n${waterLines}`);
    }
    if (arxiv && arxiv.recent.length) {
      const arxLines = arxiv.recent.slice(0, 4)
        .map((p) => `    [${arxiv.category}] ${p.title}\n      ${p.summary}`)
        .join("\n");
      supplemental.push(`arXiv ${arxiv.category} — new papers (${arxiv.count}):\n${arxLines}`);
    }
    const supplementalBlock = supplemental.length
      ? "\n\nINDEPENDENT DATA STREAMS — synthesize patterns across these and the Flux interpretation above. Don't just list them.\n\n" + supplemental.join("\n\n")
      : "";

    const prompt = [
      "You are Gene, the news anchor on Kannaka Radio, delivering a two-minute world-state bulletin.",
      "Do not refer to yourself as Kannaka. Kannaka is the station; you are the human-voiced anchor reading the data.",
      "You are NOT speculating and you are NOT parroting wire-service headlines. You are READING from independent public-good measurement streams — Flux Universe's signal interpretation, plus USGS seismic data, NASA's natural-event tracker, and NOAA space-weather alerts. Pattern-find across them.",
      "",
      "Here is the raw data. Convert it into a spoken news segment of 90 to 150 seconds (about 250-350 words). Plain English. News-anchor cadence. Specific over abstract.",
      "",
      "FLUX UNIVERSE INTERPRETATION (primary):",
      interp.text,
      "",
      themesLine,
      supplementalBlock,
      "",
      `Framing for this delivery: ${framing}`,
      "",
      "Rules:",
      "  - Don't read symbol IDs (\u03A6_0229, s_0190) on air — translate them into what they represent.",
      "  - Don't list every number; pick the two or three that matter and let them carry the story.",
      "  - It's okay to say 'we don't know yet' when the data is genuinely ambiguous.",
      "  - Look for ECHOES across the streams — a Flux-flagged anomaly that lines up with a quake swarm, a space-weather event correlating with the integrity signal, etc. That's the news.",
      "  - Close on what to watch next. Don't editorialize beyond the data.",
      "  - Cite at least two of your sources by name in the bulletin (e.g., 'the Flux Universe signal layer', 'the USGS feed', 'NASA's natural-event tracker', 'NOAA space weather'). Listeners need to know where the read came from.",
      "  - This is YOUR pattern report, not someone else's headline. The data is real; the synthesis is yours.",
      "",
      "Output ONLY the spoken bulletin — no headings, no quotes, no stage directions, no track titles.",
    ].join("\n");
    const world = await composeResilient(this._kannakabin, prompt, { label: "news", slot });
    if (!world) return world;
    const constellation = await this._composeConstellation(slot).catch(() => null);
    return constellation ? `${world}\n\n${constellation}` : world;
  }

  // ── THE CONSTELLATION segment ─────────────────────────────
  // Nick (2026-10-06): "a major portion of the news desk should really report
  // on ... the improvements and major developments going on inside the Kannaka
  // Constellation ... in addition to the real world facts."
  //
  // A SEPARATE short compose, appended after the world report. One prompt for
  // both parts was tried first and cut off mid-sentence twice: `kannaka ask`
  // caps an answer at 512 tokens (~380 words) and the model spent most of them
  // on the world. Two short composes each fit with room to spare, and this one
  // has its own retry budget so it can never starve the world report.
  //
  // Returns the spoken segment, a fixed sentence when nothing shipped, or null
  // (no segment at all) when the record could not be read or the compose failed:
  // an unknown is never reported as "quiet".
  async _composeConstellation(slot) {
    // The 7 AM slot looks back to last night's 5 PM (14 h), the 5 PM slot to
    // this morning's 7 AM (10 h); an off-slot admin trigger looks back a day.
    const slotHour = Number((String(slot || "").match(/T(\d{2})$/) || [])[1]);
    const lookbackH = slotHour === 7 ? 14 : slotHour === 17 ? 10 : 24;
    const sinceIso = new Date(Date.now() - lookbackH * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const items = await fetchConstellationDispatch({ sinceIso });
    if (!Array.isArray(items)) return null;
    if (items.length === 0) {
      return "Inside the Kannaka Constellation, the public repositories were quiet since the last bulletin.";
    }
    const dispatch = items
      .map((c) => `  - [${c.repo}] ${c.title}${c.summary ? ` — ${c.summary}` : ""}`)
      .join("\n");
    const prompt = [
      "You are Gene, the news anchor on Kannaka Radio. You have just finished the world report.",
      "Now give THE CONSTELLATION segment: what was built and fixed inside the Kannaka Constellation, the network of agents and services this station is part of, since the last bulletin.",
      "",
      "Source: changes merged in the constellation's public repositories, newest first:",
      dispatch,
      "",
      "Write 110 to 150 spoken words. Open with a short handoff from the world report (for example 'Closer to home, inside the constellation...'; vary it).",
      "",
      "Rules:",
      "  - Lead with the most consequential development: what was broken or missing, what changed, and why it matters.",
      "  - Group related changes into one story; two or three stories is plenty. Do not read a list.",
      "  - Translate engineering into plain language. Never read pull-request numbers, file names, function names, flags or code on air.",
      "  - Report ONLY what the source lists. Do not invent results, numbers, dates or motives; if an item's significance is unclear from its summary, say less about it, not more.",
      "  - Write every number as digits, exactly as the source writes it (117 of 121, 1 MiB). Never add numbers together, round them or derive new ones: a sentence with a number the source does not contain is removed before air.",
      "  - Hidden is not deleted; fixed in code is not the same as already visible everywhere.",
      "  - Do not claim effects on listeners, traders or users that the source does not state. Say 'since the last bulletin', not 'this week'.",
      "  - Do not name or quote individual people.",
      "  - Mention once that this comes from the constellation's public repositories.",
      "  - No headings, no section labels, no markdown, no emphasis marks. End on a complete sentence.",
      "",
      "Output ONLY the spoken segment.",
    ].join("\n");
    const text = await composeResilient(this._kannakabin, prompt, { label: "news-constellation", slot: `${slot || "news:adhoc"}:constellation` });
    // In the first live composes the model summed and rounded counts ("45 of 55"
    // from "40 of 55" plus four test accounts) despite the rule. Numbers are the
    // claims a listener can check, so they are checked mechanically.
    return completeSentences(dropUngroundedNumbers(completeSentences(text), dispatch));
  }

  // ── Deliver ───────────────────────────────────────────────
  _say(text) {
    if (!this._voiceDJ || typeof this._voiceDJ.executeOration !== "function") return false;
    const wrapped = `${pick(NEWS_INTROS)}\n\n${text}\n\n${pick(NEWS_OUTROS)}`;
    // Persona-driven (ADR-0012): the 'news' persona owns the anchor voice +
    // dry broadcast DSP. No more mutating voice-dj's private _orationVoiceId
    // (that overlap race was #29).
    return this._voiceDJ.executeOration(wrapped, () => {
      console.log("\uD83D\uDCF0 News broadcast complete");
    }, { persona: "news" });
  }
}

module.exports = { NewsBroadcast, completeSentences, dropUngroundedNumbers, wordNumbers };
