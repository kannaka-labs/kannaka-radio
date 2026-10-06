'use strict';

// show-resume.test.js — a restart must not drop a scheduled show.
//
// Before: the "show on air" state lived only in the scheduler's memory, so
// any restart mid-show brought the station back up on a song and the show
// never came back; a restart at :01–:04 lost the show for the day because
// the trigger fired only at minute :00.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PodcastScheduler } = require('../server/podcast-scheduler');
const onair = require('../server/lib/onair-state');
const { resumeByteOffset } = require('../server/icecast-source');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e && e.message}`); }
}

const FOLDER = 'Featured Artist';
const FILE = 'Solace Road - Escape to Dream.mp3';
const MIN = 60 * 1000;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'));
  fs.mkdirSync(path.join(dir, FOLDER));
  fs.writeFileSync(path.join(dir, FOLDER, FILE), 'x');
  const onairFile = path.join(dir, 'onair.json');
  const engine = { state: { channel: 'dj', playlist: [], playlistMeta: [], history: [], currentTrackIdx: 0, currentAlbum: 'Ghost Signals' } };
  const s = new PodcastScheduler({
    djEngine: engine, voiceDJ: {}, broadcast: () => {}, broadcastState: () => {},
    getMusicDir: () => dir, onairFile, probeDurationMs: () => 31 * MIN,
    show: { label: 'Featured Artist', folder: FOLDER, airHours: [20] },
  });
  s._waitForPodcastEnd = () => {};
  const started = [];
  s._startScheduledPodcast = () => { started.push(s._chicagoNow().getMinutes()); };
  return { dir, onairFile, engine, s, started };
}

check('byte offset: proportional after the ID3 tag; nonsense plays from the top', () => {
  assert.strictEqual(resumeByteOffset(1100, 100, 15 * MIN, 30 * MIN), 600);
  assert.strictEqual(resumeByteOffset(1100, 100, 0, 30 * MIN), 100);
  assert.strictEqual(resumeByteOffset(1100, 100, 31 * MIN, 30 * MIN), 100);
  assert.strictEqual(resumeByteOffset(1100, 100, 5 * MIN, 0), 100);
});

check('resume plan: right folder inside the show only', () => {
  const now = Date.now();
  const st = { file: `${FOLDER}/${FILE}`, folder: FOLDER, startedAtMs: now - 10 * MIN };
  assert.deepStrictEqual(onair.resumePlan(st, FOLDER, now, 31 * MIN), { file: st.file, offsetMs: 10 * MIN });
  assert.strictEqual(onair.resumePlan(st, 'The Story of Flaukowski', now, 31 * MIN), null);
  assert.strictEqual(onair.resumePlan(st, FOLDER, now, 10 * MIN + 10000), null, 'inside the end margin');
  assert.strictEqual(onair.resumePlan({ ...st, startedAtMs: now - 5 * 60 * MIN }, FOLDER, now, 400 * MIN), null, 'too old');
});

check('record back-dates a resumed start; clear only clears its own show', () => {
  const { onairFile } = setup();
  const now = 1_000_000_000;
  onair.record({ isPodcastScheduled: true, file: `${FOLDER}/${FILE}`, album: FOLDER, resumeAtMs: 7 * MIN }, now, onairFile);
  assert.strictEqual(onair.read(onairFile).startedAtMs, now - 7 * MIN);
  onair.clear('Ghost Signals Podcast/GSP-001.mp3', onairFile);
  assert.ok(onair.read(onairFile), 'another show finishing must not clear it');
  onair.clear(`${FOLDER}/${FILE}`, onairFile);
  assert.strictEqual(onair.read(onairFile), null);
  onair.record({ file: 'Some Album/song.mp3', album: 'Some Album' }, now, onairFile);
  assert.strictEqual(onair.read(onairFile), null, 'songs are never recorded');
});

check('a restart mid-show resumes it at the listener position', () => {
  const { onairFile, engine, s, started } = setup();
  fs.writeFileSync(onairFile, JSON.stringify({ file: `${FOLDER}/${FILE}`, folder: FOLDER, startedAtMs: Date.now() - 12 * MIN }));
  s._chicagoNow = () => new Date(2026, 9, 6, 20, 12, 0);
  assert.strictEqual(s._resumeIfInterrupted(), true);
  const t = engine.state.playlistMeta[0];
  assert.strictEqual(t.file, path.join(FOLDER, FILE));
  assert.ok(Math.abs(t.resumeAtMs - 12 * MIN) < 2000, `resumeAtMs ${t.resumeAtMs}`);
  assert.strictEqual(s.getStatus().podcastPlaying, true);
  s._tick();
  assert.deepStrictEqual(started, [], 'the tick must not start it again');
});

check('a finished or foreign record does not resume', () => {
  const { onairFile, s } = setup();
  fs.writeFileSync(onairFile, JSON.stringify({ file: `${FOLDER}/${FILE}`, folder: FOLDER, startedAtMs: Date.now() - 40 * MIN }));
  assert.strictEqual(s._resumeIfInterrupted(), false);
  fs.writeFileSync(onairFile, JSON.stringify({ file: 'The Story of Flaukowski/TSOF-E11.mp3', folder: 'The Story of Flaukowski', startedAtMs: Date.now() - MIN }));
  assert.strictEqual(s._resumeIfInterrupted(), false);
});

check('a restart at :03 still starts the show, once', () => {
  const { s, started } = setup();
  s._chicagoNow = () => new Date(2026, 9, 6, 20, 3, 0);
  s._tick();
  s._chicagoNow = () => new Date(2026, 9, 6, 20, 4, 0);
  s._tick();
  assert.deepStrictEqual(started, [3]);
});

check(':00 still triggers, and the grace minutes do not re-trigger it', () => {
  const { s, started } = setup();
  for (const m of [0, 1, 2, 3, 4]) {
    s._chicagoNow = () => new Date(2026, 9, 6, 20, m, 0);
    s._tick();
  }
  assert.deepStrictEqual(started, [0]);
});

check('past the grace window a missed show stays missed', () => {
  const { s, started } = setup();
  s._chicagoNow = () => new Date(2026, 9, 6, 20, 5, 0);
  s._tick();
  assert.deepStrictEqual(started, []);
});

if (failures) { console.error(`\n${failures} failing`); process.exit(1); }
console.log('\nshow-resume: all passed');
