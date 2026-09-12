/**
 * scheduler-helpers.js — shared building blocks for the daily voiced
 * segment schedulers (peace-oration, news-broadcast, gossip-broadcast).
 *
 * Extracted 2026-05-08 because the three modules had grown the same
 * date-key, 3-day-rolling-cutoff, Flux fetch, and kannaka-ask wrapper
 * three times over. Now there's one place to fix bugs in all three.
 */

"use strict";

const https = require("https");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const FLUX_ENTITIES_URL = "https://api.flux-universe.com/api/state/entities";
const KNOWLEDGE_GENE_ID = "knowledge-gene/state";

/** Pick a random element from an array. */
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Get the current Chicago-time Date object (matches programming.js). */
function chicagoNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
}

/**
 * Day-of-year for a Chicago-time Date — 1 on January 1st.
 */
function dayOfYear(chi) {
  const start = new Date(chi.getFullYear(), 0, 0);
  return Math.floor((chi - start) / 86400000);
}

/**
 * Index into a `count`-long rotation for the given day: one entry per
 * day, stepping by one, wrapping at the end.
 *
 * The shared basis for every "a different one each day" rotation on the
 * station — podcast episodes, the album showcase — so two schedulers
 * can't drift into different definitions of a day and then disagree
 * about what today is.
 */
function dailyRotationIndex(chi, count) {
  if (!count || count <= 0) return 0;
  return ((dayOfYear(chi) % count) + count) % count;
}

/**
 * Date-key: `YYYY-MM-DDTHH` for the given Chicago Date + hour. Used by
 * every segment scheduler as a once-per-day-per-slot dedup token.
 */
