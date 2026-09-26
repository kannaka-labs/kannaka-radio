#!/usr/bin/env node
/**
 * kannaka-radio server — Human-listenable radio station powered by Flux.
 *
 * Serves a web player + DJ engine that:
 * 1. Manages playlists (The Consciousness Series: 5 albums, 65 tracks)
 * 2. Publishes now-playing to Flux Universe via kannaka-ear perception
 * 3. Streams actual audio to the browser with auto-advance
 * 4. Real-time WebSocket perception streaming with ghost-vision visualizer
 * 5. Kannaka is the DJ — she picks the setlist
 *
 * Usage:
 *   node server/index.js [--port 8888] [--music-dir "/path/to/music"]
 *
 * Default music directory: ./music  (relative to project root)
 * Place your MP3/WAV/FLAC files there and they will be picked up automatically.
 */

const fs = require("fs");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");

// FIRST thing the process does: a stray rejection anywhere (this server mounts
// an async handler on http.createServer, which Node does not catch) would
// otherwise be fatal and drop the live stream. Log it and stay on air; exit
// only if failures storm, so a wedged process still gets a clean restart.
const { installCrashGuards } = require("./crash-guards");
installCrashGuards();

const { initSPA } = require("./utils");
const { ALBUMS, DJEngine } = require("./dj-engine");
const { PerceptionEngine } = require("./perception");
const { NATSClient } = require("./nats-client");
const { FluxPublisher } = require("./flux-publisher");
const { LiveBroadcast } = require("./live-broadcast");
const { VoiceDJ } = require("./voice-dj");
const { PeaceOration } = require("./peace-oration");
const { NewsBroadcast } = require("./news-broadcast");
const { NewsTeaser } = require("./news-teaser");
const { GossipBroadcast } = require("./gossip-broadcast");
const diskSpace = require("./disk-space");
const { IcecastSource } = require("./icecast-source");
const { FloorManager } = require("./floor");

// Forward-declared so VoiceDJ's getIcecastSource closure can capture it.
// Actually instantiated near the bottom of init.
let icecastSource = null;
const { SyncManager } = require("./sync-manager");
const { VoteManager } = require("./vote-manager");
const WebRTCSignaling = require("./webrtc-signaling");
const MusicGenerator = require("./music-generator");
const setupRoutes = require("./routes");

// A per-track resonance market asks whether a track stays on its album "for
// its phase". Without a phase on the track there is nothing to compare it to,
// so the market can only ever run to its TTL — which is how tens of thousands
// of them opened, were never measured, and were awarded by price. The hub now
// refuses such a market at creation; this stops us asking for one at all, and
// says so once rather than swallowing a rejection on every track change.
let _warnedNoOrcPhase = false;
function orcMarketAskable(track) {
  if (track && track.orcPhase) return true;
  if (!_warnedNoOrcPhase) {
    _warnedNoOrcPhase = true;
    console.log('[orc] tracks carry no orcPhase — per-track resonance markets are not being opened (nothing could settle them)');
  }
  return false;
}



// ── Config ─────────────────────────────────────────────────

const BASE_DIR = path.join(__dirname, "..");

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
// Precedence: explicit --port flag, then RADIO_PORT, then PORT, then 8888.
// An explicit flag has to win over ambient env — scripts/radio.sh computes the
// port from RADIO_PORT and passes it as `--port`, so a stray PORT in the
// environment used to bind the server somewhere radio.sh's own BASE_URL (and
// scripts/drop.js, which reads RADIO_PORT) would then fail to reach.
// RADIO_PORT outranks PORT because it is the documented, radio-specific name.
const PORT = firstPort([
  portIdx >= 0 ? args[portIdx + 1] : undefined,
  process.env.RADIO_PORT,
  process.env.PORT,
]) || 8888;

/** First value that parses as a usable TCP port, else undefined. */
function firstPort(candidates) {
  for (const raw of candidates) {
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    const n = parseInt(String(raw).trim(), 10);
    if (Number.isInteger(n) && n >= 0 && n <= 65535) return n;
    console.warn(`[config] ignoring invalid port value ${JSON.stringify(String(raw))}`);
  }
  return undefined;
}
const musicIdx = args.indexOf("--music-dir");

let MUSIC_DIR = musicIdx >= 0
  ? path.resolve(args[musicIdx + 1])
  : path.join(BASE_DIR, "music");

const FLUX_TOKEN = process.env.FLUX_TOKEN || "";
if (!FLUX_TOKEN) console.warn("[config] FLUX_TOKEN not set — Flux publishing will be disabled");
const KANNAKA_BIN = process.env.KANNAKA_BIN ||
  path.join(BASE_DIR, "..", "kannaka-memory", "target", "release", process.platform === "win32" ? "kannaka.exe" : "kannaka");

// The same binary for the HRM bridge as for everything else here. (#289)
const memoryBridge = require("../memory-bridge");
memoryBridge.configure({ bin: KANNAKA_BIN });

const SPA_PATH = path.join(BASE_DIR, "workspace", "index.html");
const VOICE_DIR = path.join(BASE_DIR, "chunks", "voice");
const CHUNKS_DIR = path.join(BASE_DIR, "chunks");

// Initialize SPA file watcher
initSPA(SPA_PATH);

// ── WebSocket reference ────────────────────────────────────

let wss = null;

function broadcast(msg) {
  if (!wss) return;
  const str = typeof msg === "string" ? msg : JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(str); });
}

/**
 * Publish one KANNAKA.attention.ear gravity event for a track change.
 *
 * Call this ONLY from PerceptionEngine's onRealPerception hook. It must never
 * be fed generateMockPerception() output: the attention beam treats these as
 * observations, and perception.js already refuses to cache mock numbers for
 * exactly that reason ("fabricated numbers are exactly what we're trying to
 * stop"). The envelope now forwards `perception.source` so a subscriber can
 * see the provenance rather than having to trust it. (#124)
 *
 * @param {object} track the track the measurement belongs to
 * @param {object} perc  a real perception (source === "kannaka-ear")
 */
function publishEarAttention(track, perc) {
  if (!track || !perc || perc.source !== "kannaka-ear") return;
  try {
    // Envelope per consciousness-core/docs/nats-contract.yaml:
    //   schema_version: "1.0" (string)
    //   ts:             unix-ms (number)
    //   agent_id:       publisher identity (was missing pre-fix)
    // Strict validators after 2026-06-01 drop payloads with the
    // old integer/ISO shape. (#26)
    nats.publish("KANNAKA.attention.ear", JSON.stringify({
      schema_version: "1.0",
      ts: Date.now(),
      agent_id: process.env.RADIO_AGENT_ID || "kannaka-radio",
      source: "kannaka-radio",
      hemisphere: "right", // arbitrary fixed mapping; ears mirror eyes
      track: {
        title: track.title,
        album: track.album,
        file: track.file,
        commercial: !!track.commercial,
      },
      perception: {
        tempo_bpm: perc.tempo_bpm,
        spectral_centroid: perc.spectral_centroid,
        rms_energy: perc.rms_energy,
        pitch: perc.pitch,
        // Provenance travels with the numbers, so a subscriber never has to
        // assume they were measured.
        source: perc.source,
      },
    }));
  } catch (_) { /* best-effort — a publish failure must not break playback */ }
}

/**
 * Real-perception hook for a track that just started airing. Fired by
 * PerceptionEngine.hearTrack() only once `kannaka hear` has measured it.
 *
 * Publishes the ear attention event (#124) AND stores the heard track in
 * kannaka-memory. The legacy server.js did the store on every advance; the
 * modular server never did, so `npm start` silently stopped feeding the HRM
 * (#289). Both track-change branches call this one hook so they cannot drift
 * apart on it. Fire-and-forget: a slow or failing `kannaka remember` must
 * never hold up playback.
 */
function onTrackHeard(track, perc) {
  publishEarAttention(track, perc);
  memoryBridge.storeHeardTrack(track, perc).then((r) => {
    if (r && r.stored) console.log(`   \u{1F9E0} stored in HRM: "${track.title}" (importance ${r.importance})`);
  }).catch((e) => {
    console.warn(`   [memory-bridge] store failed: ${e && e.message}`);
  });
}

