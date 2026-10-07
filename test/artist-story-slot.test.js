'use strict';

// artist-story-slot.test.js — the Artist Story segment: a PodcastScheduler
// show with no clock hours that the peace oration starts (airNow) the moment
// the oration's audio is queued on /stream, so story and song follow it
// directly. Two songs alternate midnight/noon; the story text beside a song
// rotates through its variants.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PodcastScheduler, sidecarIntro } = require('../server/podcast-scheduler');
const { PeaceOration } = require('../server/peace-oration');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e && e.message}`); }
}
const asyncQueue = [];
function checkAsync(name, fn) {
  asyncQueue.push(async () => {
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e && e.message}`); }
  });
}

const STORY = { label: 'Artist Story', folder: 'Artist Story', airHours: [], slotsPerDay: 2, newReleasePriority: false, trackPrefix: '[STORY]' };

function makeScheduler(show, files) {
  const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-'));
  fs.mkdirSync(path.join(musicDir, show.folder));
  for (const f of files) fs.writeFileSync(path.join(musicDir, show.folder, f), 'x');
  const voiceDJ = { generateTTS: (text, cb) => cb(null, '/tmp/story-intro.mp3', text) };
  const engine = { state: { channel: 'dj', playlist: [], playlistMeta: [], history: [], currentTrackIdx: 0 } };
  const injected = [];
  const s = new PodcastScheduler({
    djEngine: engine, voiceDJ, broadcast: () => {}, broadcastState: () => {},
    getMusicDir: () => musicDir, show,
    injectVoice: (p, meta) => injected.push([p, meta.label]),
  });
  s._waitForPodcastEnd = () => {};
  return { s, voiceDJ, engine, injected, musicDir };
}

const SONGS = ['Kheillah - Open The Curtain.mp3', 'Kheillah - The Name You Gave Me.mp3'];

check('slotsPerDay 2: midnight and noon take different songs, the same pairing every day', () => {
  const { s } = makeScheduler(STORY, SONGS);
  const pick = (d) => { s._chicagoNow = () => d; return s.pickTodayEpisode().file; };
  const midnight = pick(new Date(2026, 9, 8, 0, 3, 0));
  const noon = pick(new Date(2026, 9, 8, 12, 3, 0));
  assert.notStrictEqual(midnight, noon, 'the two airings of a day must differ');
  // Two files, two slots: the sequence d*2+s keeps one song at midnight and
  // the other at noon, so a listener learns which is which.
  assert.strictEqual(pick(new Date(2026, 9, 9, 0, 3, 0)), midnight);
  assert.strictEqual(pick(new Date(2026, 9, 9, 12, 3, 0)), noon);
  // The grace minutes of the slot see the same pick as :00.
  assert.strictEqual(pick(new Date(2026, 9, 9, 12, 4, 0)), noon);
});

check('slotsPerDay 2 with three files steps through all of them, airing by airing', () => {
  const { s } = makeScheduler(STORY, SONGS.concat(['Kheillah - A Third Song.mp3']));
  const pick = (d) => { s._chicagoNow = () => d; return s.pickTodayEpisode().index; };
  const seq = [];
  for (const day of [8, 9, 10]) for (const h of [0, 12]) seq.push(pick(new Date(2026, 9, day, h, 2, 0)));
  // six consecutive airings over three files: each index twice, never twice in a row
  assert.deepStrictEqual([...seq].sort(), [0, 0, 1, 1, 2, 2]);
  for (let i = 1; i < seq.length; i++) assert.notStrictEqual(seq[i], seq[i - 1], `airing ${i} repeats airing ${i - 1}`);
});

check('the slot sequence counts calendar days, so the first hour after midnight is not yesterday', () => {
  // scheduler-helpers' dayOfYear() divides a local span by 86,400,000 ms; in a
  // DST zone that puts 00:02 on the previous day for half the year. The slot
  // pick must not inherit that: 00:02 and 23:58 of one day are 2 slots apart,
  // never 3 or 1.
  const { s } = makeScheduler(STORY, SONGS.concat(['Kheillah - A Third Song.mp3']));
  for (const month of [1, 4, 7, 10]) {
    const a = s._episodeIndexFor(new Date(2026, month, 15, 0, 2, 0), 1000);
    const b = s._episodeIndexFor(new Date(2026, month, 15, 23, 58, 0), 1000);
    assert.strictEqual(b - a, 1, `month ${month}: ${a} → ${b}`);
    const next = s._episodeIndexFor(new Date(2026, month, 16, 0, 2, 0), 1000);
    assert.strictEqual(next - a, 2, `month ${month}: next midnight ${a} → ${next}`);
  }
});

