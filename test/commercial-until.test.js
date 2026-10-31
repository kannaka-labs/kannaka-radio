'use strict';

// commercial-until.test.js — a seasonal commercial stops airing by itself.
//
// The Hollow Signals Halloween spot (2026-10-31) is the first commercial with
// an `until` date. Before this field a one-night spot stayed in rotation until
// someone remembered to delete it, which with this station's history of
// "remove after <date>" comments means weeks. interleaveCommercials now drops
// any entry whose `until` (a Chicago calendar date, inclusive) is in the past,
// at playlist-build time, so the morning after the special the next build has
// no Halloween ad in it and nobody has to touch the file.

const assert = require('assert');
const { interleaveCommercials, chicagoDateKey, COMMERCIAL_SCRIPTS } = require('../server/commercials');

let failed = 0;
function run(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; } }

console.log('commercial-until.test.js');

const tracks = Array.from({ length: 7 }, (_, i) => ({ title: `t${i}`, album: 'A', file: `${i}.mp3` }));
const evergreen = { title: 'Evergreen', text: 'always', file: '/x/evergreen.mp3', theme: 'house' };
const seasonal = { title: 'Seasonal', text: 'once', file: '/x/seasonal.mp3', theme: 'house', until: '2026-10-31' };
const ads = (out) => out.filter((t) => t.isCommercial || /commercial/i.test(String(t.title)) || t.file === evergreen.file || t.file === seasonal.file);
const titles = (out) => ads(out).map((t) => t.file);

run('chicagoDateKey is YYYY-MM-DD in America/Chicago', () => {
  // 2026-11-01T04:30Z is still Oct 31, 23:30 CDT in Chicago.
  assert.strictEqual(chicagoDateKey(new Date('2026-11-01T04:30:00Z')), '2026-10-31');
  // 2026-11-01T05:30Z is Nov 1, 00:30 CDT (DST ends 2026-11-01 at 02:00 CDT).
  assert.strictEqual(chicagoDateKey(new Date('2026-11-01T05:30:00Z')), '2026-11-01');
  assert.match(chicagoDateKey(), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(chicagoDateKey(new Date('garbage')), /^\d{4}-\d{2}-\d{2}$/, 'an invalid Date falls back to now');
});

run('on the until date itself the seasonal spot still airs', () => {
  const out = interleaveCommercials(tracks, [seasonal], 3, 'dj', { now: new Date('2026-10-31T23:00:00-05:00') });
  assert.ok(titles(out).includes(seasonal.file), 'seasonal spot present on its last day');
});

run('the day after, only the evergreen spot airs', () => {
  const out = interleaveCommercials(tracks, [seasonal, evergreen], 3, 'dj', { now: new Date('2026-11-01T00:05:00-05:00') });
  const files = titles(out);
  assert.ok(files.length > 0, 'ads still interleaved');
  assert.ok(!files.includes(seasonal.file), 'seasonal spot gone');
  assert.ok(files.every((f) => f === evergreen.file), 'every ad slot is the evergreen spot');
});

run('an all-expired pool yields the bare track list', () => {
  const out = interleaveCommercials(tracks, [seasonal], 3, 'dj', { now: new Date('2026-12-01T12:00:00Z') });
  assert.deepStrictEqual(out.map((t) => t.file), tracks.map((t) => t.file));
});

run('entries without until are unaffected (default clock)', () => {
  const out = interleaveCommercials(tracks, [evergreen], 3, 'dj');
  assert.ok(titles(out).includes(evergreen.file));
});

run('the input array is not mutated by the filter', () => {
  const pool = [seasonal, evergreen];
  interleaveCommercials(tracks, pool, 3, 'dj', { now: new Date('2026-12-01T12:00:00Z') });
  assert.strictEqual(pool.length, 2);
});

run('every `until` in COMMERCIAL_SCRIPTS is a well-formed date', () => {
  for (const c of COMMERCIAL_SCRIPTS) {
    if (c.until === undefined) continue;
    assert.match(String(c.until), /^\d{4}-\d{2}-\d{2}$/, `${c.title}: until=${c.until}`);
    assert.ok(!isNaN(new Date(`${c.until}T12:00:00Z`)), `${c.title}: until parses`);
  }
});

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('all passed');