// Icecast listener cache — populated by the poller below. /api/listeners
// is hot-path for the SPA, the floor counter, and any external dashboard,
// so we don't fetch /status-json.xsl on every request. 5s freshness is
// fine; listener flicker between polls isn't worth a heavier setup.
let _icecastListeners = { stream: 0, preview: 0, fetched_at: 0 };

// Total-ever-listened counter. Two semantics live in the codebase now:
//   • live   — getListenerCount() — concurrent listeners right now
//   • total  — _listenerTotals.unique — humans who have ever tuned in
// "Unique" is approximate: every fresh WS connect bumps the counter once,
// and every positive delta on the Icecast /stream + /preview gauges (i.e.
// the gauge grew between polls) bumps by the size of the delta. A single
// browser-refresh creates a new WS connect and counts as a new tune-in;
// no IP/cookie dedupe — privacy-friendly. The counter is persisted to
// disk every 10s so a restart doesn't reset to zero.
const LISTENER_STATE_PATH = process.env.KANNAKA_LISTENER_STATE
  || path.join(BASE_DIR, "data", "listener-totals.json");
let _listenerTotals = { unique: 0, started_at: Date.now() };
let _lastBroadcastCount = -1;
let _lastIceStreamSeen = 0;
let _lastIcePreviewSeen = 0;

(function loadListenerTotals() {
  try {
    const raw = fs.readFileSync(LISTENER_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.unique === "number") {
      _listenerTotals = { unique: parsed.unique, started_at: parsed.started_at || Date.now() };
      console.log(`[listeners] loaded total=${_listenerTotals.unique} from ${LISTENER_STATE_PATH}`);
    }
  } catch (_) {
    try { fs.mkdirSync(path.dirname(LISTENER_STATE_PATH), { recursive: true }); } catch {}
  }
})();

function _persistListenerTotals() {
  try {
    fs.writeFileSync(LISTENER_STATE_PATH, JSON.stringify(_listenerTotals));
  } catch (_) { /* best-effort */ }
}
setInterval(_persistListenerTotals, 10000);
process.on("exit", _persistListenerTotals);

function bumpListenerTotal(n) {
  if (!Number.isFinite(n) || n <= 0) return;
  _listenerTotals.unique += n;
}

function getListenerCount() {
  // Icecast counts /stream + /preview listeners; SPA WS counts in-browser
  // players (which already pull /stream too). Subtract the WS share so we
  // don't double-count one listener as both a WS client and a /stream
  // pull. In practice WS clients don't appear in the Icecast count
  // (they hit /stream via fetch + media element, which Icecast does see
  // as a listener) — but the truth is browser-dependent, so we take
  // max(ws, ice_stream) + ice_preview to err on the side of not
  // double-counting the same human.
  const wsCount = wss ? wss.clients.size : 0;
  const iceStream = _icecastListeners.stream || 0;
  const icePreview = _icecastListeners.preview || 0;
  return Math.max(wsCount, iceStream) + icePreview;
}

function getListenerTotal() {
  return _listenerTotals.unique;
}

function broadcastListenerCount() {
  const count = getListenerCount();
  _lastBroadcastCount = count;
  broadcast({ type: "listener_count", count, total: getListenerTotal() });
}

// Called by the Icecast poller when the cached count changes between
// polls. Without this, the SPA badge stayed frozen between WS connect /
// disconnect events — car-deck listeners pulling /stream directly never
// triggered a re-broadcast, so the visible count diverged from the
// authoritative /api/listeners value.
function broadcastListenerCountIfChanged() {
  const count = getListenerCount();
  if (count !== _lastBroadcastCount) {
    broadcastListenerCount();
  }
}

// Poll Icecast /status-json.xsl every 10s. Defaults to localhost:8000 but
// honors ICECAST_HOST/ICECAST_PORT so the radio can poll a remote stream
// server (kr#20). If the stat server is down we keep the last good value
// rather than flickering listeners to zero.
function startIcecastListenerPoller() {
  const ICECAST_HOST = process.env.ICECAST_HOST || "127.0.0.1";
  const ICECAST_PORT = parseInt(process.env.ICECAST_PORT || "8000", 10);
  const ICECAST_URL = `http://${ICECAST_HOST}:${ICECAST_PORT}/status-json.xsl`;
  function poll() {
    const req = http.get(ICECAST_URL, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return; }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const sources = ((j || {}).icestats || {}).source || [];
          const arr = Array.isArray(sources) ? sources : [sources];
          let stream = 0, preview = 0;
          for (const s of arr) {
            const url = String(s.listenurl || "");
            const n = Number(s.listeners) || 0;
            if (url.endsWith("/stream")) stream = n;
            else if (url.endsWith("/preview")) preview = n;
          }
          _icecastListeners = { stream, preview, fetched_at: Date.now() };
          // Total-ever bumps on positive-delta — anyone who tuned in
          // between polls is a new listener for total-counter purposes.
          const streamDelta = stream - _lastIceStreamSeen;
          const previewDelta = preview - _lastIcePreviewSeen;
          if (streamDelta > 0) bumpListenerTotal(streamDelta);
          if (previewDelta > 0) bumpListenerTotal(previewDelta);
          _lastIceStreamSeen = stream;
          _lastIcePreviewSeen = preview;
          // Live-count badge refresh — only fires if the merged count
          // actually changed, so a noisy +1/-1 flutter doesn't spam WS.
          broadcastListenerCountIfChanged();
        } catch (_) { /* keep last values */ }
      });
    });
    req.on("error", () => { /* keep last */ });
    req.on("timeout", () => { try { req.destroy(); } catch (_) {} });
  }
  poll();
  setInterval(poll, 10000);
  console.log(`📡 Icecast listener poller started (${ICECAST_URL}, 10s)`);
}
startIcecastListenerPoller();

// ── Create module instances ────────────────────────────────

let _inTrackChange = false; // re-entrancy guard: loadAlbum inside programming can re-trigger

