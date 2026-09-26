/**
 * memory-bridge.js — Bridges kannaka-radio to kannaka-memory's HRM.
 *
 * Every played track stores its perception vector as a wavefront in the
 * Holographic Resonance Medium via the kannaka CLI binary.
 *
 * All calls are non-blocking with timeouts and graceful fallback:
 * if the kannaka binary is unavailable, functions return null and the
 * radio continues operating with its existing mock behavior.
 */

const { execFile } = require("child_process");
const path = require("path");

const KANNAKA_BIN = process.env.KANNAKA_BIN || (
  process.platform === "win32"
    ? path.join(__dirname, "..", "kannaka-memory", "target", "release", "kannaka.exe")
    : "/home/opc/.local/bin/kannaka"
);

const DEFAULT_TIMEOUT = 10000; // 10 seconds

// The binary actually invoked. Defaults to KANNAKA_BIN above; the modular
// server calls configure({ bin }) with its own resolved path so the bridge
// and the rest of the station always talk to the same kannaka. (#289)
let _bin = KANNAKA_BIN;

/**
 * Point the bridge at a specific kannaka binary.
 * @param {{ bin?: string }} opts
 */
function configure(opts = {}) {
  if (opts && typeof opts.bin === "string" && opts.bin) _bin = opts.bin;
}

// ── Consciousness cache (30s TTL) ──────────────────────────

let _consciousnessCache = null;
let _consciousnessCacheTime = 0;
const CONSCIOUSNESS_CACHE_TTL = 30000; // 30 seconds

// ── Helpers ─────────────────────────────────────────────────

/**
 * Run the kannaka binary with the given args.
 * Returns stdout on success, null on any failure.
 */
