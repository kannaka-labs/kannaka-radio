'use strict';
/**
 * narration-tts-bounded.test.js — a showcase's narration renders a few at a time.
 *
 * 2026-10-15 16:00Z on O1 (one vCPU): the "WHAT I KEEP" showcase composed nine
 * narration pieces and started all nine renders at once. Every piper render
 * and every edge-dsp fallback ran out its time budget together, all nine
 * pieces failed (27 TTS failures in the journal), and the showcase aired with
 * no narration. Renders now go through runBounded: NARRATION_TTS_CONCURRENCY
 * at a time (default 1), each with its own budget, failures retried once.
 */

const assert = require('node:assert');
const { runBounded, narrationConcurrency } = require('../server/lib/bounded-tts');
const { PeaceOration } = require('../server/peace-oration');

let failures = 0;
const pending = [];
function test(name, fn) {
  pending.push(Promise.resolve().then(fn).then(
    () => console.log(`  ok   ${name}`),
    (e) => { failures++; console.error(`  FAIL ${name}\n       ${e && e.stack || e}`); },
  ));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a batch of nine never runs more than N renders at once', async () => {
  for (const N of [1, 2, 3]) {
    let active = 0, peak = 0;
    const res = await runBounded([...Array(9).keys()], async (x) => {
      active += 1; peak = Math.max(peak, active);
      await sleep(5);
      active -= 1;
      return `p${x}`;
    }, { concurrency: N });
    assert.strictEqual(peak, N, `concurrency ${N} reached ${peak}`);
    assert.deepStrictEqual(res, [...Array(9).keys()].map((x) => `p${x}`));
  }
});

test('the default is one at a time, and the env can raise it', () => {
  assert.strictEqual(narrationConcurrency({}), 1);
  assert.strictEqual(narrationConcurrency({ NARRATION_TTS_CONCURRENCY: '3' }), 3);
  assert.strictEqual(narrationConcurrency({ NARRATION_TTS_CONCURRENCY: '0' }), 1);
  assert.strictEqual(narrationConcurrency({ NARRATION_TTS_CONCURRENCY: 'x' }), 1);
});

test('time spent waiting in the queue is not charged to a render', async () => {
  // Each render has its own 40 ms budget, measured from when IT starts. Nine
  // 15 ms renders one at a time take ~135 ms in all, three times any budget,
  // and every one still succeeds. Starting all nine together would not
  // change their budgets either; the point is that queueing never eats one.
  const BUDGET = 40;
  const res = await runBounded([...Array(9).keys()], async (x) => {
    const t0 = Date.now();
    await sleep(15);
    return Date.now() - t0 <= BUDGET ? `ok${x}` : null;
  }, { concurrency: 1 });
  assert.strictEqual(res.filter(Boolean).length, 9);
});

test('one failing piece does not fail the batch, and is retried once after the rest', async () => {
  const order = [];
  let tries = 0;
  const settled = [];
  const res = await runBounded(['a', 'b', 'c'], async (x) => {
    order.push(x);
    if (x === 'b') { tries += 1; return tries >= 2 ? 'B' : null; }
    return x.toUpperCase();
  }, { concurrency: 1, onSettled: (i, r, attempt) => settled.push([i, r, attempt]) });
  assert.deepStrictEqual(res, ['A', 'B', 'C']);
  assert.deepStrictEqual(order, ['a', 'b', 'c', 'b'], 'the retry runs after every first attempt');
  assert.deepStrictEqual(settled.find((s) => s[0] === 1), [1, 'B', 2]);
});

test('a piece that fails twice is null; the others still land', async () => {
  const res = await runBounded([1, 2, 3], async (x) => {
    if (x === 2) throw new Error('engine down');
    return x * 10;
  }, { concurrency: 1 });
  assert.deepStrictEqual(res, [10, null, 30]);
});

test('composeAlbumNarration pre-renders its pieces one at a time and hands back a waitable piece', async () => {
  let active = 0, peak = 0, calls = 0;
  const voiceDJ = {
    generateTTS(text, cb) {
      calls += 1; active += 1; peak = Math.max(peak, active);
      setTimeout(() => { active -= 1; cb(null, `/tmp/${text}.mp3`); }, 5);
    },
  };
  delete process.env.NARRATION_TTS_CONCURRENCY;
  const po = new PeaceOration({ voiceDJ, dataDir: require('os').tmpdir() });
  const tracks = Array.from({ length: 8 }, (_, i) => `t${i}`);
  po._askAnthropicDirect = async () => JSON.stringify(Array.from({ length: 9 }, (_, i) => `piece${i}`));
  const r = await po.composeAlbumNarration('Album', 'theme', tracks, []);
  assert.ok(r.ok, 'composed');
  // The first piece is popped before its render can have finished: the
  // caller gets a promise to wait on, not a reason to start a second render.
  const first = po.popNextNarration('Album');
  assert.strictEqual(first.audioPath, null);
  assert.ok(first.ready && typeof first.ready.then === 'function', 'piece 0 is waitable');
  assert.strictEqual(await first.ready, '/tmp/piece0.mp3');
  await sleep(120);
  assert.strictEqual(peak, 1, `narration renders ran ${peak} at once`);
  assert.strictEqual(calls, 9, 'each piece rendered exactly once');
  const second = po.popNextNarration('Album');
  assert.strictEqual(second.audioPath, '/tmp/piece1.mp3', 'a finished piece comes back ready');
  assert.strictEqual(second.ready, null);
});

Promise.all(pending).then(() => {
  if (failures) { console.error(`\nnarration-tts-bounded: ${failures} failing`); process.exit(1); }
  console.log('\nnarration-tts-bounded: all passed');
});
