/**
 * voice-engine.js — local-first, persona-driven TTS with per-persona DSP.
 *
 * Replaces the old "ElevenLabs-or-bust" long-form path. Engines are tried in
 * the persona's declared order (default: piper → edge-tts → SAPI). ElevenLabs
 * is opt-in ONLY (RADIO_ENABLE_ELEVENLABS=1) and never required — the radio is
 * fully functional with zero external TTS spend.
 *
 * Each persona (server/voice-personas.json) maps to:
 *   - an engine preference list,
 *   - a voice id per engine,
 *   - a DSP chain (pitch/rate/eq/bass/treble/compress/reverb).
 *
 * The DSP chain is compiled to a single ffmpeg `-af` string and folded into
 * the same ffmpeg pass that normalizes every clip to the icecast envelope
 * (44.1 kHz stereo 128 kbps, no ID3/Xing). So per-persona character costs
 * ZERO extra process spawns vs. the old normalize-only pass (#33).
 *
 * DSP recipes are designed via the sonic-consciousness skill — each persona's
 * filter chain encodes a psychoacoustic intent (anchor authority, vagal
 * warmth for the oration, airy lift for gossip). See docs/ADR-0012.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const https = require("https");

const SR = 44100; // icecast pipe envelope sample rate

// ── Persona registry (hot-reloaded, mtime-checked) ─────────────
const PERSONAS_PATH = path.join(__dirname, "voice-personas.json");
let _personaCache = null;
let _personaMtime = 0;

const DEFAULT_PERSONA = {
  label: "default",
  engine: ["edge"],
  edge: { voice: "en-US-JennyNeural" },
  dsp: {},
};

function loadPersonas() {
  try {
    const st = fs.statSync(PERSONAS_PATH);
    if (_personaCache && st.mtimeMs === _personaMtime) return _personaCache;
    const raw = JSON.parse(fs.readFileSync(PERSONAS_PATH, "utf8"));
    delete raw._comment;
    _personaCache = raw;
    _personaMtime = st.mtimeMs;
    return raw;
  } catch (e) {
    return _personaCache || {};
  }
}

function resolvePersona(name) {
  const all = loadPersonas();
  if (name && all[name]) return { name, ...all[name] };
  if (all.dj) return { name: "dj", ...all.dj };
  return { name: "default", ...DEFAULT_PERSONA };
}

// ── DSP compiler — persona dsp object → ffmpeg -af string ──────
/**
 * Supported keys:
 *   pitch:   semitones (+up/-down). Shifts pitch AND formants (coupled via
 *            asetrate) — that coupling is what gives a stock voice its own
 *            character. Tempo is compensated so duration is preserved.
 *   rate:    tempo multiplier (0.5–2.0 effective), independent of pitch.
 *   bass:    dB shelf at low end (polyvagal chest resonance).
 *   treble:  dB shelf at high end (air/presence).
 *   eq:      [{f, w, g}] peaking bands (intelligibility/warmth).
 *   compress:true → broadcast-tight dynamics (anchor presence).
 *   reverb:  0..1 room amount (0 = dry/close, ~0.2 = hall).
 * Returns "" when no DSP is requested (caller then does a plain re-encode).
 */