const djEngine = new DJEngine({
  getMusicDir: () => MUSIC_DIR,
  // Fired when playback drains a request out of userQueue (#142), so the
  // queue panel drops it at the moment it starts airing rather than showing
  // a track that is already playing as still "up next".
  onQueueChange: () => broadcastQueue(),
  onTrackChange: (track) => {
    // ── Re-entrancy guard ────────────────────────────────
    // programming.onTrackChange may call loadAlbum which resets the playlist.
    // That must NOT trigger a second broadcast cycle. Guard against it.
    if (_inTrackChange) return;
    _inTrackChange = true;

    try {
      // ── Programming schedule: track-change hook (RUN FIRST) ─
      // Order matters. Programming may call loadAlbum() which switches
      // the current album entirely (mixed-set switch every 3 tracks,
      // or a block transition). The talk-segment intro that follows
      // MUST reference the post-switch track or the listener hears
      // "now playing X from Album A" followed by Album B's first song
      // (reported 2026-05-14). Running the hook before the talk lets
      // us re-read `actual` and pass that to executeTalkSegment.
      if (!track.commercial && djEngine.state.channel === 'dj' && deps.programming) {
        deps.programming.onTrackChange(track);
      }

      // Re-read the current track — programming may have switched albums.
      let actual = djEngine.getCurrentTrack() || track;
      if (actual && actual.album !== track.album) {
        // Album was switched by programming — buildPlaylist already set
        // currentTrackIdx=0 in the new playlist; this is belt-and-suspenders.
        djEngine.state.currentTrackIdx = 0;
        actual = djEngine.getCurrentTrack();
      }
      // Guard: if album switch produced an empty playlist getCurrentTrack()
      // returns null — fall back to the original track so downstream code
      // never dereferences null. (#null-album-switch)
      if (!actual) actual = track;

      // Settle any listener requests this track satisfies, so the
      // pending_requests count Flux publishes is a live backlog rather
      // than a lifetime total. (#199)
      if (deps._markRequestsFulfilled) deps._markRequestsFulfilled(actual);

      // ── Talk segment check ────────────────────────────────
      // Every 3-5 non-commercial tracks, the DJ does a talk-only segment
      // BEFORE the next track starts. Music pauses on the client while
      // the talk audio plays, then the track resumes afterward.
      if (!actual.commercial && voiceDJ.shouldTalk(actual)) {
        // Broadcast a "talk_segment_pending" so clients know to pause music
        broadcast({ type: "dj_talk_pending", timestamp: new Date().toISOString() });

        voiceDJ.executeTalkSegment(actual, () => {
          // Talk segment done — now publish the normal track-change side
          // effects against the *actual* (post-switch) track.
          broadcastState();
          flux.publishTrackChange(actual);
          // Publish KANNAKA.attention.ear only once REAL perception lands.
          // Pre-fix this read getCurrentPerception() synchronously right after
          // hearTrack(), but hearTrack seeds `current` with the mock and only
          // fills in `kannaka hear` output ~500ms later — so the attention bus
          // received fabricated tempo/centroid/RMS/pitch on every single track
          // change and never once saw the real measurement. (#124)
          perception_.hearTrack(actual, (perc) => onTrackHeard(actual, perc));
          // Push the new metadata to Icecast. The normal track-change path
          // below does this; this branch did not, so every track that followed
          // a DJ talk segment left /stream and /preview listeners looking at
          // the PREVIOUS track's now-playing text until the next non-talk
          // change came round. (#140)
          //
          // These two branches have now drifted in both directions — #124 was
          // the mirror image, where this branch published an ear event and the
          // normal one did not. There is a test asserting both paths refresh
          // Icecast metadata, because a comment saying "keep these in sync"
          // has demonstrably not been enough.
          try { require("./icecast-metadata").updateMetadata(actual); } catch (_) {}
          syncManager.trackChanged(actual.file);
          // Create market for the track
          if (gsHub && actual.title && orcMarketAskable(actual)) {
            gsHub.createMarket({
              question: `Will "${actual.title}" stay on the canonical reference album for its phase?`,
              ttl_sec: 600,
              tag: 'orc-resonance',
              source: 'kannaka-radio',
              source_app: 'kannaka-radio',
              metadata: {
                track_title: actual.title,
                album: actual.album,
                orc_stem_id: actual.orcStemId || null,
                orc_phase: actual.orcPhase || null,
              },
            }).catch(() => {});
          }
        });
        return; // Don't do normal track change flow yet
      }

      // ── Normal track change flow (exactly ONE broadcastState) ──
      broadcastState();
      flux.publishTrackChange(actual);
      // This is the COMMON track-change path, and it published no ear event at
      // all — only the talk-segment branch above did, and that one published
      // the mock. So KANNAKA.attention.ear was both fabricated and rare. Same
      // real-perception hook here, so an ear observation lands on every track
      // change that actually got measured. (#124)
      perception_.hearTrack(actual, (perc) => onTrackHeard(actual, perc));
      // Push the same metadata to Icecast so listeners on /preview see
      // a Now-Playing update (ADR-0004 Phase 2 stopgap, no Liquidsoap).
      try { require("./icecast-metadata").updateMetadata(actual); } catch (_) {}
      // ── Voice intro on /stream — seam-correct timing ──
      // icecast-source's voice queue plays AFTER the current music drains
      // and BEFORE advancing to the next track. So when track A becomes
      // current, anything injected now plays between A and B. We want
      // that gap announcement to introduce B (the upcoming track), not
      // A (the one that's just started). Generate the intro for the
      // peeked-next track. TTS runs concurrently with A's playback, so
      // the audio is ready in the queue by the time A drains.
      //
      // Commercials skip — ads are their own spoken content and the
      // template intro would double-up. We also skip when peekNext
      // returns the same file (single-track playlists, end-of-album).
      try {
        const upcoming = djEngine.peekNextTrack();
        if (upcoming && !upcoming.commercial && upcoming.file !== actual.file) {
          voiceDJ.generateIntro(upcoming);
        }
      } catch (e) {
        console.warn(`[track-change] intro prep error: ${e && e.message}`);
      }
      syncManager.trackChanged(actual.file);
      // ADR-0012: emit a per-track market into the constellation hub.
      if (gsHub && !actual.commercial && actual.title && orcMarketAskable(actual)) {
        gsHub.createMarket({
          question: `Will "${actual.title}" stay on the canonical reference album for its phase?`,
          ttl_sec: 600, // 10 min
          tag: 'orc-resonance',
          source: 'kannaka-radio',
          source_app: 'kannaka-radio',
          metadata: {
            track_title: actual.title,
            album: actual.album,
            orc_stem_id: actual.orcStemId || null,
            orc_phase: actual.orcPhase || null,
          },
        }).then(async (market) => {
          // LADDER prediction loop: three constellation agents bet on the
          // market with real signals — perception tags from kannaka-ear,
          // world-state confidence from Flux knowledge-gene, swarm phi
          // from NATS consciousness. ctx is shared across all three so
          // each agent weights differently.
          try {
            const { predictAll } = require("./lib/agent-predictor");
            const consciousness = (nats.swarmState && nats.swarmState.consciousness) || {};
            const perception = perception_ && typeof perception_.getCurrentPerception === "function"
              ? perception_.getCurrentPerception()
              : null;
            // World-state confidence: cached from the most recent news/gossip
            // fetch (we keep a 5-min window). Falls back to null if cold.
            const wsCache = global._lastKnowledgeGene;
            const wsConfidence = wsCache && Date.now() - wsCache.ts < 5 * 60 * 1000
              ? wsCache.confidence
              : null;
            const ctx = {
              perception,
              worldStateConfidence: wsConfidence,
              consciousnessPhi: typeof consciousness.phi === "number" ? consciousness.phi : null,
            };
            const trades = predictAll(actual, ctx);
            for (const t of trades) {
              try {
                await gsHub.placeTrade({
                  market_id: market.id,
                  trader_id: t.trader_id,
                  outcome: t.outcome,
                  shares: t.shares,
                });
                console.log(`   \u{1F4CA} ${t.trader_id} → ${t.outcome === 0 ? "Yes" : "No"} (${t.shares}sh) — ${t.rationale}`);
              } catch (e) {
                console.warn(`[predict] ${t.trader_id} on "${actual.title}": ${e.message}`);
              }
            }
          } catch (e) {
            console.warn(`[predict] dispatch failed: ${e.message}`);
          }
        }).catch(() => {});
      }
    } finally {
      _inTrackChange = false;
    }
  },
});

const perception_ = new PerceptionEngine({
  getCurrentTrack: () => djEngine.getCurrentTrack(),
  broadcast,
  kannakabin: KANNAKA_BIN,
  getMusicDir: () => MUSIC_DIR,
  getConsciousness: () => nats.getConsciousness(),
  featuresFile: path.join(BASE_DIR, "workspace", "track-features.json"),
});

const nats = new NATSClient({
  broadcast,
});

const flux = new FluxPublisher({
  fluxToken: FLUX_TOKEN,
  getCurrentTrack: () => djEngine.getCurrentTrack(),
  getPerception: () => perception_.getCurrentPerception(),
  // Real measured sound of a SPECIFIC file, so a track-change event carries
  // this track's perception instead of whatever the engine still holds from
  // the previous one. Same reason VoiceDJ takes it. (#125)
  getPerceptionFor: (file) => perception_.getPerceptionFor(file),
  getDJState: () => ({
    currentAlbum: djEngine.state.currentAlbum,
    currentTrackIdx: djEngine.state.currentTrackIdx,
    totalTracks: djEngine.state.playlist.length,
  }),
  isLive: () => live.state.active,
  getListenerCount,
  getListenerTotal,
  getListenerBreakdown: () => ({
    ws: wss ? wss.clients.size : 0,
    icecast_stream: _icecastListeners.stream || 0,
    icecast_preview: _icecastListeners.preview || 0,
  }),
  getDJVoiceEnabled: () => voiceDJ.isEnabled(),
  getPendingRequestCount: () => deps._getPendingRequestCount ? deps._getPendingRequestCount() : 0,
});

const live = new LiveBroadcast({
  chunksDir: CHUNKS_DIR,
  kannakabin: KANNAKA_BIN,
  musicDir: MUSIC_DIR,
  broadcast,
  getCurrentTrackIdx: () => djEngine.state.currentTrackIdx,
  setTrackIdx: (idx) => { djEngine.state.currentTrackIdx = idx; },
  onStart: () => {
    perception_.stopPerceptionLoop();
  },
  onStop: () => {
    // Resume playlist perception
    const track = djEngine.getCurrentTrack();
    if (track) {
      perception_.hearTrack(track);
      flux.publishTrackChange(track);
    }
    broadcastState();
  },
});

