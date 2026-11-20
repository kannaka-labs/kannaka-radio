'use strict';
/**
 * tts-long-form-budget.test.js — a peace oration gets a TTS budget it can meet.
 *
 * 2026-10-08, O1 (1 vCPU): the noon oration was 526 words. edge-tts rendered it
 * in 62 s; the budget was 30 s + 60 ms/word = 61.6 s, so edge timed out on
 * every attempt. piper (en_GB-cori-high) needed more than 381 s against a
 * 270 s budget, so it timed out too, every time, after holding the talk lock.
 * Three attempts of that chain held the lock ~15 min; the staff watchdog
 * called it stuck at 5 min and restarted the radio mid-song. Five restarts
 * that day; two orations and the artist story never aired.
 *
 * This pins: edge's budget has real headroom for a 500-700 word oration; piper
 * is not attempted above PIPER_MAX_WORDS (it fails fast with a reason, so the
 * next edge attempt comes sooner); short DJ patter still reaches piper.
 */
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

let failures = 0;
const pending = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => console.log('  ok   ' + name),
        (e) => { failures++; console.error('  FAIL ' + name + '\n       ' + e.message); },
      ));
    } else {
      console.log('  ok   ' + name);
    }
  } catch (e) { failures++; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const ORATION_526 = words(526);
const MEASURED_EDGE_MS = 62000;   // O1, 2026-10-08, 526 words, en-GB-SoniaNeural

console.log('tts-long-form-budget');

const ve = require('../server/voice-engine');

test('a 526-word oration gets edge at least twice the time it measured', () => {
  const t = ve.edgeTimeoutMs(ORATION_526);
  assert.ok(t >= 2 * MEASURED_EDGE_MS, `edge budget ${t} ms < 2 × measured ${MEASURED_EDGE_MS} ms`);
});

test('a 700-word oration still fits under the edge cap with headroom', () => {
  const t = ve.edgeTimeoutMs(words(700));
  assert.ok(t >= 150000, `edge budget for 700 words is ${t} ms`);
  assert.ok(t <= 300000, 'and bounded');
});

test('short patter keeps a short budget', () => {
  assert.ok(ve.edgeTimeoutMs(words(12)) <= 70000);
  assert.ok(ve.piperTimeoutMs(words(12)) <= 70000);
});

// 2026-10-14 05:01Z: the noon oration (613 words, ~236 s of audio) rendered
// fine and then died in the DSP pass, which had a fixed 30 s ffmpeg budget.
test('the DSP pass gets a budget that grows with the text, like the renders', () => {
  const t = ve.dspTimeoutMs(words(613));
  assert.ok(t >= 150000, `dsp budget for 613 words is ${t} ms`);
  assert.ok(t <= 300000, 'and bounded');
  assert.ok(ve.dspTimeoutMs(words(12)) <= 40000, 'short patter stays short');
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'server', 'voice-engine.js'), 'utf8');
  assert.ok(/\{ timeout: timeoutMs \}/.test(src), 'ffmpeg uses the passed budget, not a constant');
  assert.ok(/\}, dspTimeoutMs\(o\.text\)\);/.test(src), 'the render path passes the text-scaled budget');
});

test('PIPER_MAX_WORDS defaults to 300 and reads the environment', () => {
  const saved = process.env.PIPER_MAX_WORDS;
  try {
    delete process.env.PIPER_MAX_WORDS;
    assert.strictEqual(ve.piperMaxWords(), 300);
    process.env.PIPER_MAX_WORDS = '450';
    assert.strictEqual(ve.piperMaxWords(), 450);
    process.env.PIPER_MAX_WORDS = 'nonsense';
    assert.strictEqual(ve.piperMaxWords(), 300);
  } finally {
    if (saved === undefined) delete process.env.PIPER_MAX_WORDS; else process.env.PIPER_MAX_WORDS = saved;
  }
});