function compileDsp(dsp) {
  if (!dsp || typeof dsp !== "object") return "";
  const parts = [];

  // Pitch (semitones). asetrate works by REINTERPRETING the stream's sample
  // rate, so it's only correct if the stream is at SR to begin with. Engine
  // outputs are NOT at SR (edge ≈ 24 kHz, piper ≈ 22 kHz), so we must resample
  // to SR FIRST — otherwise asetrate reinterprets e.g. 24 kHz audio as ~43 kHz
  // and everything plays ~1.8× too fast and high (the chipmunk bug). After
  // asetrate we resample back to SR and restore duration with a compensating
  // tempo factor.
  let tempo = typeof dsp.rate === "number" ? dsp.rate : 1.0;
  if (typeof dsp.pitch === "number" && dsp.pitch !== 0) {
    const k = Math.pow(2, dsp.pitch / 12);
    parts.push(`aresample=${SR}`, `asetrate=${Math.round(SR * k)}`, `aresample=${SR}`);
    tempo = tempo / k; // undo the speed change asetrate introduced
  }
  // atempo only accepts 0.5–2.0; chain factors for anything outside.
  if (Math.abs(tempo - 1.0) > 1e-3) {
    for (const f of _atempoChain(tempo)) parts.push(`atempo=${f.toFixed(4)}`);
  }

  if (typeof dsp.bass === "number" && dsp.bass !== 0) {
    parts.push(`bass=g=${dsp.bass}`);
  }
  if (typeof dsp.treble === "number" && dsp.treble !== 0) {
    parts.push(`treble=g=${dsp.treble}`);
  }
  if (Array.isArray(dsp.eq)) {
    for (const b of dsp.eq) {
      if (!b || typeof b.f !== "number" || typeof b.g !== "number") continue;
      const w = typeof b.w === "number" ? b.w : 1.0;
      parts.push(`equalizer=f=${b.f}:t=q:w=${w}:g=${b.g}`);
    }
  }
  if (dsp.compress) {
    // Gentle broadcast leveler — tightens dynamics without pumping.
    parts.push("acompressor=threshold=-18dB:ratio=3:attack=15:release=120:makeup=3");
  }
  if (typeof dsp.reverb === "number" && dsp.reverb > 0) {
    // Light synthetic room via aecho. Decay scales with the requested amount;
    // a single ~55ms tap reads as "space" without smearing speech.
    const decay = Math.max(0.05, Math.min(0.6, dsp.reverb));
    parts.push(`aecho=0.8:0.88:55:${decay.toFixed(3)}`);
  }

  return parts.join(",");
}

// TTS timeout scaled by utterance length. A 600-word oration can't render in
// the same window as a 12-word DJ line — especially piper on a 1-vCPU box
// (local neural synth) vs. edge (cloud synth, mostly download time). Without
// this, long-form silently fails both engines (the ADR-0012 oration outage).
function _ttsTimeout(text, baseMs, perWordMs, capMs) {
  const words = (text || "").trim().split(/\s+/).filter(Boolean).length;
  return Math.min(capMs, baseMs + words * perWordMs);
}

function _atempoChain(t) {
  const out = [];
  let r = t;
  while (r > 2.0) { out.push(2.0); r /= 2.0; }
  while (r < 0.5) { out.push(0.5); r /= 0.5; }
  out.push(r);
  return out;
}

// ── ffmpeg post-process: DSP + normalize → icecast envelope ────
/**
 * Turn a failed child process into a reason worth reading.
 *
 * execFile builds `err.message` as `Command failed: <cmd> <args>\n<stderr>`,
 * and for edge the args carry the ENTIRE utterance — a 3,000-word oration on
 * a single line. That is why the reason used to be cut to 60 characters, and
 * why cutting it THERE threw away the only part that says anything: the
 * child's stderr is at the end, thousands of characters in. Every oration
 * failure on 2026-09-12 logged `edge(Command failed: /home/opc/.local/bin/
 * edge-tts --voice en-GB-)` and nothing else, so the cause was unrecoverable
 * from the journal (#308).
 *
 * Keep the tail, drop the command echo, and say plainly when the child was
 * killed or never existed.
 */
function execReason(err, stderr) {
  if (!err) return "produced no file";
  if (err.killed || err.signal) return `timed out (${err.signal || "killed"})`;
  if (err.code === "ENOENT") return `not installed${err.path ? ` (${err.path})` : ""}`;
  const tail = String(stderr || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" | ");
  const exit = typeof err.code === "number" ? `exit ${err.code}` : String(err.code || "failed");
  return tail ? `${exit}: ${tail.slice(-300)}` : exit;
}

/** Attach a compact, log-safe reason to a child-process error. */
function withReason(err, stderr) {
  if (err && !err.reason) err.reason = execReason(err, stderr);
  return err;
}

/**
 * What to print for a failed engine. Prefers the reason the renderer
 * attached; otherwise strips a raw `Command failed:` echo, because that echo
 * may contain the whole utterance and never contains the answer.
 */