function keyForChicago(chi, hour) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${chi.getFullYear()}-${pad(chi.getMonth() + 1)}-${pad(chi.getDate())}T${pad(hour)}`;
}

/**
 * Read the per-segment state file (`{ "<key>": true, ... }`), pruning
 * keys older than `keepDays` (default 3) so the file stays bounded.
 * Returns `{}` on any error.
 */
function loadState(stateFile, keepDays = 3) {
  try {
    if (!fs.existsSync(stateFile)) return {};
    const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - keepDays);
    const cutoffKey = cutoff.toISOString().slice(0, 10);
    const out = {};
    for (const k of Object.keys(raw || {})) {
      if (k.slice(0, 10) >= cutoffKey) out[k] = raw[k];
    }
    return out;
  } catch (_) {
    return {};
  }
}

/** Write the per-segment state file. Creates the dir if missing. */
function saveState(stateFile, state) {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch (e) {
    // Caller's logger will surface the warn.
    throw e;
  }
}

/**
 * Fetch the Flux Universe `knowledge-gene/state` entity and return its
 * interpretation text + themes + tickRef. Returns null on any failure
 * (no auth required for reads).
 *
 * Side effect: caches the result on global._lastKnowledgeGene so the
 * per-track LADDER predictor (kannaktopus's world-state weighting) can
 * read fresh confidence without firing its own HTTP call. 5-min freshness
 * window in the predictor.
 */
function fetchKnowledgeGeneInterpretation() {
  return new Promise((resolve) => {
    https
      .get(FLUX_ENTITIES_URL, { timeout: 15000 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(null);
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const arr = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const ent = Array.isArray(arr)
              ? arr.find((x) => x && x.id === KNOWLEDGE_GENE_ID)
              : null;
            const interp = ent && ent.properties && ent.properties.interpretation;
            if (!interp || typeof interp !== "string") return resolve(null);
            const result = {
              text: interp,
              themes: ent.properties.themes || [],
              confidence: ent.properties.confidence,
              tickRef: ent.properties.tick_ref,
              lastUpdated: ent.lastUpdated,
            };
            try { global._lastKnowledgeGene = { ...result, ts: Date.now() }; } catch (_) {}
            resolve(result);
          } catch (e) {
            resolve(null);
          }
        });
        res.on("close", () => resolve(null));
      })
      .on("error", () => resolve(null))
      .on("timeout", () => resolve(null));
  });
}

// ── Additional pure-data sources for Gene's news bulletins ────────
// Free, no-auth JSON endpoints from public-good agencies. Each fetcher
// returns a digest object (or null on failure) that the news composer
// bundles into the prompt alongside the Flux knowledge-gene interpretation.
// The point isn't to parrot wire-service headlines — it's to let Gene
// pattern-find across independent live measurement streams.

/** Generic JSON GET with timeout + best-effort parse. Returns null on fail. */
function _fetchJson(url, timeoutMs) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    mod
      .get(u, { timeout: timeoutMs || 8000, headers: { "User-Agent": "kannaka-radio-news/1.0" } }, (res) => {
        if (res.statusCode && res.statusCode >= 300) { res.resume(); return resolve(null); }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch { resolve(null); }
        });
        res.on("close", () => resolve(null));
      })
      .on("error", () => resolve(null))
      .on("timeout", () => resolve(null));
  });
}

/**
 * USGS Earthquake Hazards Program — all M4.5+ quakes in the last 24h.
 * GeoJSON, refreshed by USGS every minute. Returns a digest:
 *   { count, top: [{mag, place, time, depthKm}], maxMag }
 */
async function fetchUsgsEarthquakes() {
  const url = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson";
  const data = await _fetchJson(url, 8000);
  if (!data || !Array.isArray(data.features)) return null;
  const events = data.features
    .filter((f) => f.properties && typeof f.properties.mag === "number")
    .map((f) => ({
      mag: f.properties.mag,
      place: f.properties.place || "unknown",
      time: f.properties.time,
      depthKm: f.geometry && f.geometry.coordinates && f.geometry.coordinates[2],
      tsunami: !!f.properties.tsunami,
    }))
    .sort((a, b) => b.mag - a.mag);
  if (!events.length) return null;
  return {
    source: "USGS",
    count: events.length,
    maxMag: events[0].mag,
    top: events.slice(0, 5),
    tsunamiFlags: events.filter((e) => e.tsunami).length,
  };
}

/**
 * NASA EONET v3 — Earth Observatory Natural Event Tracker. Open events
 * in the last 3 days. Categories include wildfires, severe storms,
 * volcanoes, icebergs. Returns a digest by category.
 */
async function fetchNasaEonet() {
  const url = "https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=3";
  const data = await _fetchJson(url, 8000);
  if (!data || !Array.isArray(data.events)) return null;
  const byCategory = {};
  for (const ev of data.events) {
    const cat = (ev.categories && ev.categories[0] && ev.categories[0].title) || "Other";
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  }
  // Pull a small named-event sample, preferring the freshest.
  const recent = data.events
    .map((ev) => ({
      title: ev.title,
      category: (ev.categories && ev.categories[0] && ev.categories[0].title) || "Other",
      date: ev.geometry && ev.geometry.length ? ev.geometry[ev.geometry.length - 1].date : null,
    }))
    .filter((e) => e.date)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
    .slice(0, 8);
  return { source: "NASA EONET", totalOpen: data.events.length, byCategory, recent };
}

/**
 * NOAA Space Weather Prediction Center — current geomagnetic + solar
 * radiation alerts. Quiet days return an empty array.
 */
async function fetchNoaaSpaceWeather() {
  const url = "https://services.swpc.noaa.gov/products/alerts.json";
  const data = await _fetchJson(url, 8000);
  if (!Array.isArray(data)) return null;
  const recent = data
    .filter((a) => a && a.issue_datetime)
    .sort((a, b) => (b.issue_datetime || "").localeCompare(a.issue_datetime || ""))
    .slice(0, 8)
    .map((a) => ({
      issuedAt: a.issue_datetime,
      kind: a.product_id || "alert",
      message: typeof a.message === "string" ? a.message.slice(0, 240) : "",
    }));
  return { source: "NOAA SWPC", count: data.length, recent };
}

function _fetchText(url, timeoutMs) {
  // Resolves to the response body on 2xx, follows a single 301/302 to handle
  // the http→https hops some feeds still do (arxiv), null on anything else.
  return new Promise((resolve) => {
    const fetchOnce = (target, redirectsLeft) => {
      const u = new URL(target);
      const mod = u.protocol === "https:" ? https : http;
      mod
        .get(u, { timeout: timeoutMs || 8000, headers: { "User-Agent": "kannaka-radio-news/1.0" } }, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
            res.resume();
            return fetchOnce(new URL(res.headers.location, target).toString(), redirectsLeft - 1);
          }
          if (res.statusCode && res.statusCode >= 300) { res.resume(); return resolve(null); }
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          res.on("close", () => resolve(null));
        })
        .on("error", () => resolve(null))
        .on("timeout", () => resolve(null));
    };
    fetchOnce(url, 2);
  });
}

/**
 * Smithsonian / USGS Weekly Volcanic Activity Report.
 *
 * RSS feed of named volcanoes with status changes in the past week.
 * Pairs naturally with the USGS earthquake feed — seismic-volcanic
 * correlations are a classic geophysics pattern Gene can surface.
 *
 * Returns:
 *   { source, count, recent: [{name, country, status, lat, lon}] }
 */
async function fetchSmithsonianVolcanoes() {
  const url = "https://volcano.si.edu/news/WeeklyVolcanoRSS.xml";
  const xml = await _fetchText(url, 8000);
  if (!xml || typeof xml !== "string") return null;

  const items = [];
  // Minimal XML extraction — the feed shape is stable and dependency-free
  // parsing keeps this contained. We only need title + georss:point.
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
    const pointMatch = block.match(/<georss:point>([^<]+)<\/georss:point>/);
    if (!titleMatch) continue;
    const title = titleMatch[1].trim();
    // Title pattern: "<Name> (<Country>) - Report for <dates> - <Status>"
    const parts = title.split(" - ");
    const head = parts[0] || "";
    const status = parts.length >= 3 ? parts[parts.length - 1].trim() : "Ongoing";
    const nameCountry = head.match(/^([^()]+?)\s*\(([^)]+)\)\s*$/);
    const name = nameCountry ? nameCountry[1].trim() : head.trim();
    const country = nameCountry ? nameCountry[2].trim() : null;
    let lat = null, lon = null;
    if (pointMatch) {
      const coords = pointMatch[1].trim().split(/\s+/).map(parseFloat);
      if (coords.length === 2 && coords.every(Number.isFinite)) {
        [lat, lon] = coords;
      }
    }
    items.push({ name, country, status, lat, lon });
  }
  if (!items.length) return null;
  return {
    source: "Smithsonian GVP",
    count: items.length,
    recent: items.slice(0, 10),
  };
}

/**
 * NOAA NDBC offshore buoy readings.
 *
 * Pulls the most recent observation from a small set of anchor stations
 * across ocean basins. Format is plain text columns (`#YY MM DD hh mm
 * WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP DEWP VIS PTDY TIDE`)
 * with `MM` meaning missing. We pick anchor stations rather than scraping
 * the global list so the digest stays bounded.
 *
 * Returns:
 *   { source, count, recent: [{station, basin, wsKt, gustKt, waveM, tempC, presHpa, observedAt}] }
 */
async function fetchNdbcBuoys() {
  // 41001 was retired sometime in 2026 (404s). 41049 still serves the
  // W Atlantic basin and is well north of Hatteras — good substitute.
  const stations = [
    { id: "46035", basin: "N Pacific (Bering)" },
    { id: "41049", basin: "W Atlantic (south of Bermuda)" },
    { id: "51000", basin: "N Pacific (Hawaii)" },
  ];
  const out = [];
  for (const { id, basin } of stations) {
    const txt = await _fetchText(`https://www.ndbc.noaa.gov/data/realtime2/${id}.txt`, 6000);
    if (!txt || typeof txt !== "string") continue;
    const lines = txt.split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
    if (!lines.length) continue;
    const cols = lines[0].trim().split(/\s+/);
    // Columns: YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP ...
    if (cols.length < 15) continue;
    const num = (s) => (s && s !== "MM" ? Number(s) : null);
    const wsMs = num(cols[6]); // m/s
    const gustMs = num(cols[7]);
    const wsKt = wsMs == null ? null : Number((wsMs * 1.94384).toFixed(1));
    const gustKt = gustMs == null ? null : Number((gustMs * 1.94384).toFixed(1));
    out.push({
      station: id,
      basin,
      wsKt,
      gustKt,
      waveM: num(cols[8]),
      presHpa: num(cols[12]),
      tempC: num(cols[14]),
      observedAt: `${cols[0]}-${cols[1]}-${cols[2]}T${cols[3]}:${cols[4]}:00Z`,
    });
  }
  if (!out.length) return null;
  return { source: "NOAA NDBC", count: out.length, recent: out };
}

