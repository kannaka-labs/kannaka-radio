'use strict';
/**
 * album-fallback.test.js — an album with no files must not take the station
 * off the air.
 *
 * djEngine.loadAlbum returns null when an album yields zero playable tracks,
 * and its own comment says the caller "can try a different album". Every
 * caller in programming.js ignored the return value. On 2026-09-12 the
 * rotation picked an album whose files had been left behind by the
 * music-directory migration, the load aborted, and the station sat with an
 * empty playlist and now-playing: null until somebody noticed. Nothing
 * retried, nothing alerted, and it could not recover on its own.
 */

const assert = require('node:assert');
const { ProgrammingSchedule } = require('../server/programming');
const { ALBUMS } = require('../server/dj-engine');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

/** A DJ engine where only the named albums have any files. */
function fakeEngine(playable) {
  const attempts = [];
  return {
    attempts,
    loadAlbum(name) {
      attempts.push(name);
      return playable.includes(name) ? { title: `a track from ${name}`, album: name } : null;
    },
  };
}

function programming(engine) {
  const p = Object.create(ProgrammingSchedule.prototype);
  p._djEngine = engine;
  p._lastAlbumPlayed = null;
  return p;
}

const CATALOGUE = Object.keys(ALBUMS);
const A = CATALOGUE[0];
const B = CATALOGUE[1];
const C = CATALOGUE[2];

console.log('album-fallback');

test('a playable album loads and nothing else is tried', () => {
  const e = fakeEngine([A]);
  const p = programming(e);
  const track = p.loadAlbumOrNext(A, { albums: [A, B] });
  assert.ok(track, 'it should load');
  assert.strictEqual(track.album, A);
  assert.deepStrictEqual(e.attempts, [A], 'no needless extra loads');
});

test('an album with no files is skipped for the next one in the block', () => {
  const e = fakeEngine([B]);
  const p = programming(e);
  const track = p.loadAlbumOrNext(A, { albums: [A, B, C] });
  assert.ok(track, 'the station must still get music');
  assert.strictEqual(track.album, B, 'it should fall through to the next album');
  assert.deepStrictEqual(e.attempts, [A, B]);
});

test('several broken albums in a row are all skipped', () => {
  const e = fakeEngine([C]);
  const p = programming(e);
  const track = p.loadAlbumOrNext(A, { albums: [A, B, C] });
  assert.strictEqual(track.album, C);
});

test('a broken album with an empty block still finds the catalogue', () => {
  const playable = CATALOGUE[CATALOGUE.length - 1];
  const e = fakeEngine([playable]);
  const p = programming(e);
  const track = p.loadAlbumOrNext(A, { albums: [] });
  assert.ok(track, 'an empty block must not mean silence');
  assert.strictEqual(track.album, playable);
});

test('an album is never tried twice in one pass', () => {
  const e = fakeEngine([B]);
  const p = programming(e);
  p.loadAlbumOrNext(A, { albums: [A, A, B, B] });
  const counts = {};
  for (const a of e.attempts) counts[a] = (counts[a] || 0) + 1;
  for (const [name, n] of Object.entries(counts)) {
    assert.strictEqual(n, 1, `${name} was tried ${n} times`);
  }
});

test('an engine that throws is treated as unplayable, not fatal', () => {
  const e = {
    attempts: [],
    loadAlbum(name) {
      e.attempts.push(name);
      if (name === A) throw new Error('corrupt album row');
      return { title: 't', album: name };
    },
  };
  const p = programming(e);
  const track = p.loadAlbumOrNext(A, { albums: [A, B] });
  assert.ok(track, 'a throw must not stop the station');
  assert.strictEqual(track.album, B);
});

test('when nothing at all is playable it returns null rather than pretending', () => {
  const e = fakeEngine([]);
  const p = programming(e);
  const track = p.loadAlbumOrNext(A, { albums: [A, B] });
  assert.strictEqual(track, null);
  assert.ok(e.attempts.length >= CATALOGUE.length,
    'it should have exhausted the catalogue before giving up');
});

test('the album that actually loaded is the one recorded as last played', () => {
  const e = fakeEngine([B]);
  const p = programming(e);
  p.loadAlbumOrNext(A, { albums: [A, B] });
  assert.strictEqual(p._lastAlbumPlayed, B,
    'recording the broken album would make the no-repeat rule skip the working one');
});

if (failures) { console.error(`album-fallback: ${failures} failed`); process.exit(1); }
console.log('album-fallback: all passed');