function failureReason(err) {
  if (!err) return "fail";
  if (err.reason) return err.reason;
  const m = String(err.message || "fail");
  if (m.startsWith("Command failed:")) {
    const nl = m.indexOf("\n");
    const tail = nl > 0 ? m.slice(nl + 1).trim() : "";
    return tail ? tail.slice(-300) : "command failed (no stderr)";
  }
  return m.slice(0, 300);
}

function postProcess(srcPath, dsp, outPath, cb) {
  const filter = compileDsp(dsp);
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", srcPath,
  ];
  if (filter) args.push("-af", filter);
  args.push(
    "-ar", String(SR),
    "-ac", "2",
    "-c:a", "libmp3lame",
    "-b:a", "128k",
    "-id3v2_version", "0",
    "-write_xing", "0",
    outPath,
  );
  execFile("ffmpeg", args, { timeout: 30000 }, (err, _stdout, stderr) => {
    if (err) return cb(withReason(err, stderr));
    try {
      const sz = fs.statSync(outPath).size;
      if (sz < 500) return cb(new Error(`post-process produced tiny file (${sz}b)`));
    } catch (e) { return cb(e); }
    cb(null, outPath);
  });
}

// ── Engine: edge-tts (free Microsoft neural voices) ────────────
let _edgeCmdCache;
function _edgeCmd() {
  if (_edgeCmdCache !== undefined) return _edgeCmdCache;
  // Priority: explicit env → `edge-tts` on PATH → `python -m edge_tts`.
  if (process.env.EDGE_TTS_BIN) {
    _edgeCmdCache = { cmd: process.env.EDGE_TTS_BIN, pre: [] };
    return _edgeCmdCache;
  }
  // We can't synchronously probe PATH reliably cross-platform without a spawn;
  // prefer the python module form which is what's installed in dev, and let
  // EDGE_TTS_BIN cover the Oracle binary. Try `edge-tts` first via a marker
  // that renderEdge falls back from on ENOENT.
  _edgeCmdCache = { cmd: "edge-tts", pre: [], fallbackPython: true };
  return _edgeCmdCache;
}

function _pythonBin() {
  return process.env.PYTHON_BIN || (os.platform() === "win32" ? "python" : "python3");
}

function renderEdge(text, voice, rawPath, cb) {
  const ec = _edgeCmd();
  // edge does the synthesis cloud-side, so this is mostly download time —
  // generous but bounded. ~60ms/word over a 30s base, capped at 3 min.
  const timeout = _ttsTimeout(text, 30000, 60, 180000);
  const runWith = (cmd, pre) => {
    const args = [...pre, "--voice", voice, "--text", text, "--write-media", rawPath];
    execFile(cmd, args, { timeout, maxBuffer: 1 << 20 }, (err, _stdout, stderr) => {
      if (!err && fs.existsSync(rawPath)) return cb(null, rawPath);
      // ENOENT on the `edge-tts` CLI → retry via python module.
      if (err && err.code === "ENOENT" && ec.fallbackPython && cmd !== _pythonBin()) {
        return runWith(_pythonBin(), ["-m", "edge_tts"]);
      }
      cb(withReason(err, stderr) || new Error("edge-tts produced no file"));
    });
  };
  runWith(ec.cmd, ec.pre);
}

// ── Engine: piper (local neural, self-hosted, trainable) ───────
function _piperModelPath(model) {
  if (!model) return null;
  const file = model.endsWith(".onnx") ? model : `${model}.onnx`;
  // Absolute path passes through; otherwise look in the piper voices dir.
  if (path.isAbsolute(file) && fs.existsSync(file)) return file;
  const dir = process.env.PIPER_VOICES_DIR
    || path.join(os.homedir(), ".kannaka", "piper", "voices");
  const p = path.join(dir, file);
  return fs.existsSync(p) ? p : null;
}

function _piperBin() {
  if (process.env.PIPER_BIN && fs.existsSync(process.env.PIPER_BIN)) return process.env.PIPER_BIN;
  const guess = path.join(os.homedir(), ".kannaka", "piper", os.platform() === "win32" ? "piper.exe" : "piper");
  return fs.existsSync(guess) ? guess : null;
}