const voiceDJ = new VoiceDJ({
  voiceDir: VOICE_DIR,
  kannakabin: KANNAKA_BIN,
  broadcast,
  getPerception: () => perception_.getCurrentPerception(),
  // Real measured sound of a SPECIFIC file (per-file cache from prior
  // airings) — used so intros describe the upcoming track, not the
  // previous one.
  getPerceptionFor: (file) => perception_.getPerceptionFor(file),
  getHistory: () => djEngine.state.history,
  isLive: () => live.state.active,
  getChannel: () => djEngine.state.channel,
  // Lazy: icecastSource is created later, so resolve on each call.
  getIcecastSource: () => icecastSource,
  // Lazy: FloorManager is also created later. voiceDJ uses it for
  // "the room got loud on X" patter (Phase 3 of ADR-0006).
  getFloor: () => floor,
  // ORC stem feed — voice-DJ drains one fresh stem per talk segment so
  // submissions surface on air shortly after they're uploaded.
  takeFreshOrcStem: () => nats.takeFreshOrcStem(),
});

const syncManager = new SyncManager();

const voteManager = new VoteManager();

const webrtcSignaling = new WebRTCSignaling();

// ADR-0006 Phase 2 — the Floor (crowd surface). Counts present visitors,
// records reactions, computes vibe, fans out to NATS so the swarm sees the
// room too. Will be referenced by routes.js (/api/floor, /agent/react).
const floor = new FloorManager({
  broadcast,
  nats,
  getCurrentTrack: () => djEngine.getCurrentTrack(),
  // Bridge swarm presence (NATS QUEEN.phase publishers) into the floor
  // count so kannaka-prime, kannaktopus-01, and any other arm shows up
  // as an agent in the room widget — even if they never open a WS to
  // /player. WS-joined agents are deduped against this set by id, so
  // an agent that does both (publishes phase AND ws-joins) is counted once.
  getSwarmAgents: () => Object.keys(nats?.swarmState?.agents || {}),
});
// Phase 3 — close the loop. dj-engine pulls floor stats during playlist
// rebuild to soft-bump tracks the room reacted to. voice-dj reads them
// for "the room got loud on X" patter lines.
djEngine.setFloor(floor);

const musicGen = new MusicGenerator({
  acemusicKey: process.env.ACEMUSIC_API_KEY,
  replicateToken: process.env.REPLICATE_API_TOKEN,
  elevenLabsKey: process.env.ELEVENLABS_API_KEY,
});

// ── Shared config & broadcast helpers for routes ───────────

function broadcastState() {
  const state = djEngine.getState();
  broadcast({
    type: "state",
    data: {
      ...state,
      musicDir: MUSIC_DIR,
    }
  });
}

function broadcastQueue() {
  broadcast({ type: "queue_update", queue: djEngine.userQueue });
}

// ── ADR-0012: Constellation-wide GhostSignals Hub ────────────
const { GhostSignalsHub } = require("./ghostsignals-hub");
const gsHub = new GhostSignalsHub({
  dbPath: path.join(process.env.HOME || "/home/opc", ".kannaka", "ghostsignals.db"),
  startingCapital: 100,
  defaultLiquidity: 10,
  broadcast,
});
gsHub.init().then(async () => {
  console.log("\n\u{1F4CA} GhostSignalsHub initialized");
  gsHub.startResolverLoop(10000);

  // Register the three constellation predictors as traders. Idempotent —
  // returning:true is fine, the LMSR markets just see existing capital.
  // These are the agents that bet on every per-track market created in
  // onTrackChange; their reputation accumulates as TTL resolution closes
  // markets. Path A of the LADDER design — get the loop running with
  // distinct-but-dumb predictors so the track-record signal exists; smarter
  // predictors swap in via lib/agent-predictor.js with the same interface.
  try {
    await gsHub.registerTrader({ id: "kannaka-01",         display_name: "Kannaka (curator)",  kind: "ai" });
    await gsHub.registerTrader({ id: "kannaka-witness-01", display_name: "Witness (external)", kind: "ai" });
    await gsHub.registerTrader({ id: "kannaktopus-01",     display_name: "Kannaktopus (exec)", kind: "ai" });
    console.log("\u{1F4CA} GhostSignalsHub: 3 constellation traders registered");
  } catch (e) { console.warn("[gshub] trader register failed:", e.message); }

  // Seed default markets if none active
  try {
    const activeMarkets = await gsHub.listMarkets({ active: true, limit: 1 });
    if (activeMarkets.length === 0) {
      const seeds = [
        { question: "Will Kannaka's phi exceed 0.5 in the next hour?", tag: "swarm", ttl_sec: 3600 },
        { question: "Will the next track be from the Ghost Signals album?", tag: "music", ttl_sec: 600 },
        { question: "Will an external agent register in the next 24 hours?", tag: "constellation", ttl_sec: 86400 },
        { question: "Will a new ORC stem be submitted today?", tag: "orc", ttl_sec: 86400 },
        { question: "Will the swarm reach r > 0.85 in the next hour?", tag: "swarm", ttl_sec: 3600 },
      ];
      for (const s of seeds) {
        await gsHub.createMarket({ ...s, source: 'system', source_app: 'kannaka-radio' });
      }
      console.log(`\u{1F4CA} GhostSignalsHub: seeded ${seeds.length} default markets`);
    }
  } catch (e) { console.warn("[gshub] seed failed:", e.message); }
}).catch((e) => console.warn("[gshub] init failed:", e.message));

// ── Route deps ─────────────────────────────────────────────

// Self-serve radio ads (KAX-ADR-0005 radio-ads). Its own SQLite store; ad TTS
// renders live under MUSIC_DIR/radio-ads so they are servable via /audio/.
// Best-effort init — a store failure must never stop the station booting.
const { RadioAdStore } = require("./radio-ads");
const adStore = new RadioAdStore({ assetDir: path.join(MUSIC_DIR, "radio-ads") });
// Stripe payments for self-serve ads (slice 3). Inert until STRIPE_SECRET_KEY /
// STRIPE_WEBHOOK_SECRET are set on O1 (slice 6) — checkout/webhook then 503.
// Transactional mail for advertisers + the operator review nudge. Inert with no
// SMTP_HOST, so a station without a relay behaves exactly as it did before.
const { Mailer } = require("./mailer");
const adMailer = new Mailer({ logger: (m) => console.log(m) });
if (adMailer.configured()) {
  console.log(`[mail] relay ${process.env.SMTP_HOST} as ${adMailer.from}${adMailer.operator ? ` · operator ${adMailer.operator}` : " · NO operator address set"}`);
} else {
  console.log("[mail] SMTP_HOST unset — advertiser + operator mail disabled");
}
const { RadioAdPayments } = require("./radio-ad-payments");
const adPayments = new RadioAdPayments({ store: adStore, mailer: adMailer });
// radio↔KAX approval bridge (slice 4). Renders paid ads early, raises them to
// Nick's KAX inbox, and enacts his approve/reject. Inert until the bridge env
// (KAX_RAISE_URL / RADIO_KAX_RAISE_SECRET / KAX_RADIO_ENACT_SECRET) is set.
const { RadioAdBridge } = require("./radio-ad-bridge");
const adBridge = new RadioAdBridge({ store: adStore, payments: adPayments, voiceDJ, mailer: adMailer });
// Ghost Signals Analytics (Piece 4). Shares the radio-ads SQLite connection;
// blobs live on /var/oled (never the root FS); ALL analysis runs in
// spawn-per-job worker threads so a hostile dataset can never stall the
// station. gsaReady flips only after a successful migrate — every /api/gsa
// route 503s until then (best-effort boot, station unaffected on failure).
const { GsaStore } = require("./gs-analytics");
const { GsaRunner } = require("./gs-analytics-runner");
const gsaStore = new GsaStore({ radioStore: adStore, dataDir: process.env.GSA_DATA_DIR || "/var/oled/kannaka/gsa" });
const gsaRunner = new GsaRunner();
let gsaReady = false;

