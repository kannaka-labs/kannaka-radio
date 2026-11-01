'use strict';

// podcast-new-release-copy.test.js — new-release priority must survive a
// timestamp-preserving copy (#327).
//
// pickTodayEpisode() decided "new release" purely on file mtime. `cp -p`,
// `rsync -a`, `scp -p`, `tar -x`, backup restores and sync tools all land a
// brand-new GSP-041 wearing the source's OLD mtime, so the scheduler silently
// demoted a fresh release to the rotation — no error, no log line, and
// /api/schedule agreeing with the wrong answer.
//
// Acceptance test from the issue: copy a new episode in with `cp -p` from a
// file dated a week ago, and pickTodayEpisode() must still return
// reason: "new-release".

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PodcastScheduler } = require('../server/podcast-scheduler');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e && e.message}`); }
}

const DAY = 24 * 60 * 60 * 1000;
const FOLDER = 'Ghost Signals Podcast';

function makeFolder(files, ageMs) {
  const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsp-release-'));
  const dir = path.join(musicDir, FOLDER);
  fs.mkdirSync(dir);
  const old = new Date(Date.now() - ageMs);
  for (const f of files) {
    fs.writeFileSync(path.join(dir, f), 'x');
    fs.utimesSync(path.join(dir, f), old, old);
  }
  return { musicDir, dir };
}

function makeScheduler(musicDir) {
  const s = new PodcastScheduler({
    djEngine: { state: { channel: 'dj', playlist: [], playlistMeta: [], history: [] } },
    voiceDJ: {}, broadcast: () => {}, broadcastState: () => {},
    getMusicDir: () => musicDir,
  });
  s._chicagoNow = () => new Date(2026, 8, 23, 10, 0, 0);
  return s;
}

/** `cp -p` where available (the literal acceptance test), else copy + utimes. */
function copyPreservingTimes(src, dst) {
  if (process.platform !== 'win32') { execFileSync('cp', ['-p', src, dst]); return; }
  const st = fs.statSync(src);
  fs.copyFileSync(src, dst);
  fs.utimesSync(dst, st.atime, st.mtime);
}

console.log('podcast-new-release-copy.test.js');

const BACK_CATALOGUE = ['GSP-038-Old-One.mp3', 'GSP-039-Older.mp3', 'GSP-040-The-Last.mp3'];

// The "release" source: GSP-041 rendered a week ago on another machine.
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'gsp-staging-'));
const SRC = path.join(staging, 'GSP-041-Secret-Rule.mp3');
fs.writeFileSync(SRC, 'new episode');
const WEEK_AGO = new Date(Date.now() - 7 * DAY);
fs.utimesSync(SRC, WEEK_AGO, WEEK_AGO);

check('#327 a release copied in with `cp -p` (week-old mtime) still preempts as new-release', () => {
  const { musicDir, dir } = makeFolder(BACK_CATALOGUE, 30 * DAY);
  copyPreservingTimes(SRC, path.join(dir, 'GSP-041-Secret-Rule.mp3'));
  assert.ok(fs.statSync(path.join(dir, 'GSP-041-Secret-Rule.mp3')).mtimeMs < Date.now() - 6 * DAY,
    'fixture: the copy should carry the old mtime');
  const pick = makeScheduler(musicDir).pickTodayEpisode();
  assert.strictEqual(pick.reason, 'new-release', JSON.stringify(pick));
  assert.strictEqual(pick.file, 'GSP-041-Secret-Rule.mp3');
});

check('#327 the preemption still ends 48h after the release landed', () => {
  const { musicDir, dir } = makeFolder(BACK_CATALOGUE, 30 * DAY);
  copyPreservingTimes(SRC, path.join(dir, 'GSP-041-Secret-Rule.mp3'));
  const s = makeScheduler(musicDir);
  s._nowMs = () => Date.now() + 49 * 60 * 60 * 1000;
  assert.strictEqual(s.pickTodayEpisode().reason, 'rotation');
});

check('#327 touching an OLD episode (re-tag, re-encode) does not make it a new release', () => {
  const { musicDir, dir } = makeFolder([...BACK_CATALOGUE, 'GSP-041-Secret-Rule.mp3'], 30 * DAY);
  const s = makeScheduler(musicDir);
  s._nowMs = () => Date.now() + 3 * DAY; // everything landed well before "now"
  const now = new Date(s._nowMs());
  fs.utimesSync(path.join(dir, 'GSP-039-Older.mp3'), now, now);
  const pick = s.pickTodayEpisode();
  assert.notStrictEqual(pick.file === 'GSP-039-Older.mp3' && pick.reason === 'new-release', true, JSON.stringify(pick));
});

check('#327 a plain fresh drop (no preserved times) is still a new release', () => {
  const { musicDir, dir } = makeFolder(BACK_CATALOGUE, 30 * DAY);
  fs.writeFileSync(path.join(dir, 'GSP-041-Secret-Rule.mp3'), 'x');
  const pick = makeScheduler(musicDir).pickTodayEpisode();
  assert.strictEqual(pick.reason, 'new-release');
  assert.strictEqual(pick.file, 'GSP-041-Secret-Rule.mp3');
});

check('#327 the pick says what it saw (newest release, its times, the verdict)', () => {
  const { musicDir, dir } = makeFolder(BACK_CATALOGUE, 30 * DAY);
  copyPreservingTimes(SRC, path.join(dir, 'GSP-041-Secret-Rule.mp3'));
  const pick = makeScheduler(musicDir).pickTodayEpisode();
  assert.ok(pick.release, `no release diagnostics: ${JSON.stringify(pick)}`);
  assert.strictEqual(pick.release.file, 'GSP-041-Secret-Rule.mp3');
  assert.ok(typeof pick.release.mtime === 'string' && typeof pick.release.landed === 'string', JSON.stringify(pick.release));
  assert.strictEqual(pick.release.fresh, true);
});

check('an unnumbered folder keeps the mtime rule', () => {
  const { musicDir, dir } = makeFolder(['alpha.mp3', 'beta.mp3', 'gamma.mp3'], 30 * DAY);
  const s = makeScheduler(musicDir);
  s._nowMs = () => Date.now() + 3 * DAY;
  let pick = s.pickTodayEpisode();
  assert.strictEqual(pick.reason, 'rotation', JSON.stringify(pick));
  const now = new Date(s._nowMs());
  fs.utimesSync(path.join(dir, 'beta.mp3'), now, now);
  pick = s.pickTodayEpisode();
  assert.strictEqual(pick.reason, 'new-release');
  assert.strictEqual(pick.file, 'beta.mp3');
});

// ctime cannot be set, so "landed" ticks at write time; on a fast Linux runner the
// back catalogue and the newer file can land in the same millisecond, and a tie goes
// to the numbered episode. Give the newer file its own millisecond.
function landLater() { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30); }
// 2026-10-31: the Halloween special "TSOF-SP2-Hollow-Signals.mp3" was
// installed and touched at 22:01Z and the 9 PM slot still played E11 from the
// rotation. episodeNumber() gives a special no number, and the newest-release
// rule only ever compared NUMBERED episodes, so a special never preempted —
// SP1 on 10-25 had the same silent miss.
check('a special (no episode number) that lands after the top-numbered episode is the new release', () => {
  const { musicDir, dir } = makeFolder(['TSOF-E11-The-Finished-Instruments.mp3', 'TSOF-E12-Two-Hands-Both-Hers.mp3'], 14 * DAY);
  landLater();
  fs.writeFileSync(path.join(dir, 'TSOF-SP2-Hollow-Signals.mp3'), 'x');
  const pick = makeScheduler(musicDir).pickTodayEpisode();
  assert.strictEqual(pick.reason, 'new-release', JSON.stringify(pick));
  assert.strictEqual(pick.file, 'TSOF-SP2-Hollow-Signals.mp3');
});

check('a special older than the top-numbered episode does not outrank it', () => {
  const { musicDir, dir } = makeFolder(['TSOF-SP1-The-Trials-of-Kannaka.mp3', 'TSOF-E11-The-Finished-Instruments.mp3'], 14 * DAY);
  landLater();
  fs.writeFileSync(path.join(dir, 'TSOF-E12-Two-Hands-Both-Hers.mp3'), 'x');
  const pick = makeScheduler(musicDir).pickTodayEpisode();
  assert.strictEqual(pick.reason, 'new-release', JSON.stringify(pick));
  assert.strictEqual(pick.file, 'TSOF-E12-Two-Hands-Both-Hers.mp3');
});

try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) { /* ignore */ }
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall passed');