// ── End to end through synthesize(): which engines run, with what budget ──
// Fake execFile: edge "times out" (killed), piper is recorded if called.
function withFakeExecFile(behaviour, run) {
  const realExecFile = cp.execFile;
  const calls = [];
  cp.execFile = (cmd, args, opts, done) => {
    const fn = typeof opts === 'function' ? opts : done;
    const o = typeof opts === 'object' && opts ? opts : {};
    calls.push({ cmd: String(cmd), args, timeout: o.timeout });
    process.nextTick(() => behaviour(cmd, args, fn));
    return { stdin: { on() {}, write() {}, end() {} }, kill() {} };
  };
  delete require.cache[require.resolve('../server/voice-engine')];
  const fresh = require('../server/voice-engine');
  return run(fresh, calls).finally(() => {
    cp.execFile = realExecFile;
    delete require.cache[require.resolve('../server/voice-engine')];
  });
}
const killed = (fn) => { const e = new Error('Command failed'); e.killed = true; e.signal = 'SIGTERM'; fn(e, '', ''); };
const isEdge = (c) => /edge/.test(c.cmd) || (c.args || []).includes('edge_tts');
// piper is recognised by its argv (the fake PIPER_BIN is this test file), edge by its command.
const isPiper = (c) => (c.args || []).includes('--model');