check('newReleasePriority false: files that just landed still alternate (the podcast rule would replay the newest)', () => {
  // Both files were written seconds ago, so under the default rule the
  // newest-mtime one is a "fresh release" and takes every airing for 48 h.
  const { s } = makeScheduler(STORY, SONGS);
  s._chicagoNow = () => new Date(2026, 9, 8, 0, 3, 0);
  assert.strictEqual(s.pickTodayEpisode().reason, 'rotation');
  const asPodcast = makeScheduler(Object.assign({}, STORY, { newReleasePriority: undefined }), SONGS);
  asPodcast.s._chicagoNow = () => new Date(2026, 9, 8, 0, 3, 0);
  assert.strictEqual(asPodcast.s.pickTodayEpisode().reason, 'new-release', 'the default keeps the podcast behaviour');
});

check('slotsPerDay unset keeps the one-pick-a-day rule (podcast second-chance replay)', () => {
  const show = Object.assign({}, STORY, { slotsPerDay: undefined, airHours: [10, 22] });
  const { s } = makeScheduler(show, SONGS);
  const pick = (d) => { s._chicagoNow = () => d; return s.pickTodayEpisode().file; };
  assert.strictEqual(pick(new Date(2026, 9, 8, 10, 0, 0)), pick(new Date(2026, 9, 8, 22, 0, 0)));
});

check('no clock hours: the minute tick never starts it, at :00 or in the grace window', () => {
  const { s, engine } = makeScheduler(STORY, SONGS);
  let starts = 0;
  s._startScheduledPodcast = async () => { starts++; };
  for (const [h, m] of [[0, 0], [0, 2], [12, 0], [12, 4], [20, 0]]) {
    s._chicagoNow = () => new Date(2026, 9, 8, h, m, 0);
    s._tick();
  }
  assert.strictEqual(starts, 0);
  assert.strictEqual(engine.state.playlist.length, 0);
});

checkAsync('airNow queues the story on /stream and loads the song in the same tick', async () => {
  const { s, engine, injected } = makeScheduler(STORY, SONGS);
  s._chicagoNow = () => new Date(2026, 9, 8, 0, 1, 0);
  await s.airNow('after the 2026-10-08T00 peace oration');
  assert.deepStrictEqual(injected, [['/tmp/story-intro.mp3', 'Artist Story intro']]);
  assert.strictEqual(engine.state.playlistMeta.length, 1);
  assert.ok(engine.state.playlistMeta[0].title.startsWith('[STORY] Kheillah - '));
  assert.strictEqual(engine.state.playlistMeta[0].isPodcastScheduled, true);
});

checkAsync('airNow marks the hour, so a clock tick with hours could not start it twice', async () => {
  const show = Object.assign({}, STORY, { airHours: [0] });
  const { s } = makeScheduler(show, SONGS);
  s._chicagoNow = () => new Date(2026, 9, 8, 0, 1, 0);
  let starts = 0;
  const real = s._startScheduledPodcast.bind(s);
  s._startScheduledPodcast = async () => { starts++; await real(); };
  await s.airNow('oration');
  s._podcastPlaying = false; // the song ended
  s._chicagoNow = () => new Date(2026, 9, 8, 0, 3, 0);
  s._tick();
  assert.strictEqual(starts, 1);
});

checkAsync('airNow while the story is already airing is ignored', async () => {
  const { s, injected } = makeScheduler(STORY, SONGS);
  await s.airNow('first');
  await s.airNow('second');
  assert.strictEqual(injected.length, 1);
});

check('sidecarIntro: plain file, numbered variants rotate and wrap, none → null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-'));
  const stem = 'Kheillah - Open The Curtain';
  assert.strictEqual(sidecarIntro(dir, stem, 0), null);
  fs.writeFileSync(path.join(dir, `${stem}.intro.txt`), 'only one\n');
  assert.strictEqual(sidecarIntro(dir, stem, 0), 'only one');
  assert.strictEqual(sidecarIntro(dir, stem, 7), 'only one');
  fs.writeFileSync(path.join(dir, `${stem}.intro.1.txt`), 'variant one');
  fs.writeFileSync(path.join(dir, `${stem}.intro.2.txt`), 'variant two');
  // sorted: .intro.1, .intro.2, .intro.txt
  assert.strictEqual(sidecarIntro(dir, stem, 0), 'variant one');
  assert.strictEqual(sidecarIntro(dir, stem, 1), 'variant two');
  assert.strictEqual(sidecarIntro(dir, stem, 2), 'only one');
  assert.strictEqual(sidecarIntro(dir, stem, 3), 'variant one');
  // another song's sidecar is not this song's
  fs.writeFileSync(path.join(dir, 'Kheillah - The Name You Gave Me.intro.txt'), 'other song');
  assert.strictEqual(sidecarIntro(dir, stem, 2), 'only one');
  // an empty file is no intro
  fs.writeFileSync(path.join(dir, 'Empty.intro.txt'), '   \n');
  assert.strictEqual(sidecarIntro(dir, 'Empty', 0), null);
});