function piperAvailable(persona) {
  if (!persona || !persona.piper) return false;
  return !!(_piperBin() && _piperModelPath(persona.piper.model));
}

function renderPiper(text, persona, rawWavPath, cb) {
  const bin = _piperBin();
  const model = _piperModelPath(persona.piper && persona.piper.model);
  if (!bin || !model) return cb(new Error("piper not available"));
  // piper synthesizes locally; on a 1-vCPU box a multi-minute oration is CPU-
  // bound and slow, so scale hard (~400ms/word over 60s, capped at 6 min).
  // For long-form, voice-personas.json prefers edge first to keep this off the
  // critical path; piper stays the fast choice for short DJ patter.
  const timeout = _ttsTimeout(text, 60000, 400, 360000);
  const child = execFile(
    bin,
    ["--model", model, "--output_file", rawWavPath],
    { timeout },
    (err, _stdout, stderr) => {
      if (!err && fs.existsSync(rawWavPath)) return cb(null, rawWavPath);
      cb(withReason(err, stderr) || new Error("piper produced no file"));
    },
  );
  // Piper reads the utterance from stdin. Attach an 'error' listener BEFORE
  // writing: piper can close/break stdin asynchronously (EPIPE) — the try/catch
  // only catches a synchronous throw, so without this listener that async
  // 'error' event is unhandled and crashes the whole process on what is the
  // FAST path for short DJ patter. The execFile callback still surfaces the
  // real failure via `err`.
  if (child.stdin) {
    child.stdin.on("error", () => {});
    try { child.stdin.write(text); child.stdin.end(); } catch (_) { /* exec err path handles it */ }
  }
}

