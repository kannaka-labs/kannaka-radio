'use strict';
/**
 * title-filename-separators.test.js — a title may contain characters a
 * filename cannot.
 *
 * "Ascension at φ／2" is catalogued on Resonance Patterns; the file on disk is
 * "Ascension at φ_2.mp3", because a real solidus cannot go in a filename and
 * whoever saved it substituted an underscore. Nothing bridged the two: the
 * exact and substring passes fail outright, and the fuzzy pass scores 2 of 3
 * words — 66% against a 70% threshold. It missed by a hair, the album read
 * 10/11 in the library, and that track never played.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findAudioFile, sepNormalise, invalidateCache } = require('../server/utils');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

/** A music dir holding exactly the given basenames. */
function musicDirWith(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sep-'));
  for (const n of names) fs.writeFileSync(path.join(dir, n + '.mp3'), 'x');
  invalidateCache?.();
  return dir;
}

const PHI = 'φ';
const FULLWIDTH_SOLIDUS = '／';

console.log('title-filename-separators');

test('the real case: a fullwidth solidus in the title, an underscore on disk', () => {
  const dir = musicDirWith([`Ascension at ${PHI}_2`, 'Spectral Drift', 'Monad']);
  const found = findAudioFile(`Ascension at ${PHI}${FULLWIDTH_SOLIDUS}2`, dir);
  assert.ok(found, 'the track exists on disk and must be found');
  assert.ok(found.includes(`Ascension at ${PHI}_2`), `resolved to the wrong file: ${found}`);
  invalidateCache?.();
});

test('it picks the matching character variant, not a lookalike', () => {
  // Three files really do sit beside each other in the library.
  const dir = musicDirWith([
    `Ascension at ${PHI}_2`,
    'Ascension at phi_2',
    'Ascension at phi_2 (new)',
  ]);
  const found = findAudioFile(`Ascension at ${PHI}${FULLWIDTH_SOLIDUS}2`, dir);
  assert.ok(found.includes(`${PHI}_2`), `should prefer the phi-symbol file, got ${found}`);
  assert.ok(!found.includes('phi_2'), 'the spelled-out variant is a different filename');
  invalidateCache?.();
});

test('a slash or a colon in a title still finds its file', () => {
  const dir = musicDirWith(['Him_Her', 'Quiet_Loud']);
  assert.ok(findAudioFile('Him/Her', dir), 'a solidus title');
  assert.ok(findAudioFile('Quiet:Loud', dir), 'a colon title');
  invalidateCache?.();
});

test('an ordinary exact title is unaffected', () => {
  const dir = musicDirWith(['Spectral Drift', 'Monad']);
  const found = findAudioFile('Spectral Drift', dir);
  assert.ok(found.includes('Spectral Drift'));
  invalidateCache?.();
});

test('a leading track number is still stripped', () => {
  const dir = musicDirWith(['03 - Small Rooms']);
  assert.ok(findAudioFile('Small Rooms', dir));
  invalidateCache?.();
});

test('a title with no file still returns null', () => {
  const dir = musicDirWith(['Spectral Drift']);
  assert.strictEqual(findAudioFile('A Song That Does Not Exist Here', dir), null,
    'normalising must not invent a match');
  invalidateCache?.();
});

test('two genuinely different tracks are not merged', () => {
  const dir = musicDirWith(['Monad', 'Connect To The Monad']);
  const found = findAudioFile('Monad', dir);
  assert.strictEqual(path.basename(found), 'Monad.mp3', `exact title must win, got ${found}`);
  invalidateCache?.();
});

test('normalisation collapses the separator family and nothing else', () => {
  assert.strictEqual(sepNormalise('a/b'), 'a b');
  assert.strictEqual(sepNormalise('a_b'), 'a b');
  assert.strictEqual(sepNormalise('a:b'), 'a b');
  assert.strictEqual(sepNormalise(`a${FULLWIDTH_SOLIDUS}b`), 'a b');
  assert.strictEqual(sepNormalise('a__b'), 'a b', 'runs collapse');
  assert.strictEqual(sepNormalise('  a  b  '), 'a b', 'and so does whitespace');
  assert.strictEqual(sepNormalise('Ghost Signal - One Light'), 'Ghost Signal - One Light',
    'a hyphen is left alone: it is punctuation in a title, not a path substitution');
});

if (failures) { console.error(`title-filename-separators: ${failures} failed`); process.exit(1); }
console.log('title-filename-separators: all passed');
