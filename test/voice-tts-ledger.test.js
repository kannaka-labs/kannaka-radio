'use strict';

// voice-tts-ledger.test.js — a voice outage is a number the monitor can read.
//
// The 2026-10-12 → 10-14 TTS outage ran two days unnoticed: the radio unit was
// active, the icecast stream was up, and no surface said "the last N attempts
// to speak all failed". Every utterance goes through VoiceDJ._generateTTS, so
// it now keeps a ledger that GET /api/dj-voice/status reports as `tts`, and
// Gatus pages on `tts.consecutiveFailures`.

const assert = require('assert');
const os = require('os');
const path = require('path');
const voiceEngine = require('../server/voice-engine');
const { VoiceDJ } = require('../server/voice-dj');

let failed = 0;
function run(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; } }

console.log('voice-tts-ledger.test.js');

function makeDJ() {
  const dj = Object.create(VoiceDJ.prototype);
  Object.assign(dj, {
    _enabled: true, _speaking: false, _lastIntro: null, _inTalkSegment: false,
    _tracksSinceLastTalk: 0, _currentMood: 'calm',
    _voiceDir: os.tmpdir(),
    _tts: { ok: 0, failed: 0, consecutiveFailures: 0, lastOkAt: null, lastFailAt: null, lastEngine: null, lastError: null },
  });
  return dj;
}

const realSynth = voiceEngine.synthesize;
function withSynth(impl, fn) {
  voiceEngine.synthesize = impl;
  try { fn(); } finally { voiceEngine.synthesize = realSynth; }
}
const okSynth = (engine) => (job, cb) => cb(null, path.join(os.tmpdir(), 'x.mp3'), engine);
const failSynth = (msg) => (job, cb) => cb(new Error(msg));

run('fresh ledger is healthy with zero counts', () => {
  const s = makeDJ().getStatus().tts;
  assert.deepStrictEqual([s.ok, s.failed, s.consecutiveFailures, s.healthy], [0, 0, 0, true]);
  assert.strictEqual(s.lastError, null);
});

run('three failures in a row flip healthy to false; lastError names the persona', () => {
  const dj = makeDJ();
  withSynth(failSynth('piper exploded'), () => {
    for (let i = 0; i < 3; i++) dj._generateTTS('hi', () => {}, { persona: 'news' });
  });
  const s = dj.getStatus().tts;
  assert.strictEqual(s.failed, 3);
  assert.strictEqual(s.consecutiveFailures, 3);
  assert.strictEqual(s.healthy, false);
  assert.ok(s.lastFailAt && !s.lastOkAt);
  assert.strictEqual(s.lastError, 'news: piper exploded');
});

run('two failures are not yet an outage', () => {
  const dj = makeDJ();
  withSynth(failSynth('blip'), () => { dj._generateTTS('a', () => {}); dj._generateTTS('b', () => {}); });
  assert.strictEqual(dj.getStatus().tts.healthy, true);
});

run('one success resets the streak and clears lastError, counts keep history', () => {
  const dj = makeDJ();
  withSynth(failSynth('x'), () => { for (let i = 0; i < 4; i++) dj._generateTTS('a', () => {}); });
  withSynth(okSynth('piper'), () => dj._generateTTS('a', () => {}));
  const s = dj.getStatus().tts;
  assert.deepStrictEqual([s.ok, s.failed, s.consecutiveFailures, s.healthy], [1, 4, 0, true]);
  assert.strictEqual(s.lastEngine, 'piper');
  assert.strictEqual(s.lastError, null);
  assert.ok(s.lastOkAt && s.lastFailAt);
});

run('a null path with no error is still a failure', () => {
  const dj = makeDJ();
  withSynth((job, cb) => cb(null, null), () => dj._generateTTS('a', () => {}));
  const s = dj.getStatus().tts;
  assert.strictEqual(s.failed, 1);
  assert.strictEqual(s.lastError, 'dj: TTS generation failed');
});

run('a long execFile message keeps its tail (where stderr lives)', () => {
  const dj = makeDJ();
  const msg = 'Command failed: edge-tts ' + 'x'.repeat(2000) + '\nTHE REAL REASON';
  withSynth(failSynth(msg), () => dj._generateTTS('a', () => {}));
  const e = dj.getStatus().tts.lastError;
  assert.ok(e.endsWith('THE REAL REASON'), e.slice(-40));
  assert.ok(e.length < 320, `kept short: ${e.length}`);
});

run('the callback contract is unchanged', () => {
  const dj = makeDJ();
  let got;
  withSynth(okSynth('edge'), () => dj._generateTTS('words', (err, p, text) => { got = [err, p, text]; }));
  assert.strictEqual(got[0], null);
  assert.ok(got[1].endsWith('x.mp3'));
  assert.strictEqual(got[2], 'words');
  withSynth(failSynth('no'), () => dj._generateTTS('words', (err) => { got = err; }));
  assert.ok(got instanceof Error && got.message === 'no');
});

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('all passed');
