'use strict';
/**
 * album-aware-lookup.test.js — a title can belong to two albums.
 *
 * "Resonance" is track 6 of Neurogenesis and track 2 of A Field Guide to
 * Kannaka. findAudioFile matched on title alone, so on 2026-10-03 the library
 * listed the new album as 1/7 with its "Resonance" pointing at
 * Neurogenesis/06 - Resonance.mp3, and the DJ would have played the wrong
 * song under the new album's name. When the caller knows the album, the
 * album's own folder is searched first.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findAudioFile, invalidateCache } = require('../server/utils');
const { referencedFiles } = require('../server/deep-cuts');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
  invalidateCache?.();
}

/** A music dir with {folder: [basenames]}; '' means the top level. */
function library(layout) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'album-'));
  for (const [folder, names] of Object.entries(layout)) {
    const d = folder ? path.join(dir, folder) : dir;
    fs.mkdirSync(d, { recursive: true });
    for (const n of names) fs.writeFileSync(path.join(d, n + '.mp3'), 'x');
  }
  invalidateCache?.();
  return dir;
}

const FG = 'A Field Guide to Kannaka';
// '0 Neurogenesis' sorts first where readdir is sorted (NTFS), so there the
// title-only search picks the wrong album. Linux readdir order is arbitrary,
// so the album assertion below never depends on order.
const OTHER = '0 Neurogenesis';
const LAYOUT = { [OTHER]: ['06 - Resonance'], [FG]: ['02 - Resonance', '01 - Three in the Morning'] };

console.log('album-aware-lookup');

test('without an album the old title-only search still finds a file', () => {
  const dir = library(LAYOUT);
  assert.ok(findAudioFile('Resonance', dir));
});

test("with the album, its own folder's file wins over another album's", () => {
  const dir = library(LAYOUT);
  const titleOnly = findAudioFile('Resonance', dir);
  if (!titleOnly.startsWith(OTHER)) console.log(`       (readdir listed the album first here; title-only got ${titleOnly})`);
  const found = findAudioFile('Resonance', dir, FG);
  assert.strictEqual(found, path.join(FG, '02 - Resonance.mp3'));
});

test('folder match is case-insensitive', () => {
  const dir = library(LAYOUT);
  assert.strictEqual(findAudioFile('Resonance', dir, FG.toUpperCase()), path.join(FG, '02 - Resonance.mp3'));
});

test('an album with no folder of its own falls back to the library-wide search', () => {
  const dir = library({ '': ['Monad'], 'Some Other Album': ['Spectral Drift'] });
  assert.strictEqual(findAudioFile('Spectral Drift', dir, 'Loose Singles'), path.join('Some Other Album', 'Spectral Drift.mp3'));
  assert.strictEqual(findAudioFile('Monad', dir, 'Loose Singles'), 'Monad.mp3');
});

test("a title missing from its album's folder still falls back", () => {
  const dir = library({ [FG]: ['01 - Three in the Morning'], 'Elsewhere': ['Receipts'] });
  assert.strictEqual(findAudioFile('Receipts', dir, FG), path.join('Elsewhere', 'Receipts.mp3'));
});

test('deep-cuts counts the album file as referenced, not the namesake', () => {
  const dir = library(LAYOUT);
  const refs = referencedFiles({ [FG]: { tracks: ['Resonance'] } }, dir, findAudioFile);
  assert.deepStrictEqual([...refs], [path.join(FG, '02 - Resonance.mp3')]);
});

console.log(failures ? `\nalbum-aware-lookup: ${failures} failed` : '\nalbum-aware-lookup: all passed');
process.exit(failures ? 1 : 0);
