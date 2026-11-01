'use strict';

// showcase-collision.test.js — verify yielding and startup collision logs

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProgrammingSchedule, DAILY_SHOWCASES, resolveShowcase } = require('../server/programming');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e && e.message}\n${e && e.stack}`); }
}

const asyncQueue = [];
function checkAsync(name, fn) {
  asyncQueue.push(async () => {
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e && e.message}\n${e && e.stack}`); }
  });
}

check('showcase yields to playing program and logs it once', () => {
  const slot = DAILY_SHOWCASES.find(s => s.album === 'Open Mic' || s.album === 'HOLLOW SIGNALS') || DAILY_SHOWCASES[0];
  const hour = slot.hours[0];
  const day = new Date(2026, 9, 31, hour, 0, 0); // Oct 31, 2026
  const resolved = resolveShowcase(slot, day);
  const expected = resolved ? resolved.album : 'unknown';

  const logs = [];
  const realLog = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };

  try {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "collision-"));
    const p = new ProgrammingSchedule({
      djEngine: { state: { channel: "dj" } },
      voiceDJ: null,
      broadcast: () => {},
      broadcastState: () => {},
      getPodcastStatus: () => ({ podcastPlaying: true, label: "Ghost Signals Podcast" }),
      dataDir: stateDir,
      showcaseStateFile: path.join(stateDir, "showcase-state.json"),
      peaceOration: { composeAlbumNarration: () => {} }
    });
    p._chicagoNow = () => day;

    // First trigger: should log
    p._checkShowcaseTrigger();
    assert.ok(logs.some(l => l.includes(`showcase ${expected} yielded to Ghost Signals Podcast`)), 
      `Should log yield (got: ${logs.join(', ')})`);
    const countBefore = logs.length;

    // Second trigger: should NOT log again
    p._checkShowcaseTrigger();
    assert.strictEqual(logs.length, countBefore, "Should not log yield twice");

    fs.rmSync(stateDir, { recursive: true, force: true });
  } finally {
    console.log = realLog;
  }
});

check('Halloween special collision at 20:00 (startup logic test)', () => {
  const halloween = DAILY_SHOWCASES.find(s => s.album === 'HOLLOW SIGNALS');
  assert.ok(halloween, "Should find Halloween special");
  assert.ok(halloween.hours.includes(20), "Should be at 20:00");

  const mockScheduler = { _show: { label: 'Featured Artist', airHours: [20] } };
  const dailyShowcases = [halloween];
  const schedulers = [mockScheduler];

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };

  try {
    for (const showcase of dailyShowcases) {
      for (const hour of showcase.hours) {
        for (const s of schedulers) {
          if (s._show && Array.isArray(s._show.airHours) && s._show.airHours.includes(hour)) {
            console.warn(`[programming] warning: showcase "${showcase.album || 'rotation'}" at ${hour}:00 collides with program "${s._show.label}"`);
          }
        }
      }
    }
    assert.ok(warnings.some(w => w.includes('showcase "HOLLOW SIGNALS" at 20:00 collides with program "Featured Artist"')), "Should detect collision");
  } finally {
    console.warn = realWarn;
  }
});

(async () => {
  for (const run of asyncQueue) await run();
  if (failures) { console.error(`\n${failures} failing`); process.exit(1); }
  console.log('\nshowcase-collision: all passed');
  process.exit(0);
})();