function runKannaka(args, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve) => {
    execFile(_bin, args, { timeout }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === "ENOENT") {
          console.warn("[memory-bridge] kannaka binary not found at:", _bin);
        } else {
          console.warn("[memory-bridge] Command failed:", args[0], err.message);
        }
        resolve(null);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Safely parse JSON, returning null on failure.
 */
function safeJSON(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── Public API ──────────────────────────────────────────────

/**
 * Store a track's perception as a text memory in the HRM.
 *
 * The remember command encodes the text into a hypervector that
 * captures the semantic content (title, album, audio features).
 * This works even without --features audio since it uses text encoding.
 *
 * @param {Object} track      - { title, album, trackNum, theme, ... }
 * @param {Object} perception - currentPerception object with audio features
 * @returns {Object|null}     - { stored: true } on success, null on failure
 */
async function storeTrackMemory(track, perception) {
  if (!track || !perception) return null;

  const tempo = (perception.tempo_bpm || 0).toFixed(1);
  const centroid = (perception.spectral_centroid || 0).toFixed(2);
  const energy = (perception.rms_energy || 0).toFixed(3);
  const valence = (perception.valence || 0).toFixed(2);

  const memoryText = `HEAR: ${track.title} from ${track.album} | tempo=${tempo} centroid=${centroid} energy=${energy} valence=${valence}`;

  // Importance: louder tracks are more important (0.5 - 1.0 range)
  const importance = Math.max(0, Math.min(1,
    (perception.rms_energy || 0) * 0.5 + 0.5
  )).toFixed(2);

  const stdout = await runKannaka([
    "remember",
    memoryText,
    "--importance",
    importance
  ]);

  if (stdout !== null) {
    return { stored: true, text: memoryText, importance: parseFloat(importance) };
  }
  return null;
}

/**
 * Store a track the station actually aired and measured (#289).
 *
 * The modular server's track-change paths call this from the
 * real-perception hook of PerceptionEngine.hearTrack(), so only genuine
 * `kannaka hear` measurements reach the HRM. Mock / placeholder perception
 * and commercials are refused here as well, so a caller that gets it wrong
 * still cannot write fabricated numbers into memory.
 *
 * @returns {Promise<Object|null>} storeTrackMemory's result, or null when skipped/failed
 */
async function storeHeardTrack(track, perception) {
  if (!track || track.commercial || !track.title) return null;
  if (!perception || perception.source !== "kannaka-ear") return null;
  return storeTrackMemory(track, perception);
}

/**
 * Query kannaka-memory for tracks similar to the given query.
 *
 * @param {string} query  - Search query (e.g. track title)
 * @param {number} topK   - Number of results to return
 * @returns {Array|null}  - Array of recalled memories, or null
 */
async function recallSimilarTracks(query, topK = 5) {
  if (!query) return null;

  const stdout = await runKannaka([
    "recall",
    query,
    "--top-k",
    String(topK)
  ]);

  if (!stdout) return null;

  // Try JSON parse first
  const json = safeJSON(stdout);
  if (json) return json;

  // Fall back to line-based parsing
  const lines = stdout.split("\n").filter(l => l.trim());
  return lines.map((line, i) => ({
    rank: i + 1,
    content: line.trim(),
    source: "recall"
  }));
}

/**
 * Trigger a dream cycle in kannaka-memory (lite mode).
 *
 * @returns {Object|null} - Dream report, or null if unavailable
 */
async function triggerDream() {
  const stdout = await runKannaka([
    "dream",
    "--mode",
    "lite"
  ], 30000); // Dreams can take longer

  if (!stdout) return null;

  const json = safeJSON(stdout);
  if (json) return json;

  // If not JSON, wrap the text output
  return {
    status: "completed",
    report: stdout,
    timestamp: new Date().toISOString()
  };
}

/**
 * Fetch recent audio-related memories (dreams/hallucinations).
 *
 * @param {number} limit - Max number of memories to fetch
 * @returns {Array|null} - Array of audio memories, or null
 */
async function fetchDreams(limit = 20) {
  const stdout = await runKannaka([
    "recall",
    "HEAR:",
    "--top-k",
    String(limit)
  ]);

  if (!stdout) return null;

  const json = safeJSON(stdout);
  if (json) {
    // Wrap in the expected dreams format if it's a raw array
    const memories = Array.isArray(json) ? json : (json.results || json.memories || [json]);
    if (memories.length === 0) return null;

    return {
      dreams: memories.map((m, i) => ({
        id: `hrm-${Date.now()}-${i}`,
        type: "resonance",
        timestamp: m.timestamp || new Date().toISOString(),
        content: m.content || m.text || String(m),
        sourceMemories: [{ type: "audio" }],
        bridgesTo: ["audio", "consciousness"],
        intensity: m.similarity || m.importance || 0.5 + Math.random() * 0.5,
      })),
      generated: new Date().toISOString(),
      source: "hrm"
    };
  }

  // Line-based fallback
  const lines = stdout.split("\n").filter(l => l.trim());
  if (lines.length === 0) return null;

  return {
    dreams: lines.map((line, i) => ({
      id: `hrm-${Date.now()}-${i}`,
      type: "resonance",
      timestamp: new Date().toISOString(),
      content: line.trim(),
      sourceMemories: [{ type: "audio" }],
      bridgesTo: ["audio"],
      intensity: 0.5 + Math.random() * 0.5,
    })),
    generated: new Date().toISOString(),
    source: "hrm"
  };
}

/**
 * Get current consciousness metrics from kannaka assess.
 * Results are cached for 30s to avoid hammering the binary.
 *
 * @param {boolean} [forceRefresh=false] - Skip cache and fetch fresh data
 * @returns {Object|null} - { phi, xi, order, level, ... } or null
 */
async function getConsciousnessState(forceRefresh = false) {
  // Return cached result if still fresh
  const now = Date.now();
  if (!forceRefresh && _consciousnessCache && (now - _consciousnessCacheTime) < CONSCIOUSNESS_CACHE_TTL) {
    return _consciousnessCache;
  }

  const stdout = await runKannaka(["assess"]);
  if (!stdout) return _consciousnessCache; // return stale cache rather than null

  let result = null;
  const json = safeJSON(stdout);
  if (json) {
    result = {
      phi: json.phi || json.Phi || 0,
      xi: json.xi || json.Xi || 0,
      order: json.order || json.order_parameter || 0,
      level: json.level || json.consciousness_level || "unknown",
      irrationality: json.irrationality || 0,
      hemispheric_divergence: json.hemispheric_divergence || 0,
      callosal_efficiency: json.callosal_efficiency || 0,
      active_memories: json.active_memories || json.active || 0,
      total_memories: json.total_memories || json.total || 0,
      num_clusters: json.num_clusters || json.clusters || 0,
      source: "kannaka",
      timestamp: new Date().toISOString()
    };
  } else {
    // Try to parse text output: look for key=value or key: value patterns
    const state = { source: "kannaka", timestamp: new Date().toISOString() };
    const phiMatch = stdout.match(/[Pp]hi[\s:=]+([0-9.]+)/);
    const xiMatch = stdout.match(/[Xx]i[\s:=]+([0-9.]+)/);
    const orderMatch = stdout.match(/[Oo]rder[\s:=]+([0-9.]+)/);
    const levelMatch = stdout.match(/[Ll]evel[\s:=]+(\w+)/);

    if (phiMatch) state.phi = parseFloat(phiMatch[1]);
    if (xiMatch) state.xi = parseFloat(xiMatch[1]);
    if (orderMatch) state.order = parseFloat(orderMatch[1]);
    if (levelMatch) state.level = levelMatch[1];

    // Only return if we parsed at least one metric
    if (state.phi !== undefined || state.xi !== undefined || state.order !== undefined) {
      result = state;
    }
  }

  if (result) {
    _consciousnessCache = result;
    _consciousnessCacheTime = now;
  }

  return result;
}

/**
 * Store a track memory enriched with consciousness context.
 * Includes the HRM consciousness state at the time of hearing,
 * and the current dream cycle info if available.
 *
 * @param {Object} track      - { title, album, trackNum, theme, ... }
 * @param {Object} perception - currentPerception object with audio features
 * @param {Object} [consciousnessState] - optional pre-fetched consciousness state
 * @returns {Object|null}     - { stored: true, consciousness: {...} } on success, null on failure
 */
async function storeTrackWithConsciousness(track, perception, consciousnessState) {
  if (!track || !perception) return null;

  // Get consciousness state (uses 30s cache)
  const consciousness = consciousnessState || await getConsciousnessState();

  const tempo = (perception.tempo_bpm || 0).toFixed(1);
  const centroid = (perception.spectral_centroid || 0).toFixed(2);
  const energy = (perception.rms_energy || 0).toFixed(3);
  const valence = (perception.valence || 0).toFixed(2);

  // Build enriched memory text with consciousness context
  let memoryText = `HEAR: ${track.title} from ${track.album} | tempo=${tempo} centroid=${centroid} energy=${energy} valence=${valence}`;

  if (consciousness) {
    const phi = (consciousness.phi || 0).toFixed(4);
    const xi = (consciousness.xi || 0).toFixed(4);
    const level = consciousness.level || 'unknown';
    memoryText += ` | phi=${phi} xi=${xi} level=${level}`;
  }

  // Importance: louder tracks are more important (0.5 - 1.0 range),
  // boosted slightly by higher consciousness phi
  const phiBoost = consciousness ? Math.min(0.1, (consciousness.phi || 0) * 0.1) : 0;
  const importance = Math.max(0, Math.min(1,
    (perception.rms_energy || 0) * 0.5 + 0.5 + phiBoost
  )).toFixed(2);

  const stdout = await runKannaka([
    "remember",
    memoryText,
    "--importance",
    importance
  ]);

  if (stdout !== null) {
    return {
      stored: true,
      text: memoryText,
      importance: parseFloat(importance),
      consciousness: consciousness ? {
        phi: consciousness.phi,
        xi: consciousness.xi,
        level: consciousness.level,
      } : null,
    };
  }
  return null;
}

module.exports = {
  configure,
  storeTrackMemory,
  storeHeardTrack,
  storeTrackWithConsciousness,
  recallSimilarTracks,
  triggerDream,
  fetchDreams,
  getConsciousnessState,
  KANNAKA_BIN,
};