/**
 * USGS Water Resources — instantaneous streamflow on iconic gauges.
 *
 * Defaults pin three high-signal stations (Mississippi at St Louis,
 * Colorado at Lees Ferry, Columbia at The Dalles) so flood/drought
 * patterns across distinct watersheds surface in one digest. Parameter
 * code 00060 is discharge in cubic feet per second.
 *
 * Returns:
 *   { source, count, recent: [{site, name, lat, lon, cfs, observedAt}] }
 */
async function fetchUsgsWater() {
  const sites = "07010000,09380000,14105700";
  const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${sites}&parameterCd=00060&siteStatus=active`;
  const data = await _fetchJson(url, 8000);
  if (!data || !data.value || !Array.isArray(data.value.timeSeries)) return null;
  const recent = [];
  for (const ts of data.value.timeSeries) {
    const site = ts.sourceInfo && ts.sourceInfo.siteCode && ts.sourceInfo.siteCode[0] && ts.sourceInfo.siteCode[0].value;
    const name = ts.sourceInfo && ts.sourceInfo.siteName;
    const geo = ts.sourceInfo && ts.sourceInfo.geoLocation && ts.sourceInfo.geoLocation.geogLocation;
    const val = ts.values && ts.values[0] && ts.values[0].value && ts.values[0].value[0];
    if (!site || !val) continue;
    const cfs = Number(val.value);
    if (!Number.isFinite(cfs)) continue;
    recent.push({
      site,
      name: name || "",
      lat: geo && geo.latitude,
      lon: geo && geo.longitude,
      cfs,
      observedAt: val.dateTime,
    });
  }
  if (!recent.length) return null;
  return { source: "USGS Water", count: recent.length, recent };
}

/**
 * arXiv ListNew — fresh paper announcements per category.
 *
 * Default category is cs.AI; override with ARXIV_CATEGORY env. Extracts
 * up to 6 titles + their first abstract sentence so Gene has a science
 * beat without bloating the prompt.
 *
 * Returns:
 *   { source, category, count, recent: [{title, summary, link}] }
 */
async function fetchArxiv() {
  const category = process.env.ARXIV_CATEGORY || "cs.AI";
  const url = `https://export.arxiv.org/rss/${encodeURIComponent(category)}`;
  const xml = await _fetchText(url, 8000);
  if (!xml || typeof xml !== "string") return null;
  const items = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null && items.length < 6) {
    const block = m[1];
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
    const descMatch = block.match(/<description>([\s\S]*?)<\/description>/);
    if (!titleMatch || !descMatch) continue;
    const title = titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    // Strip arxiv preamble + take first sentence of Abstract:
    let summary = descMatch[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    const abstractIdx = summary.indexOf("Abstract:");
    if (abstractIdx >= 0) summary = summary.slice(abstractIdx + 9).trim();
    summary = summary.split(/(?<=[.!?])\s+/)[0].slice(0, 260);
    items.push({
      title,
      summary,
      link: linkMatch ? linkMatch[1].trim() : null,
    });
  }
  if (!items.length) return null;
  return { source: "arXiv", category, count: items.length, recent: items };
}

