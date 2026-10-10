/**
 * talk-segment-once.test.js — executeTalkSegment releases its lock and calls
 * onDone exactly ONCE.
 *
 * The 180 s safety timer released the segment and called onDone; a TTS
 * callback that arrived after it (slow engine) called onDone a second time,
 * cleared `_inTalkSegment` out from under whatever held the lock next, and —
 * on success — aired the late segment and armed another release. Every
 * release now goes through a once-only finish(), as executeOration's release()
 * already did.
 *
 * Timers are faked so the 180 s safety fires on demand.
 */

'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const VoiceDJ = require('../server/voice-dj').VoiceDJ || require('../server/voice-dj');

let failures = 0;
process.exitCode = 1;
async function check(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e && e.message}`); }
}

// ── fake timers ──
const realSet = global.setTimeout;
const realClear = global.clearTimeout;
let timers = [];
function installFakeTimers() {
  timers = [];
  global.setTimeout = (fn, ms) => { const t = { fn, ms, cleared: false, unref() { return t; } }; timers.push(t); return t; };
  global.clearTimeout = (t) => { if (t && typeof t === 'object' && 'cleared' in t) t.cleared = true; else realClear(t); };
}
function restoreTimers() { global.setTimeout = realSet; global.clearTimeout = realClear; }
function fire(ms) {
  const t = timers.find((x) => x.ms === ms && !x.cleared && !x.fired);
  if (!t) return false;
  t.fired = true;
  t.fn();
  return true;
}
const tick = () => new Promise((r) => setImmediate(r));

function makeDJ(opts = {}) {
  const dj = Object.create(VoiceDJ.prototype);
  const broadcasts = [];
  const tts = [];
  Object.assign(dj, {
    _enabled: true, _isLive: () => false, _inTalkSegment: false, _speaking: false,
    _tracksSinceLastTalk: 0, _randomTalkThreshold: () => 3, _updateMood: () => {},
    _currentMood: 'calm', _getHistory: () => [],
    _broadcast: (m) => broadcasts.push(m),
    _kannakabin: path.join(os.tmpdir(), 'no-such-kannaka-binary'),
    _generateTalkText: opts.generateTalkText || (async () => 'a few words for the talk segment'),
    _generateTTS: (text, cb) => tts.push(cb),
  });
  return { dj, broadcasts, tts };
}

(async () => {
  console.log('\ntalk-segment-once.test.js');

  await check('a TTS error arriving after the safety release does not call onDone again', async () => {
    installFakeTimers();
    try {
      const { dj, tts } = makeDJ();
      let done = 0;
      await dj.executeTalkSegment({ title: 'Next' }, () => done++);
      await tick();
      assert.strictEqual(tts.length, 1, 'TTS must have been requested');
      assert.ok(fire(180000), 'the 180 s safety timer must be armed');
      assert.strictEqual(done, 1, 'the safety release calls onDone');
      // The station moves on: the next holder takes the lock.
      dj._inTalkSegment = true;
      tts[0](new Error('engine finally gave up'));
      assert.strictEqual(done, 1, `onDone must run once, ran ${done}x`);
      assert.strictEqual(dj._inTalkSegment, true, 'a late callback must not clear a lock the next holder took');
    } finally { restoreTimers(); }
  });

  await check('a TTS success arriving after the safety release is not aired and does not release again', async () => {
    installFakeTimers();
    try {
      const { dj, tts, broadcasts } = makeDJ();
      let done = 0;
      await dj.executeTalkSegment({ title: 'Next' }, () => done++);
      await tick();
      fire(180000);
      assert.strictEqual(done, 1);
      tts[0](null, path.join(os.tmpdir(), 'late-talk.mp3'), 'a few words for the talk segment');
      // Fire anything the late callback armed (the end-of-talk timer).
      for (const t of timers.slice()) if (!t.cleared && !t.fired) { t.fired = true; t.fn(); }
      assert.strictEqual(done, 1, `onDone must run once, ran ${done}x`);
      assert.ok(!broadcasts.some((m) => m.type === 'dj_talk_segment'), 'a late segment must not be aired');
    } finally { restoreTimers(); }
  });

  await check('a normal segment releases once and clears the safety timer', async () => {
    installFakeTimers();
    try {
      const { dj, tts, broadcasts } = makeDJ();
      let done = 0;
      await dj.executeTalkSegment({ title: 'Next' }, () => done++);
      await tick();
      tts[0](null, path.join(os.tmpdir(), 'talk.mp3'), 'a few words for the talk segment');
      assert.ok(broadcasts.some((m) => m.type === 'dj_talk_segment'), 'the segment is aired');
      const end = timers.find((t) => t.ms !== 180000 && !t.cleared && !t.fired);
      assert.ok(end, 'an end-of-talk timer is armed');
      end.fired = true; end.fn();
      assert.strictEqual(done, 1);
      assert.strictEqual(dj._inTalkSegment, false);
      const safety = timers.find((t) => t.ms === 180000);
      assert.ok(safety.cleared, 'the safety timer must be cleared on a normal release');
      if (!safety.cleared) { safety.fn(); }
      assert.strictEqual(done, 1);
    } finally { restoreTimers(); }
  });

  await check('text that finishes composing after the safety release is not sent to TTS', async () => {
    installFakeTimers();
    try {
      let resolveText;
      const { dj, tts } = makeDJ({ generateTalkText: () => new Promise((r) => { resolveText = r; }) });
      let done = 0;
      const p = dj.executeTalkSegment({ title: 'Next' }, () => done++);
      await tick();
      fire(180000);
      assert.strictEqual(done, 1);
      resolveText('slow words');
      await p;
      await tick();
      assert.strictEqual(tts.length, 0, 'nothing may be synthesized for a released segment');
      assert.strictEqual(done, 1);
    } finally { restoreTimers(); }
  });

  if (failures) { console.error(`\ntalk-segment-once: ${failures} failing`); process.exitCode = 1; return; }
  console.log('\ntalk-segment-once: all passed');
  process.exitCode = 0;
})();
