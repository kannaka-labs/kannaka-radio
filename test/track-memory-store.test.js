/**
 * track-memory-store.test.js — the default modular server must store played
 * tracks into kannaka-memory (#289).
 *
 * The legacy server.js called memoryBridge.storeTrackMemory() on every
 * advance. The modular server (`npm start` -> server/index.js) never did, so
 * the radio -> HRM hearing stream silently stopped.
 *
 * Two layers:
 *   1. memory-bridge.storeHeardTrack(): drives a stub `kannaka` and asserts
 *      the argv it receives — real perception is stored as a HEAR memory;
 *      commercials and mock/unmeasured perception are not.
 *   2. server/index.js: source-level (the branches live inside a DJEngine
 *      callback that cannot run without booting the station — same approach
 *      as track-change-side-effects.test.js). Both track-change branches must
 *      route real perception through the hook that stores the memory.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}: ${e.message}`); failed++; }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'track-mem-'));
const LOG = path.join(dir, 'argv.ndjson');
const STUB = path.join(dir, 'kannaka-stub');
fs.writeFileSync(STUB, `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(LOG)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write('stored\\n');
`);
try { fs.chmodSync(STUB, 0o755); } catch { /* win32 */ }
const calls = () => { try { return fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
const reset = () => { try { fs.unlinkSync(LOG); } catch { /* none */ } };

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
function talkSegmentBranch() {
  const start = SRC.indexOf('voiceDJ.executeTalkSegment(actual');
  const end = SRC.indexOf('Normal track change flow', start);
  assert.ok(start > 0 && end > start, 'could not locate the talk-segment branch');
  return SRC.slice(start, end);
}
function normalBranch() {
  const start = SRC.indexOf('Normal track change flow');
  assert.ok(start > 0, 'could not locate the normal track-change branch');
  return SRC.slice(start, start + 4000);
}

const REAL = { source: 'kannaka-ear', tempo_bpm: 120, spectral_centroid: 2.5, rms_energy: 0.4, valence: 0.6 };
const MOCK = { source: 'mock', tempo_bpm: 99, spectral_centroid: 1, rms_energy: 0.1, valence: 0.5 };
const TRACK = { title: 'Wave Hall', album: 'Longship', file: 'Longship/01.mp3' };

(async () => {
  console.log('\ntrack-memory-store.test.js');
  const bridge = require('../memory-bridge');

  await test('memory-bridge exposes storeHeardTrack and a configurable binary', () => {
    assert.strictEqual(typeof bridge.storeHeardTrack, 'function', 'storeHeardTrack missing');
    assert.strictEqual(typeof bridge.configure, 'function', 'configure missing');
  });

  if (typeof bridge.configure === 'function') bridge.configure({ bin: STUB });
  const posix = process.platform !== 'win32';

  if (posix && typeof bridge.storeHeardTrack === 'function') {
    await test('#289 a measured track is stored as a HEAR memory via `kannaka remember`', async () => {
      reset();
      const r = await bridge.storeHeardTrack(TRACK, REAL);
      assert.ok(r && r.stored, `result=${JSON.stringify(r)}`);
      const c = calls();
      assert.strictEqual(c.length, 1, `calls=${JSON.stringify(c)}`);
      assert.strictEqual(c[0][0], 'remember');
      assert.ok(/^HEAR: Wave Hall from Longship \| tempo=120\.0/.test(c[0][1]), c[0][1]);
      assert.ok(c[0].includes('--importance'));
    });
    await test('#289 mock / unmeasured perception is never written to the HRM', async () => {
      reset();
      assert.strictEqual(await bridge.storeHeardTrack(TRACK, MOCK), null);
      assert.strictEqual(await bridge.storeHeardTrack(TRACK, null), null);
      assert.strictEqual(calls().length, 0, JSON.stringify(calls()));
    });
    await test('#289 commercials are not stored as heard music', async () => {
      reset();
      assert.strictEqual(await bridge.storeHeardTrack({ ...TRACK, commercial: true }, REAL), null);
      assert.strictEqual(calls().length, 0, JSON.stringify(calls()));
    });
  }

  await test('#289 server/index.js wires memory-bridge into the modular runtime', () => {
    assert.ok(/require\(["']\.\.\/memory-bridge["']\)/.test(SRC), 'server/index.js never requires ../memory-bridge');
    assert.ok(/storeHeardTrack\(/.test(SRC), 'server/index.js never calls storeHeardTrack');
    assert.ok(/configure\(\{\s*bin:\s*KANNAKA_BIN/.test(SRC), 'memory-bridge must use the server\'s KANNAKA_BIN');
  });
  await test('#289 the normal track-change path stores the heard track', () => {
    assert.ok(/hearTrack\(actual,\s*\(perc\)\s*=>\s*onTrackHeard\(actual,\s*perc\)\)/.test(normalBranch()),
      'normal branch must hand real perception to onTrackHeard');
  });
  await test('#289 the talk-segment path stores the heard track', () => {
    assert.ok(/hearTrack\(actual,\s*\(perc\)\s*=>\s*onTrackHeard\(actual,\s*perc\)\)/.test(talkSegmentBranch()),
      'talk-segment branch must hand real perception to onTrackHeard');
  });
  await test('#289 onTrackHeard both publishes the ear event and stores the memory', () => {
    const m = SRC.match(/function onTrackHeard\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(m, 'onTrackHeard not defined');
    assert.ok(/publishEarAttention\(/.test(m[1]), 'onTrackHeard must still publish KANNAKA.attention.ear (#124)');
    assert.ok(/storeHeardTrack\(/.test(m[1]), 'onTrackHeard must store the memory');
  });

  // 2026-09-30: a skipped store used to leave nothing in the journal. The O1
  // journal showed 162 track starts against 0 stores with no line saying why
  // (the modular server had no store hook before radio#341). skipReason()
  // names the deliberate refusals, and onTrackHeard logs one line per track
  // that is not stored.
  await test('skipReason names every deliberate refusal and is null for a storable track', () => {
    assert.strictEqual(bridge.skipReason(TRACK, REAL), null);
    assert.strictEqual(bridge.skipReason({ ...TRACK, commercial: true }, REAL), 'commercial');
    assert.strictEqual(bridge.skipReason(TRACK, MOCK), 'perception not measured (source mock)');
    assert.strictEqual(bridge.skipReason(TRACK, { tempo_bpm: 1 }), 'perception not measured (source unknown)');
    assert.strictEqual(bridge.skipReason(TRACK, null), 'no perception');
    assert.strictEqual(bridge.skipReason({ album: 'Longship' }, REAL), 'no title');
    assert.strictEqual(bridge.skipReason(null, REAL), 'no title');
  });
  await test('storeHeardTrack refuses exactly what skipReason names', async () => {
    reset();
    assert.strictEqual(await bridge.storeHeardTrack({ ...TRACK, commercial: true }, REAL), null);
    assert.strictEqual(await bridge.storeHeardTrack(TRACK, MOCK), null);
    assert.strictEqual(calls().length, 0, 'a refused track never reaches kannaka');
  });
  await test('onTrackHeard logs one "not stored" line with the reason', () => {
    const m = SRC.match(/function onTrackHeard\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(m, 'onTrackHeard not defined');
    assert.ok(/memoryBridge\.skipReason\(track,\s*perc\)/.test(m[1]), 'onTrackHeard must ask skipReason for the reason');
    assert.ok(/\[memory-bridge\] not stored:/.test(m[1]), 'onTrackHeard must log the not-stored line');
    assert.ok(/kannaka remember failed/.test(m[1]), 'a failed remember must be named as such');
  });
  await test('`kannaka remember` runs under its own 60 s budget, not the 10 s default', () => {
    const B = fs.readFileSync(path.join(__dirname, '..', 'memory-bridge.js'), 'utf8');
    assert.ok(/const REMEMBER_TIMEOUT = 60000/.test(B), 'REMEMBER_TIMEOUT missing');
    const remembers = B.match(/"remember",[\s\S]*?\],\s*REMEMBER_TIMEOUT\)/g) || [];
    assert.strictEqual(remembers.length, 2, `both remember calls must pass REMEMBER_TIMEOUT (found ${remembers.length})`);
  });

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  Track memory store: ${passed} passed, ${failed} failed`);
  console.log(`${'─'.repeat(50)}`);
  process.exit(failed === 0 ? 0 : 1);
})();