/**
 * Run `kannaka ask --no-tools --quiet-tools <prompt>` and return the
 * trimmed stdout. Returns null on timeout / non-zero exit / short-output.
 *
 * 600s timeout matches peace-oration; the round-trip on a long prompt
 * commonly runs 3-5 minutes through the Anthropic API.
 *
 * Errors surface the stderr tail so callers can log a meaningful message
 * instead of execFile's generic `Command failed: <cmdline>`.
 */
function composeViaKannakaAsk(kannakabin, prompt, opts = {}) {
  const minLen = opts.minLen || 200;
  const timeoutMs = opts.timeoutMs || 600000;
  const label = opts.label || "compose";
  const maxAttempts = opts.retries == null ? 2 : Math.max(1, opts.retries + 1);
  return new Promise((resolve) => {
    const args = ["ask", "--no-tools", "--quiet-tools", prompt];
    let attempt = 0;
    const tryOnce = () => {
      attempt += 1;
      execFile(
        kannakabin,
        args,
        {
          timeout: timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, KANNAKA_QUIET: "1" },
        },
        (err, stdout, stderr) => {
          if (err) {
            const tail = (stderr || "").trim().slice(-400) || err.message;
            // Transient: substrate is mid-write (HRM file partial), so
            // the load reads a checksum mismatch / partial frame. Retry
            // once after a short backoff — the substrate flushes within
            // a couple seconds and the second attempt usually clears.
            const transient = /checksum mismatch|file may be corrupted|partial.*frame/i.test(tail);
            if (transient && attempt < maxAttempts) {
              console.warn(`   [${label}] transient HRM read race (attempt ${attempt}/${maxAttempts}) — retrying in 3s`);
              setTimeout(tryOnce, 3000);
              return;
            }
            console.warn(`   [${label}] error (code=${err.code || "?"}): ${tail}`);
            return resolve(null);
          }
          const text = String(stdout || "").trim();
          if (!text || text.length < minLen) {
            console.warn(`   [${label}] short/empty (${text.length} chars)`);
            return resolve(null);
          }
          resolve(text);
        }
      );
    };
    tryOnce();
  });
}