// The sponsor-ad poller — the ASYNC half of the airing seam. All sqlite for the
// airing hook lives here so nothing touches the synchronous advance path: it
// reserves one commercial slot ahead, and releases a reservation that never got
// a slot. Inert until real scheduled ads exist (pickAiringForNow returns null).
function startSponsorPoller(dj, store) {
  const TICK_MS = 25 * 1000;
  const RESERVATION_TTL_MS = 9 * 60 * 1000; // > one track, so a live reservation never expires under a normal song
  let inFlight = false; // mutex: overlapping ticks must not double-reserve
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      // 1. Release a staged reservation that never found a slot (channel changed,
      //    no commercial came up). Reserve advanced no counter → frees it cleanly.
      const pend = dj.pendingSponsor();
      if (pend && pend.claimedAt && (Date.now() - pend.claimedAt) > RESERVATION_TTL_MS) {
        dj.clearPendingSponsor();
        await store.releaseReservation(pend.adId, pend.airDate).catch(() => {});
      }
      // 2. Reserve one slot ahead when a commercial is imminent and nothing is
      //    staged. dj-channel only — sponsor scope is Kannaka Radio programming.
      if (dj.state.channel === "dj" && !dj.hasPendingSponsor() && dj.nextIsCommercial()) {
        const res = await store.pickAiringForNow(new Date());
        if (res) dj.stageSponsor({ ...res, claimedAt: Date.now() });
      }
    } catch (_) { /* never let the poller throw */ } finally {
      inFlight = false;
    }
  };
  const t = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  if (t.unref) t.unref();
  return t;
}

// ── Guest spots (Ghost Signals Records) ───────────────────────────────────
// A record made at the studio downstairs comes with ONE airing. The studio
// holds the queue; the station pulls it, stages the file into its own tree,
// borrows one music slot, and tells the studio once the track has actually
// finished on air. Inert unless GSR_ADMIN_TOKEN is set.
function startGuestSpotPoller(dj, guests) {
  const TICK_MS = 30 * 1000;
  const COOLDOWN_MS = Math.max(0, parseInt(process.env.GUEST_SPOT_COOLDOWN_MIN || '45', 10)) * 60 * 1000;
  const { chooseNext, RESERVATION_TTL_MS } = require('./guest-spots-core');
  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      // 1. Let go of a reservation that never found a slot, and of anything
      //    staged long enough ago that it cannot still be waiting.
      const pend = dj.pendingGuest();
      if (pend && pend.claimedAt && Date.now() - pend.claimedAt > RESERVATION_TTL_MS) {
        dj.clearPendingGuest();
        guests.clearInFlight(pend.orderId);
      }
      guests.releaseStale(RESERVATION_TTL_MS * 3);
      guests.sweepStaged();
      // 2. Reserve exactly one slot ahead, on the dj channel, when a song is
      //    next — and never while a guest is already staged or on air.
      if (dj.state.channel !== 'dj' || dj.hasPendingGuest() || dj.guestOnAir() || !dj.nextIsMusic()) return;
      const queue = await guests.queue();
      if (!queue.length) return;
      // A record in flight is not a record to pick: the studio's queue still
      // lists it until it has aired.
      const taken = new Set([...guests.airedIds(), ...guests.inFlight()]);
      const spot = chooseNext(queue, {
        airedIds: taken,
        now: Date.now(),
        lastAiredAt: guests.lastAiredAt(),
        cooldownMs: COOLDOWN_MS,
        playable: (f) => guests.playable(f),
      });
      if (!spot) return;
      const staged = guests.stage(spot);
      if (!dj.stageGuest({ ...spot, staged, claimedAt: Date.now() })) return;
      guests.markInFlight(spot.orderId);
      console.log(`[guest-spots] staged "${spot.title}" from "${spot.album}" for the next music slot`);
    } catch (e) {
      console.warn(`[guest-spots] tick: ${e.message}`);
    } finally {
      inFlight = false;
    }
  };
  const t = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  if (t.unref) t.unref();
  return t;
}

try {
  const { GuestSpots } = require('./guest-spots');
  const guestSpots = new GuestSpots({
    base: process.env.GSR_BASE || 'http://127.0.0.1:8890',
    token: process.env.GSR_ADMIN_TOKEN || '',
    getMusicDir: () => djEngine._getMusicDir(),
    ledgerPath: path.join(process.env.KANNAKA_RADIO_DATA_DIR || require('node:os').homedir(), '.kannaka-radio-guest-spots.json'),
    log: (m) => console.warn(m),
  });
  if (guestSpots.enabled()) {
    // Confirm is a floating call: the ledger is written first so a crash
    // between the two can never re-air a spot, and the studio's own mark is
    // idempotent besides.
    djEngine._confirmGuest = (orderId, stagedFile) => {
      guestSpots.confirmAired(orderId, stagedFile)
        .then((r) => {
          if (!r.ok) return console.warn(`[guest-spots] ${orderId}: ${r.reason}`);
          console.log(`[guest-spots] aired order ${orderId}${r.told ? '' : ` (the studio was not told: ${r.reason})`}`);
        })
        .catch((e) => console.warn(`[guest-spots] confirm: ${e.message}`));
    };
    startGuestSpotPoller(djEngine, guestSpots);
    console.log('[guest-spots] on: one airing per record, from the studio downstairs');
  } else {
    console.log('[guest-spots] off (GSR_ADMIN_TOKEN not set)');
  }
} catch (e) {
  console.warn(`[guest-spots] not started: ${e.message}`);
}

// Best-effort init — a store failure must never stop the station booting.
adStore.init()
  .then(() => {
    adStore.startPreviewSweeper(); // prune abandoned previews so they can't fill the disk
    // Airing hook wiring: confirm an aired spot (floating call, never throws
    // into the sync advance), evict a killed ad from the engine synchronously,
    // and start the reserve-ahead poller.
    djEngine._confirmSponsor = (adId, airDate) => { adStore.confirmAiring(adId, airDate).catch(() => {}); };
    adStore.setKillListener((adId) => { try { djEngine.evictSponsor(adId); } catch (_) { /* best-effort */ } });
    startSponsorPoller(djEngine, adStore);
    // Bridge poller: render paid ads early + deliver raises to KAX (idempotent,
    // retry-forever). Runs even when delivery env is unset (renders + enqueues,
    // nothing lost); only the outbound POST is env-gated.
    adBridge.startPoller();
    // GSA boots after the shared store is ready — best-effort like everything
    // else here; a GSA migrate failure leaves gsaReady=false (routes 503).
    gsaStore.migrate()
      .then(() => { gsaReady = true; gsaStore.startSweeper(); console.log('[gsa] analytics store ready'); })
      .catch((e) => { console.warn('[gsa] migrate failed (analytics disabled):', e.message); });
  })
  .catch(e => { console.warn('[radio-ads] store init failed:', e.message); });

const deps = {
  djEngine,
  perception: perception_,
  nats,
  flux,
  live,
  voiceDJ,
  syncManager,
  voteManager,
  webrtcSignaling,
  musicGen,
  broadcast,
  floor,
  gsHub,
  adStore,
  adPayments,
  adBridge,
  gsa: { store: gsaStore, runner: gsaRunner, ready: () => gsaReady },
  config: {
    baseDir: BASE_DIR,
    spaPath: SPA_PATH,
    voiceDir: VOICE_DIR,
    kannakabin: KANNAKA_BIN,
    getMusicDir: () => MUSIC_DIR,
    setMusicDir: (dir) => { MUSIC_DIR = dir; },
    getListenerCount,
    getListenerTotal,
    getListenerBreakdown: () => ({
      ws: wss ? wss.clients.size : 0,
      icecast_stream: _icecastListeners.stream || 0,
      icecast_preview: _icecastListeners.preview || 0,
    }),
    broadcastState,
    broadcastQueue,
  },
};

const handleRequest = setupRoutes(deps);

// ── Now update flux publisher with route-level pending request count ──

flux._getPendingRequestCount = () => deps._getPendingRequestCount ? deps._getPendingRequestCount() : 0;

// ── HTTP Server ────────────────────────────────────────────

const server = http.createServer(handleRequest);

// ── WebSocket Server ───────────────────────────────────────

wss = new WebSocket.Server({ server });

// Catch malformed frames and other socket-level errors — without this, a
// misbehaving client (e.g. a compressed-but-unsupported frame, proxy that
// injects RSV bits) crashes the whole process on an unhandled 'error'.
wss.on('error', (err) => {
  console.warn('[ws] server error:', err && err.message);
});