test('a 526-word oration: edge runs with the long budget and piper is not attempted', () => {
  // piper must look available for the test to mean anything: point it at this file.
  const savedBin = process.env.PIPER_BIN, savedDir = process.env.PIPER_VOICES_DIR;
  process.env.PIPER_BIN = __filename;
  process.env.PIPER_VOICES_DIR = __dirname;           // en_GB-cori-high.onnx will not exist here…
  const fs = require('node:fs');
  const fakeModel = path.join(__dirname, 'en_GB-cori-high.onnx');
  fs.writeFileSync(fakeModel, '');                    // …so make it exist for the duration
  return withFakeExecFile((cmd, args, fn) => killed(fn), (fresh, calls) => {
    let seen = null;
    fresh.synthesize({ text: ORATION_526, persona: 'oration', outPath: path.join(os.tmpdir(), 'tts-budget-526.mp3') }, (err) => { seen = err; });
    return new Promise((r) => setTimeout(r, 150)).then(() => {
      assert.ok(seen, 'all engines fail in this fake, so synthesize must report it');
      const edge = calls.filter(isEdge);
      assert.ok(edge.length >= 1, 'edge was attempted');
      assert.ok(edge.every((c) => c.timeout >= 2 * MEASURED_EDGE_MS), `edge budget on the wire: ${edge.map((c) => c.timeout)}`);
      assert.strictEqual(calls.filter(isPiper).length, 0, 'piper must not be spawned for 526 words');
      assert.ok(/piper\(skipped/.test(seen.message), `the reason names the skip: ${seen.message}`);
    });
  }).finally(() => {
    try { fs.unlinkSync(fakeModel); } catch (_) {}
    if (savedBin === undefined) delete process.env.PIPER_BIN; else process.env.PIPER_BIN = savedBin;
    if (savedDir === undefined) delete process.env.PIPER_VOICES_DIR; else process.env.PIPER_VOICES_DIR = savedDir;
  });
});

test('a 20-word line still reaches piper when edge fails', () => {
  const savedBin = process.env.PIPER_BIN, savedDir = process.env.PIPER_VOICES_DIR;
  process.env.PIPER_BIN = __filename;
  process.env.PIPER_VOICES_DIR = __dirname;
  const fs = require('node:fs');
  const fakeModel = path.join(__dirname, 'en_GB-cori-high.onnx');
  fs.writeFileSync(fakeModel, '');
  return withFakeExecFile((cmd, args, fn) => killed(fn), (fresh, calls) => {
    fresh.synthesize({ text: words(20), persona: 'oration', outPath: path.join(os.tmpdir(), 'tts-budget-20.mp3') }, () => {});
    return new Promise((r) => setTimeout(r, 150)).then(() => {
      assert.ok(calls.some(isPiper), `piper was attempted for short text: ${calls.map((c) => c.cmd)}`);
    });
  }).finally(() => {
    try { fs.unlinkSync(fakeModel); } catch (_) {}
    if (savedBin === undefined) delete process.env.PIPER_BIN; else process.env.PIPER_BIN = savedBin;
    if (savedDir === undefined) delete process.env.PIPER_VOICES_DIR; else process.env.PIPER_VOICES_DIR = savedDir;
  });
});

// ── 2026-11-20: edge slowed to about the speed of speech ──
// O1 measured 204 s and 198 s for 735 words, 40 s for 120 words. The 150 ms/word
// budget killed every 620-775 word oration; it missed its slot on most days
// from 11-12. A long text now goes out as pieces in parallel and is joined.
const MEASURED_EDGE_MS_PER_WORD_NOV = 272;
const sentence = (n) => Array.from({ length: n }, (_, i) => `s${i}`).join(' ') + '.';

test('the per-word budget is at least twice the rate measured in November', () => {
  const perWord = (ve.edgeTimeoutMs(words(200)) - ve.edgeTimeoutMs(words(100))) / 100;
  assert.ok(perWord >= 2 * MEASURED_EDGE_MS_PER_WORD_NOV, `per-word budget ${perWord} ms`);
});

test('splitForEdge: a short text is one piece, a long one is cut on sentence ends', () => {
  assert.deepStrictEqual(ve.splitForEdge('Hello there. How are you?', 180), ['Hello there. How are you?']);
  assert.strictEqual(ve.splitForEdge(words(220), 180).length, 1, 'a quarter over the limit is not worth a cut');
  const text = Array.from({ length: 21 }, () => sentence(35)).join(' ');   // 735 words
  const pieces = ve.splitForEdge(text, 180);
  assert.ok(pieces.length >= 4, `pieces: ${pieces.length}`);
  for (const p of pieces) {
    assert.ok(p.split(/\s+/).length <= 180, 'no piece over the limit');
    assert.ok(/\.$/.test(p), 'every piece ends on a sentence end');
  }
  assert.strictEqual(pieces.join(' '), text, 'nothing lost, nothing reordered');
  const run = ve.splitForEdge(words(400), 180);
  assert.deepStrictEqual(run.map((p) => p.split(/\s+/).length), [180, 180, 40], 'a sentence with no end is cut on words');
});

test('a 735-word oration: edge is asked for pieces, each with a budget it can meet, then joined', () => {
  const fs = require('node:fs');
  const text = Array.from({ length: 21 }, () => sentence(35)).join(' ');
  const out = path.join(os.tmpdir(), `tts-budget-735-${process.pid}.mp3`);
  const lastArg = (args) => args[args.length - 1];
  return withFakeExecFile((cmd, args, fn) => {
    if (/edge/.test(String(cmd))) { fs.writeFileSync(args[args.indexOf('--write-media') + 1], 'x'); return fn(null, '', ''); }
    if (args.includes('null')) return fn(new Error('no measure in this fake'), '', '');   // loudness pass
    fs.writeFileSync(lastArg(args), Buffer.alloc(600));                                   // join, then encode
    fn(null, '', '');
  }, (fresh, calls) => new Promise((resolve, reject) => {
    fresh.synthesize({ text, persona: 'oration', outPath: out }, (err, _p, engine) => {
      try {
        assert.ifError(err);
        assert.strictEqual(engine, 'edge');
        const edge = calls.filter(isEdge);
        assert.ok(edge.length >= 4, `edge calls: ${edge.length}`);
        for (const c of edge) {
          const n = c.args[c.args.indexOf('--text') + 1].split(/\s+/).length;
          assert.ok(n <= 180, `piece of ${n} words`);
          assert.ok(c.timeout >= 2 * MEASURED_EDGE_MS_PER_WORD_NOV * n, `piece budget ${c.timeout} ms for ${n} words`);
        }
        const join = calls.filter((c) => c.cmd === 'ffmpeg' && c.args.includes('concat'));
        assert.strictEqual(join.length, 1, 'one join');
        assert.deepStrictEqual(join[0].args.slice(join[0].args.indexOf('-c'), join[0].args.indexOf('-c') + 2), ['-c', 'copy']);
        resolve();
      } catch (e) { reject(e); } finally { try { fs.unlinkSync(out); } catch (_) {} }
    });
  }));
});

test('a piece that fails twice fails the render and names the piece', () => {
  const text = Array.from({ length: 21 }, () => sentence(35)).join(' ');
  return withFakeExecFile((cmd, args, fn) => killed(fn), (fresh, calls) => new Promise((resolve, reject) => {
    fresh.synthesize({ text, persona: 'oration', outPath: path.join(os.tmpdir(), 'tts-budget-fail.mp3') }, (err) => {
      try {
        assert.ok(err && /edge\(piece \d+\/\d+: timed out/.test(err.message), String(err && err.message));
        assert.strictEqual(calls.filter((c) => c.args.includes('concat')).length, 0, 'no join after a failed piece');
        resolve();
      } catch (e) { reject(e); }
    });
  }));
});

Promise.all(pending).then(() => {
  if (failures) { console.error(`tts-long-form-budget: ${failures} failed`); process.exit(1); }
  console.log('tts-long-form-budget: all passed');
});