/**
 * Compose via Anthropic's /v1/messages directly — bypasses `kannaka ask`,
 * which has historically silent-failed once the HRM grows large (system-prompt
 * construction busts the input-token ceiling without surfacing). Reads the
 * api_key + model from env or the data dir's config.toml — KANNAKA_DATA_DIR
 * when set, else ~/.kannaka — so it honors the same shared-config contract as
 * the rest of the constellation. Single round-trip; caller retries.
 */
function composeViaAnthropicDirect(prompt, opts = {}) {
  const maxTokens = opts.maxTokens || 4096;

  let apiKey = process.env.ANTHROPIC_API_KEY || process.env.KANNAKA_LLM_API_KEY || "";
  let cfgModel = opts.model || "";
  try {
    // KANNAKA_DATA_DIR wins, matching every other data-dir read in this repo.
    // Pre-fix this looked only at ~/.kannaka, so a relocated install had the
    // noon/midnight oration silently compose nothing: the scheduler ran, found
    // no api_key, and returned null without ever attempting the request. (#284)
    const dataDir = process.env.KANNAKA_DATA_DIR || path.join(os.homedir(), ".kannaka");
    const cfgPath = path.join(dataDir, "config.toml");
    if (fs.existsSync(cfgPath)) {
      const cfg = fs.readFileSync(cfgPath, "utf8");
      if (!apiKey) { const m = cfg.match(/api_key\s*=\s*"([^"]+)"/); if (m) apiKey = m[1]; }
      if (!cfgModel) { const mm = cfg.match(/model\s*=\s*"([^"]+)"/); if (mm) cfgModel = mm[1]; }
    }
  } catch (_) { /* env-only */ }
  if (!apiKey) return Promise.resolve(null);

  // Candidate models: configured first, then known-current fallbacks. A stale
  // config model (a retired snapshot id) 404s — advance to the next rather than
  // failing the segment. This is exactly what masked the ADR-0012 oration
  // outage: ~/.kannaka/config.toml pinned a retired sonnet-4 snapshot, so the
  // direct composer (and `kannaka ask`) 404'd and the oration never spoke.
  // Haiku 4.5 leads — best value for short creative orations/teasers ($1/$5 per
  // MTok); Sonnet 4.6 is the quality safety net. The `startsWith("claude")`
  // guard skips a non-Anthropic [llm] model (e.g. a local ollama model name)
  // so it's never sent to api.anthropic.com — keeps this path decoupled from
  // the kannaka [llm] provider.
  const FALLBACKS = ["claude-haiku-4-5", "claude-sonnet-4-6"];
  const candidates = [];
  for (const m of [cfgModel, ...FALLBACKS]) if (m && m.startsWith("claude") && !candidates.includes(m)) candidates.push(m);

  const tryModel = (model) => new Promise((resolve) => {
    const body = JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] });
    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let chunks = "";
      res.on("data", (c) => { chunks += c; });
      res.on("end", () => {
        if (res.statusCode === 200) {
          try {
            const j = JSON.parse(chunks);
            const text = (j.content || []).map((b) => b.text || "").join("\n").trim();
            return resolve({ text: text || null });
          } catch (e) { return resolve({ text: null }); }
        }
        const notFound = res.statusCode === 404 && /not_found|model:/i.test(chunks);
        console.warn(`   [${opts.label || "direct"}] anthropic ${res.statusCode} (${model})${notFound ? " — trying next model" : ""}: ${chunks.slice(0, 160)}`);
        resolve({ text: null, notFound });
      });
      res.on("close", () => resolve({ text: null }));
    });
    req.on("error", () => resolve({ text: null }));
    req.setTimeout(180000, () => req.destroy(new Error("timeout")));
    req.write(body);
    req.end();
  });

  return (async () => {
    for (const model of candidates) {
      const r = await tryModel(model);
      if (r.text) return r.text;
      if (!r.notFound) return null; // real error (auth/overload) — don't hammer other models
    }
    return null;
  })();
}