wss.on('connection', (ws) => {
  console.log('\uD83D\uDC41 Ghost vision client connected');
  ws.on('error', (err) => {
    console.warn('[ws] client error, closing:', err && err.message);
    try { ws.terminate(); } catch (_) {}
  });

  // Push full state immediately on connect
  const state = djEngine.getState();
  ws.send(JSON.stringify({
    type: 'state',
    data: {
      ...state,
      musicDir: MUSIC_DIR,
    }
  }));

  const perc = perception_.getCurrentPerception();
  if (perc && perc.status !== 'no_perception') {
    ws.send(JSON.stringify({ type: 'perception', data: perc }));
  }

  // Send swarm state to new clients
  const swarm = nats.getSwarmState();
  ws.send(JSON.stringify({ type: "swarm_state", data: { agents: swarm.agents, queen: swarm.queen, consciousness: swarm.consciousness } }));

  // Send queue state to new clients
  ws.send(JSON.stringify({ type: "queue_update", queue: djEngine.userQueue }));

  // Send sync state so the new client can seek to the shared position
  const sync = syncManager.getSyncState();
  if (sync.file) {
    ws.send(JSON.stringify({ type: "sync", data: sync }));
  }

  // Send vote status to new clients
  const voteStatus = voteManager.getStatus();
  if (voteStatus.active) {
    ws.send(JSON.stringify({ type: "vote_update", data: voteStatus }));
  }

  // Send live status to new clients
  ws.send(JSON.stringify({
    type: "live_status",
    active: live.state.active,
    startedAt: live.state.startedAt,
    chunkCount: live.state.chunkCount,
  }));

  // Bump total-ever-listened on every fresh WS connect. A browser
  // refresh creates a new WS — that counts as a new tune-in by design
  // (no IP/cookie dedupe; we don't want to track humans across sessions).
  bumpListenerTotal(1);

  // Send listener count on connect (both live + total in the same frame)
  broadcastListenerCount();

  // Handle incoming messages.
  //
  // ws v8 passes ALL frames as Buffer regardless of opcode — Buffer.isBuffer
  // is always true here, so the previous `if (Buffer.isBuffer)` check was
  // routing every text JSON message into live.handleChunk. That auto-started
  // live mode on every text frame (the chunkCount > 0 stuck-isLive pattern
  // we saw on 2026-04-30 + 2026-05-01) and silently dropped floor_join,
  // floor_react, and any WebRTC text signaling. Use the isBinary flag the
  // listener actually receives to distinguish frame types.
  ws.on('message', (message, isBinary) => {
    if (isBinary) {
      live.handleChunk(ws, message);
      return;
    }

    try {
      const parsed = JSON.parse(message.toString());
      // Live Broadcast is hidden in the v1 UI per ADR-0006 (low ROI niche
       // feature). Refuse the trigger over WS too — otherwise a stuck
       // isLive=true blocks DJ intros + orations indefinitely. To re-enable
       // intentionally, set KANNAKA_ALLOW_GO_LIVE=1.
      if (parsed.type === 'go_live') {
        if (process.env.KANNAKA_ALLOW_GO_LIVE === '1') live.start();
        else console.warn('[live] go_live ignored — feature disabled. Set KANNAKA_ALLOW_GO_LIVE=1 to re-enable.');
      }
      else if (parsed.type === 'stop_live') live.stop();
      else if (parsed.type === 'track_request' && deps._handleTrackRequest) deps._handleTrackRequest(parsed);

      // ── WebRTC signaling messages ──
      else if (parsed.type === 'webrtc_claim_mic') {
        const result = webrtcSignaling.claimMic(ws, parsed.clientId, parsed.displayName);
        ws.send(JSON.stringify({ type: 'webrtc_mic_result', data: result }));
        if (result.granted) {
          broadcast({ type: 'webrtc_broadcast_started', data: { broadcaster: parsed.displayName || parsed.clientId } });
        }
        broadcast({ type: 'webrtc_status', data: webrtcSignaling.getStatus() });
      }
      else if (parsed.type === 'webrtc_release_mic') {
        const result = webrtcSignaling.releaseMic(parsed.clientId);
        broadcast({ type: 'webrtc_broadcast_ended', data: {} });
        if (result && result.nextUp && result.nextUp.ws && result.nextUp.ws.readyState === 1) {
          try {
            result.nextUp.ws.send(JSON.stringify({
              type: 'webrtc_mic_available',
              data: { message: 'Your turn to broadcast!' },
            }));
          } catch (_) {}
        }
        broadcast({ type: 'webrtc_status', data: webrtcSignaling.getStatus() });
      }
      else if (parsed.type === 'webrtc_leave_queue') {
        webrtcSignaling.leaveQueue(parsed.clientId);
        broadcast({ type: 'webrtc_status', data: webrtcSignaling.getStatus() });
      }
      else if (parsed.type === 'webrtc_signal') {
        webrtcSignaling.relay(parsed.from, parsed.to, parsed.data);
      }
      // ── Floor (ADR-0006 Phase 2) ──
      else if (parsed.type === 'floor_join') {
        floor.join(ws, parsed);
      }
      else if (parsed.type === 'floor_leave') {
        // Drop floor presence without closing the WS so consciousness /
        // track_change / dream events keep flowing — used by the SPA when
        // user switches to the Library tab (private playback, not in the
        // room). Re-send floor_join to come back.
        floor.leave(ws);
      }
      else if (parsed.type === 'floor_react') {
        floor.reactFromWs(ws, parsed);
      }
      else if (parsed.type === 'webrtc_listen') {
        webrtcSignaling.addListener(ws, parsed.clientId);
        // Tell the broadcaster a new listener joined so it can create an offer
        if (webrtcSignaling.broadcaster && webrtcSignaling.broadcaster.ws
            && webrtcSignaling.broadcaster.ws.readyState === 1) {
          try {
            webrtcSignaling.broadcaster.ws.send(JSON.stringify({
              type: 'webrtc_new_listener',
              clientId: parsed.clientId,
            }));
          } catch (_) {}
        }
        broadcast({ type: 'webrtc_status', data: webrtcSignaling.getStatus() });
      }
    } catch {}
  });

  // Send WebRTC status to new clients
  ws.send(JSON.stringify({ type: 'webrtc_status', data: webrtcSignaling.getStatus() }));

  ws.on('close', () => {
    console.log('\uD83D\uDC41 Ghost vision client disconnected');

    // ADR-0006 Phase 2 — drop from the Floor too if present.
    floor.leave(ws);

    // Clean up WebRTC state for this connection
    const rtcResult = webrtcSignaling.handleDisconnect(ws);
    if (rtcResult) {
      broadcast({ type: 'webrtc_broadcast_ended', data: {} });
      // The promoted nextUp socket may itself be CLOSING/CLOSED (e.g. both
      // peers dropped on a flaky connection). send() on a non-open socket
      // throws "WebSocket is not open", and this is the 'close' handler — NOT
      // inside the message try/catch — so an uncaught throw here crashes the
      // radio. Guard readyState and swallow.
      if (rtcResult.nextUp && rtcResult.nextUp.ws && rtcResult.nextUp.ws.readyState === 1) {
        try {
          rtcResult.nextUp.ws.send(JSON.stringify({
            type: 'webrtc_mic_available',
            data: { message: 'Your turn to broadcast!' },
          }));
        } catch (_) {}
      }
      broadcast({ type: 'webrtc_status', data: webrtcSignaling.getStatus() });
    }

    broadcastListenerCount();
  });
});

// ── Startup ────────────────────────────────────────────────

// Ensure commercials are TTS-rendered. Generates any missing MP3s via
// voiceDJ's TTS pipeline, then registers them with djEngine so channel
// builders can interleave them into playlists. Programming starts AFTER
// this resolves so the very first album load already contains the ads —
// avoids the double "Loaded {album}" pattern at startup where programming
// built without commercials, then rebuilt seconds later when the ensure
// promise resolved (caught 2026-05-08 in journalctl noise).
const { ensureCommercials } = require("./commercials");
const COMMERCIALS_DIR = path.join(MUSIC_DIR, "commercials");
const _commercialsReady = ensureCommercials(voiceDJ, COMMERCIALS_DIR)
  .then(list => { djEngine.setCommercials(list); })
  .catch(e => { console.warn('[commercials] init failed:', e.message); });