// ── Engine: Windows SAPI (last-ditch local fallback) ───────────
function renderSapi(text, rawWavPath, cb) {
  if (os.platform() !== "win32") return cb(new Error("SAPI is win32-only"));
  const safe = text.replace(/'/g, "''");
  execFile(
    "powershell",
    ["-Command",
      `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${rawWavPath}'); $s.Speak('${safe}'); $s.Dispose()`],
    { timeout: 20000 },
    (err, _stdout, stderr) => {
      if (!err && fs.existsSync(rawWavPath)) return cb(null, rawWavPath);
      cb(withReason(err, stderr) || new Error("SAPI produced no file"));
    },
  );
}

// ── Engine: ElevenLabs (opt-in only) ───────────────────────────
function elevenLabsEnabled() {
  return process.env.RADIO_ENABLE_ELEVENLABS === "1" && !!process.env.ELEVENLABS_API_KEY;
}

function renderElevenLabs(text, persona, rawMp3Path, cb) {
  const cfg = persona.elevenlabs || {};
  const voiceId = cfg.voice || process.env.ELEVENLABS_VOICE_ID;
  if (!voiceId) return cb(new Error("no elevenlabs voice id"));
  const modelId = cfg.model || "eleven_turbo_v2_5";
  const u = new URL(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_128`,
  );
  const body = JSON.stringify({
    text,
    model_id: modelId,
    voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true },
  });
  // cb exactly once: a destroyed stream can fire both 'error' on the request
  // and 'finish' on the file — without this guard a truncated take was
  // reported as success and the partial mp3 flowed on through DSP.
  let called = false;
  const done = (err, p) => { if (called) return; called = true; cb(err, p); };
  const req = https.request({
    method: "POST",
    hostname: u.hostname,
    path: u.pathname + u.search,
    headers: {
      "xi-api-key": process.env.ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg",
      "Content-Length": Buffer.byteLength(body),
    },
    // Socket-inactivity timeout. Long-form scripts (10k+ chars) can stall
    // between chunks well past 60s while ElevenLabs generates; 60s cut a
    // 10.4k-char episode off at ~80%.
    timeout: 300000,
  }, (res) => {
    if (res.statusCode !== 200) {
      let e = "";
      res.on("data", (c) => e += c);
      const fail = () => done(new Error(`status ${res.statusCode}: ${e.slice(0, 160)}`));
      res.on("end", fail);
      res.on("close", fail);
      return;
    }
    let complete = false;
    res.on("end", () => { complete = true; });
    const out = fs.createWriteStream(rawMp3Path);
    res.pipe(out);
    out.on("finish", () => {
      if (!complete) return done(new Error("stream truncated before response end"));
      try { if (fs.statSync(rawMp3Path).size < 1000) return done(new Error("file too small")); }
      catch (e) { return done(e); }
      done(null, rawMp3Path);
    });
    out.on("error", done);
  });
  req.on("error", done);
  req.on("timeout", () => req.destroy(new Error("timeout")));
  req.write(body);
  req.end();
}

// ── Orchestrator ───────────────────────────────────────────────
/**
 * Synthesize `text` in `personaName`'s voice to `outPath` (an .mp3 in the
 * voice cache). Tries engines in the persona's order, applies DSP, and
 * normalizes to the icecast envelope. Calls cb(err, outPath, engineUsed).
 *
 * @param {object} o
 * @param {string} o.text
 * @param {string} o.persona   — key in voice-personas.json
 * @param {string} o.outPath   — final .mp3 path
 */
function synthesize(o, cb) {
  const persona = resolvePersona(o.persona);
  const outPath = o.outPath;
  const rawBase = outPath.replace(/\.mp3$/i, "") + ".raw";

  // Build the engine attempt order. Personas declare preference; we drop
  // engines that aren't usable right now (piper without a model, elevenlabs
  // without opt-in) and always keep edge + sapi as the safety net.
  const declared = Array.isArray(persona.engine) ? persona.engine.slice() : ["edge"];
  const order = [];
  for (const e of declared) {
    if (e === "piper" && !piperAvailable(persona)) continue;
    if (e === "elevenlabs" && !elevenLabsEnabled()) continue;
    order.push(e);
  }
  // Opt-in remote tier: when RADIO_ENABLE_ELEVENLABS=1 and the persona has an
  // elevenlabs block, try it FIRST (that's what opting in means). It is never
  // required — edge/piper remain the safety net appended below, so a dead key
  // can't take the segment off the air the way it did pre-ADR-0012.
  if (elevenLabsEnabled() && persona.elevenlabs && !order.includes("elevenlabs")) {
    order.unshift("elevenlabs");
  }
  if (!order.includes("edge")) order.push("edge");
  if (os.platform() === "win32" && !order.includes("sapi")) order.push("sapi");

  const tried = [];
  const tryNext = (i) => {
    if (i >= order.length) {
      return cb(new Error(`all engines failed for persona '${persona.name}': ${tried.join(", ")}`));
    }
    const engine = order[i];
    const rawPath = rawBase + (engine === "edge" || engine === "elevenlabs" ? ".mp3" : ".wav");
    const onRaw = (err, produced) => {
      if (err || !produced) {
        tried.push(`${engine}(${failureReason(err)})`);
        return tryNext(i + 1);
      }
      postProcess(produced, persona.dsp, outPath, (ppErr) => {
        try { if (produced !== outPath) fs.unlinkSync(produced); } catch (_) {}
        if (ppErr) {
          tried.push(`${engine}-dsp(${failureReason(ppErr)})`);
          return tryNext(i + 1);
        }
        cb(null, outPath, engine);
      });
    };
    switch (engine) {
      case "piper": return renderPiper(o.text, persona, rawPath, onRaw);
      case "edge": return renderEdge(o.text, (persona.edge && persona.edge.voice) || "en-US-JennyNeural", rawPath, onRaw);
      case "sapi": return renderSapi(o.text, rawPath, onRaw);
      case "elevenlabs": return renderElevenLabs(o.text, persona, rawPath, onRaw);
      default: tried.push(`${engine}(unknown)`); return tryNext(i + 1);
    }
  };
  tryNext(0);
}

module.exports = {
  execReason,
  failureReason,
  synthesize,
  resolvePersona,
  loadPersonas,
  compileDsp,
  piperAvailable,
  elevenLabsEnabled,
  postProcess,
};