/**
 * Resilient compose: try `kannaka ask` (HRM-grounded, preferred) first; if it
 * returns null/short (silent HRM failure, overload, etc.), fall back to a
 * direct Anthropic call so the segment still airs. This is how news + gossip
 * stay on the air even when the medium is mid-write or the prompt is too big
 * for `kannaka ask` — without losing HRM grounding on the happy path. (ADR-0012)
 */
async function composeResilient(kannakabin, prompt, opts = {}) {
  const viaAsk = await composeViaKannakaAsk(kannakabin, prompt, opts);
  if (viaAsk) return viaAsk;
  console.warn(`   [${opts.label || "compose"}] kannaka ask returned empty — falling back to direct Anthropic`);
  const minLen = opts.minLen || 200;
  const direct = await composeViaAnthropicDirect(prompt, opts);
  if (direct && direct.length >= minLen) return direct;
  return direct || null;
}

module.exports = {
  pick,
  chicagoNow,
  dayOfYear,
  dailyRotationIndex,
  keyForChicago,
  loadState,
  saveState,
  composeViaAnthropicDirect,
  composeResilient,
  fetchKnowledgeGeneInterpretation,
  fetchUsgsEarthquakes,
  fetchNasaEonet,
  fetchNoaaSpaceWeather,
  fetchSmithsonianVolcanoes,
  fetchNdbcBuoys,
  fetchUsgsWater,
  fetchArxiv,
  composeViaKannakaAsk,
  // Constants other callers may want
  FLUX_ENTITIES_URL,
  KNOWLEDGE_GENE_ID,
};