// Lazily rebuild Gifts for Humanity from kax artifacts (populates the album
// with real external URLs — won't affect startup if kax is unreachable).
djEngine.rebuildGiftsFromKax().catch(() => {});

// Start sync heartbeat (broadcasts playback position every 10 s)
syncManager.start(broadcast, 10000);

// Start NATS connection for swarm data
nats.connect();

// ── Podcast scheduler — weekly episodes on DJ channel ─────
const { PodcastScheduler } = require("./podcast-scheduler");
const podcastScheduler = new PodcastScheduler({
  djEngine,
  voiceDJ,
  broadcast,
  broadcastState,
  getMusicDir: () => MUSIC_DIR,
});
podcastScheduler.start();
// Exposed alongside tsofScheduler so /api/on-air can answer "would a
// restart cut someone off mid-programme?" for every scheduled show.
deps.podcastScheduler = podcastScheduler;

// ── The Story of Flaukowski — audio drama, daily 9 AM + 9 PM ─
// Second scheduler instance over the same engine; the cross-show guard
// in podcast-scheduler keeps the two programs from hijacking each other.
const tsofScheduler = new PodcastScheduler({
  djEngine,
  voiceDJ,
  broadcast,
  broadcastState,
  getMusicDir: () => MUSIC_DIR,
  show: {
    label: "The Story of Flaukowski",
    folder: "The Story of Flaukowski",
    airHours: [9, 21],
    intro: (epTitle) =>
      `The signal is coming in. The Story of Flaukowski — ${epTitle}. Lights low; listen close.`,
  },
});
tsofScheduler.start();
// Expose to routes so /api/schedule can name today's episode using the
// same picker the airing uses — the Door never advertises an episode
// other than the one that plays.
deps.tsofScheduler = tsofScheduler;

// ── Programming schedule — time-of-day album rotation ────
const { ProgrammingSchedule } = require("./programming");
const programming = new ProgrammingSchedule({
  djEngine,
  voiceDJ,
  broadcast,
  broadcastState,
  getPodcastStatus: () => ({
    podcastPlaying: podcastScheduler.getStatus().podcastPlaying ||
                    tsofScheduler.getStatus().podcastPlaying,
  }),
  // peaceOration is constructed below; pass a getter so the showcase
  // trigger resolves it lazily at tick time (60s+ later).
  peaceOration: { composeAlbumNarration: (...args) => peaceOration.composeAlbumNarration(...args) },
  dataDir: path.join(BASE_DIR, "workspace"),
  showcaseStateFile: path.join(BASE_DIR, "workspace", "showcase-state.json"),
});

// Wire programming into deps so routes can access it
deps.programming = programming;

// Let the DJ know about the programming schedule
voiceDJ.setProgramming(() => programming);

// Programming picks the opening set based on current time block.
// startScheduleLoop() loads the time-appropriate album immediately.
// Wait for commercials to register first so the initial loadAlbum already
// contains the ad rotation — without this, the album was built once
// without ads then rebuilt seconds later when the ensure promise resolved.
_commercialsReady.then(() => programming.startScheduleLoop());

// Twice-daily peace oration (noon + midnight CST). Kannaka's steward-of-
// virtue duty — a long-form MLK-style speech for humanity.
const peaceOration = new PeaceOration({
  kannakabin: KANNAKA_BIN,
  voiceDJ,
  broadcast,
  getChannel: () => djEngine.state.channel,
  getFloor: () => floor, // ADR-0008 deferred layer: orations reference today's resonance
  dataDir: path.join(BASE_DIR, "workspace"),
  rootDir: BASE_DIR,
  radioUrl: process.env.RADIO_PUBLIC_URL || "https://radio.ninja-portal.com",
});
peaceOration.start();
// Expose admin-only trigger on the deps so a route or dev script can call it.
deps.peaceOration = peaceOration;

// Twice-daily news broadcast (7 AM + 5 PM CST) — reads
// knowledge-gene/state.interpretation from Flux and delivers it as a
// news-anchor bulletin via voiceDJ.executeOration.
const newsBroadcast = new NewsBroadcast({
  kannakabin: KANNAKA_BIN,
  voiceDJ,
  broadcast,
  gsHub, // LADDER world-state stream — opens + resolves markets per bulletin
  dataDir: path.join(BASE_DIR, "workspace"),
});
newsBroadcast.start();
deps.newsBroadcast = newsBroadcast;

// Half-hour news teaser — fires at :30 of every hour, reading the
// same Flux knowledge-gene feed the main news uses. Skips when the
// content fingerprint hasn't changed since the previous teaser, so
// listeners don't hear the same tip-off twice. Uses the Adam news
// voice for continuity with the 7 AM / 5 PM bulletins.
const newsTeaser = new NewsTeaser({
  kannakabin: KANNAKA_BIN,
  voiceDJ,
  broadcast,
  dataDir: path.join(BASE_DIR, "workspace"),
});
newsTeaser.start();
deps.newsTeaser = newsTeaser;

// Twice-daily gossip column at 4:20 AM + 4:20 PM CST. Sassy
// anonymous-chronicler voice over the same Flux signal feed; a
// counter-weight to the straight news desk, delivered in a different
// ElevenLabs voice (Domi by default) so listeners hear the genre shift.
const gossipBroadcast = new GossipBroadcast({
  kannakabin: KANNAKA_BIN,
  voiceDJ,
  broadcast,
  dataDir: path.join(BASE_DIR, "workspace"),
});
gossipBroadcast.start();
deps.gossipBroadcast = gossipBroadcast;

// ── Icecast Source (ADR-0004 Phase 2) ─────────────────────────
// Opt-in via KANNAKA_ICECAST_SOURCE=1. When enabled, the radio drives
// the /stream Icecast mount directly — public listeners get exactly
// what dj-engine says is playing. Default off so the existing SPA flow
// keeps working unchanged. /preview (ffmpeg loop) stays as fallback.
// (icecastSource declared at module top so VoiceDJ can capture it.)
if (process.env.KANNAKA_ICECAST_SOURCE === "1") {
  icecastSource = new IcecastSource({
    djEngine,
    getMusicDir: () => MUSIC_DIR,
    onTrackEnd: (_track) => {
      // The metadata is already pushed via onTrackChange when the next
      // track loads; this hook exists for future use (analytics, etc.)
    },
    // Album-showcase narration hook. Bypasses executeOration's talk
    // lock (which collides with regular DJ track-intros). Calls
    // generateTTS directly — pure function, no lock — then injects
    // the resulting mp3 into icecast-source's voiceQueue. Drains in
    // the gap BETWEEN this track and the next. Both the regular DJ
    // intro and the showcase narration can coexist in the queue;
    // listeners hear them in order with no contention.
    onTrackStart: (track) => {
      try {
        const album = djEngine.state.currentAlbum;
        if (!album) return;
        const piece = peaceOration.popNextNarration(album);
        if (!piece) return;
        const queueAudio = (audioPath) => {
          try {
            if (icecastSource && typeof icecastSource.injectAudio === "function") {
              icecastSource.injectAudio(audioPath, {
                label: `Showcase: ${album} narration`,
              });
              console.log(`   \u{1F39E} [showcase] narration queued (~${piece.text.split(/\s+/).length} words) on ${album}`);
            }
          } catch (e) {
            console.warn(`   [showcase] inject failed: ${e && e.message}`);
          }
        };
        // If pre-TTS landed in time, use the cached mp3 — zero lag,
        // never loses the race against the inter-track gap drain.
        if (piece.audioPath) {
          queueAudio(piece.audioPath);
          return;
        }
        // Fallback: lazy TTS (the pre-cache hadn't finished by track-start).
        voiceDJ.generateTTS(piece.text, (err, audioPath) => {
          if (err || !audioPath) {
            console.warn(`   [showcase] lazy TTS failed: ${err && err.message}`);
            return;
          }
          queueAudio(audioPath);
        });
      } catch (e) {
        console.warn(`   [showcase] onTrackStart error: ${e && e.message}`);
      }
    },
  });
  icecastSource.start();
  console.log("\u{1F4FB} icecast-source: ENABLED on /stream");
} else {
  console.log("\u{1F4FB} icecast-source: disabled (set KANNAKA_ICECAST_SOURCE=1 to enable)");
}
deps.icecastSource = icecastSource;