// ── the hand-over from the oration ──────────────────────────────────────
function makeOration(voiceDJ, afterOration) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oration-story-'));
  return new PeaceOration({ kannakabin: 'kannaka', voiceDJ, broadcast: () => {}, dataDir, afterOration });
}

check('a scheduled oration hands its slot key to afterOration when its audio is queued', () => {
  const seen = [];
  let order = [];
  const voiceDJ = {
    executeOration: (text, onDone, opts) => {
      assert.strictEqual(opts.persona, 'oration');
      order.push('inject'); opts.onInjected();
      order.push('done'); onDone();
      return true;
    },
  };
  const po = makeOration(voiceDJ, (k) => { seen.push(k); order.push('after'); });
  assert.strictEqual(po._say('the speech', '2026-10-08T00'), true);
  assert.deepStrictEqual(seen, ['2026-10-08T00']);
  assert.deepStrictEqual(order, ['inject', 'after', 'done'], 'the story is asked for before the oration has finished');
});

check('a manual delivery (no slot) does not start the story', () => {
  const seen = [];
  const voiceDJ = { executeOration: (text, onDone, opts) => { opts.onInjected(); onDone(); return true; } };
  const po = makeOration(voiceDJ, (k) => seen.push(k));
  po._say('manual');
  assert.deepStrictEqual(seen, []);
});

check('a failing afterOration hook cannot break the oration', () => {
  let done = 0;
  const voiceDJ = { executeOration: (text, onDone, opts) => { opts.onInjected(); onDone(); done++; return true; } };
  const po = makeOration(voiceDJ, () => { throw new Error('story broke'); });
  assert.strictEqual(po._say('the speech', '2026-10-08T12'), true);
  assert.strictEqual(done, 1);
});

check('without afterOration the oration still passes a harmless hook', () => {
  const voiceDJ = { executeOration: (text, onDone, opts) => { opts.onInjected(); onDone(); return true; } };
  const po = makeOration(voiceDJ, undefined);
  assert.strictEqual(po._say('the speech', '2026-10-08T12'), true);
});

// ── voice-dj calls onInjected once the oration is in the /stream queue ──
checkAsync('voice-dj: onInjected fires after injectAudio and before the lock is released', async () => {
  const VoiceDJ = require('../server/voice-dj').VoiceDJ || require('../server/voice-dj');
  const dj = Object.create(VoiceDJ.prototype);
  const order = [];
  Object.assign(dj, {
    _enabled: true, _isLive: () => false, _inTalkSegment: false, _speaking: false,
    _broadcast: () => {}, _kannakabin: path.join(os.tmpdir(), 'no-such-kannaka-binary'),
    _rememberMonologue: () => {},
    _generateTTS: (text, cb) => cb(null, path.join(os.tmpdir(), 'oration.mp3'), text),
    _getIcecastSource: () => ({ injectAudio: (p, meta, cb) => { order.push('inject'); setTimeout(() => cb(null), 5); } }),
  });
  await new Promise((resolve) => {
    dj.executeOration('a speech of several words for the stream', () => { order.push('done'); resolve(); },
      { persona: 'oration', onInjected: () => order.push('hook') });
  });
  assert.deepStrictEqual(order, ['inject', 'hook', 'done']);
  assert.strictEqual(dj._inTalkSegment, false);
});

checkAsync('voice-dj: no icecast source → no onInjected (there is nothing to follow)', async () => {
  const VoiceDJ = require('../server/voice-dj').VoiceDJ || require('../server/voice-dj');
  const dj = Object.create(VoiceDJ.prototype);
  let hooked = 0;
  Object.assign(dj, {
    _enabled: true, _isLive: () => false, _inTalkSegment: false, _speaking: false,
    _broadcast: () => {}, _kannakabin: path.join(os.tmpdir(), 'no-such-kannaka-binary'),
    _rememberMonologue: () => {},
    _generateTTS: (text, cb) => cb(null, path.join(os.tmpdir(), 'oration.mp3'), text),
    _getIcecastSource: () => null,
  });
  const accepted = dj.executeOration('two words', () => {}, { onInjected: () => hooked++ });
  assert.strictEqual(accepted, true);
  assert.strictEqual(hooked, 0);
  if (dj._talkSegmentTimer) clearTimeout(dj._talkSegmentTimer);
  dj._inTalkSegment = false;
});

(async () => {
  for (const run of asyncQueue) await run();
  if (failures) { console.error(`\n${failures} failing`); process.exit(1); }
  console.log('\nartist-story-slot: all passed');
  process.exit(0);
})();