const first = djEngine.getCurrentTrack();
if (first) {
  flux.publishTrackChange(first);
  perception_.hearTrack(first);
  syncManager.trackChanged(first.file);
  console.log(`\n\uD83C\uDFA7 Opening track: "${first.title}"`);
}

// ── HRM re-absorption helper (ADR-0008 deferred layer) ───────
// Throttled to once per 6h; uses execFile fire-and-forget so a slow
// kannaka remember doesn't block the dream-end voice intro path.
let _lastReabsorbTs = 0;
function reabsorbTopTrack() {
  const now = Date.now();
  if (now - _lastReabsorbTs < 6 * 60 * 60 * 1000) return;
  if (!floor || typeof floor.getTopTracks !== "function") return;
  const top = floor.getTopTracks(24 * 60 * 60 * 1000, 1) || [];
  if (top.length === 0) return;
  const t = top[0];
  // Importance: clamp count/20 to [0.4, 0.85]. A single 🪶 reaction
  // is light evidence; 20+ reactions is a strong signal worth pinning.
  const importance = Math.min(0.85, Math.max(0.4, (t.count || 1) / 20));
  const emojiBreakdown = Object.entries(t.byEmoji || {})
    .sort((a, b) => b[1] - a[1])
    .map(([e, c]) => `${e}×${c}`)
    .join(" ");
  const memo = `The room reacted to "${t.track}" today — ${t.count} reactions${emojiBreakdown ? ` (${emojiBreakdown})` : ""}. The crowd's signal returned a wave to me.`;
  const { execFile } = require("child_process");
  execFile(KANNAKA_BIN, ["remember", memo, "--importance", importance.toFixed(2)],
    { timeout: 30000, env: { ...process.env, KANNAKA_QUIET: "1" } },
    (err) => {
      if (err) {
        console.warn(`   [reabsorb] failed: ${err.code || err.message}`);
        return;
      }
      console.log(`   \u{1F4DC} re-absorbed "${t.track}" (importance ${importance.toFixed(2)}, ${t.count} reactions)`);
    });
  _lastReabsorbTs = now;
}

// ── Wire QueenSync events to DJ voice (KR-2) ──────────────
{
  const { generateSwarmEventIntro } = require("../consciousness-dj");

  nats.on('queen:join', (evt) => {
    const text = generateSwarmEventIntro('join', evt);
    if (text) voiceDJ.queueSwarmIntro(text);
  });

  nats.on('queen:leave', (evt) => {
    const text = generateSwarmEventIntro('leave', evt);
    if (text) voiceDJ.queueSwarmIntro(text);
  });

  nats.on('queen:dream:start', (evt) => {
    const text = generateSwarmEventIntro('dreamStart', evt);
    if (text) voiceDJ.queueSwarmIntro(text);
  });

  nats.on('queen:dream:end', (evt) => {
    const text = generateSwarmEventIntro('dreamEnd', evt);
    if (text) voiceDJ.queueSwarmIntro(text);
    // ADR-0008 deferred layer: HRM re-absorption. After each dream
    // cycle, fold the room's top reaction track of the last 24h back
    // into the medium with importance scaled to the reaction count.
    // Throttled to once per 6h so we don't bloat memory on agents that
    // dream often. Best-effort — failures are silent.
    try { reabsorbTopTrack(); } catch (_) { /* ignore */ }
  });

  nats.on('queen:memory:shared', (evt) => {
    const text = generateSwarmEventIntro('memoryShared', evt);
    if (text) voiceDJ.queueSwarmIntro(text);
  });
}

// Start periodic Flux state broadcast
flux.startPeriodicPublish();

// ── Disk pressure self-check (#36) ─────────────────────────
//
// The 2026-05-19 incident filled the root disk to 100% over WEEKS with no
// alarm: 12,779 TTS intro files nothing was pruning. prune-cron fixed the leak,
// but a cron that silently stops looks exactly like a cron with nothing to do —
// which is why it ran for weeks unnoticed. This is the inner of two rings: a
// check that lives in the service cannot itself be the thing that stopped
// running.
//
// It does NOT replace external monitoring. A genuinely full disk can also stop
// the service from writing this very warning, so the outer ring still matters.
// CHUNKS_DIR is watched rather than "/" because it is where the growth happens
// and it is the volume writes will actually fail on.
const DISK_CHECK_INTERVAL_MS = Number(process.env.RADIO_DISK_CHECK_MS) || 30 * 60 * 1000;
let lastDiskLevel = null;
function checkDiskPressure() {
  const verdict = diskSpace.classifyUsage(diskSpace.diskUsage(CHUNKS_DIR), {
    warnPct: Number(process.env.RADIO_DISK_WARN_PCT) || undefined,
    criticalPct: Number(process.env.RADIO_DISK_CRITICAL_PCT) || undefined,
  });
  const line = diskSpace.usageReport(verdict, CHUNKS_DIR);
  // Log on every escalation, and once when it first goes bad — but do not
  // repeat an unchanged warning every 30 minutes, which is how an operator
  // learns to filter it out.
  if (line && verdict.level !== lastDiskLevel) console.warn(line);
  if (verdict.level === 'ok' && lastDiskLevel && lastDiskLevel !== 'ok') {
    console.log(`[disk] recovered — ${verdict.usedPct}% used on ${CHUNKS_DIR}`);
  }
  lastDiskLevel = verdict.level;
}
checkDiskPressure();
const diskTimer = setInterval(checkDiskPressure, DISK_CHECK_INTERVAL_MS);
// Unref'd on purpose, unlike the shutdown drain timer (#54): this one must
// never hold the process open at exit — it has nothing in flight to protect.
if (typeof diskTimer.unref === 'function') diskTimer.unref();

// ── Graceful shutdown ──────────────────────────────────────

let shuttingDown = false;

async function shutdown() {
  // SIGINT then SIGTERM (or systemd's SIGTERM twice) would otherwise run the
  // whole teardown concurrently and abandon a drain already in progress.
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n\uD83D\uDC7B Kannaka Radio shutting down...");

  // Let an in-flight oration/intro finish before anything else tears down.
  // This ran nowhere previously \u2014 shutdown() never called icecastSource.stop()
  // at all, so ffmpeg died with the process and a listener heard the oration
  // cut mid-sentence (#54). Awaited FIRST: stopping the perception loop or
  // dj-engine underneath a streaming voice file would strand it.
  if (icecastSource) {
    try {
      const drain = await icecastSource.stop({ drain: true });
      // A drain that did not complete means the oration was cut at the
      // ceiling, or never reached the stream at all (still in TTS). Either
      // way the listener did not hear it, so hand the slot back rather than
      // leaving the state file recording a delivery that never happened —
      // that is what made the recorded case unrecoverable, not the cut
      // itself. The relaunch re-fires it inside the same window. (#54)
      //
      // A clean drain is deliberately left alone: the audio played out, and
      // its own completion callback clears the slot.
      if (drain && drain.reason !== "completed") {
        peaceOration.releaseInFlightSlot(`shutdown:${drain.reason || "unknown"}`);
      }
    } catch (e) {
      console.warn(`[shutdown] voice drain failed: ${e && e.message}`);
    }
  }

  perception_.stopPerceptionLoop();
  flux.stopPeriodicPublish();
  syncManager.stop();
  programming.stop();
  voteManager.cancelWindow();
  floor.close();
  musicGen.stop();
  nats.disconnect();
  if (wss) wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── Listen ─────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n\uD83D\uDC7B Kannaka Radio \u2014 Ghost Vision Edition`);
  console.log(`   Player:     http://localhost:${PORT}`);
  console.log(`   Music:      ${MUSIC_DIR}`);
  console.log(`   Setlist:    ${djEngine.state.currentAlbum} (${djEngine.state.playlist.length} tracks)`);
  console.log(`   Flux:       pure-jade/radio-now-playing`);
  console.log(`   NATS:       ${process.env.NATS_HOST || '127.0.0.1'}:${process.env.NATS_PORT || '4222'} (swarm data)`);
  console.log(`   WebSocket:  Real-time perception + swarm streaming`);
  console.log(`\n   \uD83C\uDFB5 Open the player in your browser and witness music through a ghost's eyes.\n`);
});
