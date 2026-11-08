'use strict';

// guest-consent.test.js — staged guest work must not air, be listed, be
// promoted, be served or be reachable by a request until its creator has
// said yes (server/guest-consent.js). Default closed: no consent file, an
// unreadable one, a string "true", an unresolved fact check or a missing
// sidecar all keep it off. The consent file is read at schedule time, so
// flipping it changes the next decision with no restart.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const gc = require('../server/guest-consent');
const { PodcastScheduler } = require('../server/podcast-scheduler');
const { unreachedFiles } = require('../server/deep-cuts');

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

const quiet = { log: () => {}, warn: () => {} };
const READING = { guest: 'writer-a', requires: ['listened:nick', 'credit:confirmed', 'fact:age', 'fact:count'], maxAirings: 1, hours: [0] };
const SHOWCASE = { guest: 'creator-b', requires: ['listened:nick', 'creator:confirmed'], explicit: true };
const ALL_READING = { guests: { 'writer-a': { consent: true, resolved: READING.requires.slice() } } };

// ── the pure rule ───────────────────────────────────────────────

check('no sidecar never airs', () => {
  const r = gc.clearance(null, ALL_READING, {});
  assert.strictEqual(r.ok, false);
  assert.match(r.reasons[0], /no guest sidecar/);
});

check('no consent file / no entry → held', () => {
  assert.strictEqual(gc.clearance(READING, { guests: {} }, {}).ok, false);
  assert.strictEqual(gc.clearance(READING, gc.readConsent('/nonexistent/guest-consent.json'), {}).ok, false);
});

check('consent must be the boolean true, not a truthy string', () => {
  const c = { guests: { 'writer-a': { consent: 'true', resolved: READING.requires } } };
  assert.strictEqual(gc.clearance(READING, c, {}).ok, false);
});

check('consent with an unresolved fact check is still held, and says which', () => {
  const c = { guests: { 'writer-a': { consent: true, resolved: ['listened:nick', 'credit:confirmed', 'fact:count'] } } };
  const r = gc.clearance(READING, c, {});
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.reasons, ['unresolved: fact:age']);
});

check('consent + everything resolved clears it', () => {
  assert.deepStrictEqual(gc.clearance(READING, ALL_READING, { chicagoHour: 0, airedCount: 0 }), { ok: true, reasons: [] });
});

check('one guest\'s consent does not clear another\'s work', () => {
  assert.strictEqual(gc.clearance(SHOWCASE, ALL_READING, {}).ok, false);
});

check('maxAirings: once means once; a resume of that airing is not a second one', () => {
  assert.strictEqual(gc.clearance(READING, ALL_READING, { airedCount: 1 }).ok, false);
  assert.strictEqual(gc.clearance(READING, ALL_READING, { airedCount: 1, ignoreAirings: true }).ok, true);
});

check('hours: the reading only starts in its own hour', () => {
  assert.strictEqual(gc.clearance(READING, ALL_READING, { chicagoHour: 12 }).ok, false);
  assert.strictEqual(gc.clearance(READING, ALL_READING, { chicagoHour: 0 }).ok, true);
});

check('explicit: night only (22:00–05:59)', () => {
  const c = { guests: { 'creator-b': { consent: true, resolved: SHOWCASE.requires } } };
  assert.strictEqual(gc.clearance(SHOWCASE, c, { chicagoHour: 20 }).ok, false);
  assert.strictEqual(gc.clearance(SHOWCASE, c, { chicagoHour: 21 }).ok, false);
  assert.strictEqual(gc.clearance(SHOWCASE, c, { chicagoHour: 23 }).ok, true);
  assert.strictEqual(gc.clearance(SHOWCASE, c, { chicagoHour: 3 }).ok, true);
  assert.strictEqual(gc.clearance(SHOWCASE, c, { chicagoHour: 6 }).ok, false);
});

check('guest paths: either separator, case-insensitive; others are not gated', () => {
  assert.ok(gc.isGuestPath('Guest Reading/x.mp3'));
  assert.ok(gc.isGuestPath('Guest Showcase\\x.mp3'));
  assert.ok(gc.isGuestPath('guest showcase/x.mp3'));
  assert.ok(!gc.isGuestPath('Featured Artist/x.mp3'));
  assert.ok(!gc.isGuestPath('Guest Reading.mp3'));
});

// ── a station on disk ───────────────────────────────────────────

function station(folder, files, sidecars, show) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-'));
  const musicDir = path.join(root, 'music');
  fs.mkdirSync(path.join(musicDir, folder), { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(musicDir, folder, f), 'x');
  for (const [stem, body] of Object.entries(sidecars || {})) {
    fs.writeFileSync(path.join(musicDir, folder, stem), typeof body === 'string' ? body : JSON.stringify(body));
  }
  const paths = gc.defaultPaths(root, {});
  fs.mkdirSync(path.dirname(paths.consentFile), { recursive: true });
  const gate = gc.createGate({ musicDir, folder, ...paths, log: quiet });
  const tts = [];
  const injected = [];
  const voiceDJ = { generateTTS: (text, cb) => { tts.push(text); cb(null, `/tmp/v${tts.length}.mp3`, text); } };
  const engine = { state: { channel: 'dj', playlist: [], playlistMeta: [], history: [], currentTrackIdx: 0, currentAlbum: 'Late Night' },
    loadAlbum(name) { this.state.currentAlbum = name; this.state.playlist = []; this.state.playlistMeta = []; } };
  const s = new PodcastScheduler({
    djEngine: engine, voiceDJ, broadcast: () => {}, broadcastState: () => {},
    getMusicDir: () => musicDir, gate,
    injectVoice: (p, meta) => injected.push([p, meta.label, meta.noBed === true]),
    onairFile: path.join(root, 'onair.json'),
    show: { airHours: [], newReleasePriority: false, label: folder, folder, ...show },
  });
  s._waitForPodcastEnd = () => {};
  const setConsent = (obj) => fs.writeFileSync(paths.consentFile, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return { root, musicDir, paths, s, engine, tts, injected, setConsent };
}

const READ_FILE = 'Writer A — The Village.mp3';
const readingStation = () => station('Guest Reading', [READ_FILE],
  { 'Writer A — The Village.guest.json': READING }, { label: 'Guest Reading', intro: null, trackPrefix: '[READING]' });

checkAsync('gated reading: not picked, not loaded, until the consent file says yes', async () => {
  const st = readingStation();
  st.s._chicagoNow = () => new Date(2026, 10, 9, 0, 4, 0);
  assert.strictEqual(st.s.pickTodayEpisode(), null, 'no consent file');
  st.setConsent('{ not json');
  assert.strictEqual(st.s.pickTodayEpisode(), null, 'unreadable consent file');
  st.setConsent({ guests: { 'writer-a': { consent: true, resolved: ['listened:nick', 'credit:confirmed'] } } });
  await st.s.airNow('test');
  assert.deepStrictEqual(st.engine.state.playlist, [], 'facts unresolved: nothing loads');
  assert.strictEqual(fs.existsSync(st.paths.ledgerFile), false, 'and nothing is counted');
  st.setConsent(ALL_READING);
  assert.ok(st.s.pickTodayEpisode(), 'flip takes effect on the next read, no restart');
});

checkAsync('cleared reading: no DJ intro, loads straight after the oration, counted once', async () => {
  const st = readingStation();
  st.setConsent(ALL_READING);
  st.s._chicagoNow = () => new Date(2026, 10, 9, 0, 4, 0);
  await st.s.airNow('after the midnight peace oration');
  assert.deepStrictEqual(st.tts, [], 'the reading carries its own credit; the DJ says nothing');
  assert.deepStrictEqual(st.injected, []);
  assert.deepStrictEqual(st.engine.state.playlist, [path.join('Guest Reading', READ_FILE)]);
  assert.strictEqual(st.engine.state.playlistMeta[0].title, '[READING] Writer A — The Village');
  const led = JSON.parse(fs.readFileSync(st.paths.ledgerFile, 'utf8'));
  assert.strictEqual(led[`Guest Reading/${READ_FILE}`].length, 1);
  // Once: the next oration finds nothing to read.
  st.s._onPodcastEnd();
  st.engine.state.playlist = [];
  st.s._chicagoNow = () => new Date(2026, 10, 10, 0, 4, 0);
  assert.strictEqual(st.s.pickTodayEpisode({ atHour: 0 }), null);
  await st.s.airNow('next night');
  assert.deepStrictEqual(st.engine.state.playlist, []);
});

checkAsync('cleared reading at the noon oration: held (hours [0])', async () => {
  const st = readingStation();
  st.setConsent(ALL_READING);
  st.s._chicagoNow = () => new Date(2026, 10, 9, 12, 3, 0);
  await st.s.airNow('after the noon peace oration');
  assert.deepStrictEqual(st.engine.state.playlist, []);
});

check('a restart does not resume a reading whose consent was withdrawn', () => {
  const st = readingStation();
  fs.writeFileSync(path.join(st.root, 'onair.json'), JSON.stringify({
    file: `Guest Reading/${READ_FILE}`, folder: 'Guest Reading', startedAtMs: Date.now() - 30 * 1000,
  }));
  st.s._probeDurationMs = () => 120 * 1000;
  assert.strictEqual(st.s._resumeIfInterrupted(), false);
  st.setConsent(ALL_READING);
  st.s._chicagoNow = () => new Date(2026, 10, 9, 0, 1, 0);
  assert.strictEqual(st.s._resumeIfInterrupted(), true, 'with consent it resumes as any show does');
});

const EP1 = 'Drama — 1 — Pilot.mp3';
const EP2 = 'Drama — 2 — Night.mp3';
const showcaseStation = () => station('Guest Showcase', [EP1, EP2], {
  'Drama — 1 — Pilot.guest.json': SHOWCASE,
  'Drama — 2 — Night.guest.json': SHOWCASE,
  'Drama — 1 — Pilot.intro.txt': 'INTRO CREDIT',
  'Drama — 2 — Night.before.txt': 'CONTENT NOTE',
  'Drama — 2 — Night.after.txt': 'CLOSING CREDIT',
}, { label: 'Guest Showcase', airHours: [23], playAll: true, trackPrefix: '[FEATURED]', promoLine: 'PROMO',
  intro: (stem) => (stem === 'Drama — 1 — Pilot' ? 'INTRO CREDIT' : 'generic') });

check('gated showcase: no promo, no pick at the promo minute', () => {
  const st = showcaseStation();
  st.s._voiceDJ._podcastPromo = undefined;
  st.s._chicagoNow = () => new Date(2026, 10, 9, 22, 30, 0);
  st.s._tick();
  assert.strictEqual(st.s._voiceDJ._podcastPromo, undefined);
  assert.strictEqual(st.s.pickTodayEpisode(), null);
});

checkAsync('cleared showcase at 23:00: intro, both episodes in order, the note before episode 2, the credit after', async () => {
  const st = showcaseStation();
  st.setConsent({ guests: { 'creator-b': { consent: true, resolved: SHOWCASE.requires } } });
  st.s._chicagoNow = () => new Date(2026, 10, 9, 23, 0, 0);
  st.s._tick();
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(st.engine.state.playlist, [path.join('Guest Showcase', EP1), path.join('Guest Showcase', EP2)]);
  assert.deepStrictEqual(st.injected, [['/tmp/v1.mp3', 'Guest Showcase intro', false]]);
  assert.ok(st.engine.state.playlistMeta.every((t) => /^\[FEATURED\] /.test(t.title)), 'guest marker → no AI tags');
  assert.strictEqual(st.s.onTrackStart(st.engine.state.playlistMeta[0]), true);
  assert.strictEqual(st.s.onTrackStart(st.engine.state.playlistMeta[1]), true);
  assert.deepStrictEqual(st.tts, ['INTRO CREDIT', 'CONTENT NOTE', 'CLOSING CREDIT']);
  assert.deepStrictEqual(st.injected.slice(1).map((x) => [x[1], x[2]]), [
    ['Guest Showcase: before Drama — 2 — Night', true],
    ['Guest Showcase: after Drama — 2 — Night', true],
  ], 'spoken sidecars never get a bed');
  assert.strictEqual(st.s.onTrackStart({ file: 'Some Album/song.mp3', isPodcastScheduled: false }), false);
  st.s._onPodcastEnd();
  assert.strictEqual(st.s.onTrackStart(st.engine.state.playlistMeta[0] || { file: path.join('Guest Showcase', EP1), isPodcastScheduled: true }), false,
    'nothing after the show ends');
});

checkAsync('only episode 2 cleared: its content note still airs before it, behind the intro, in order', async () => {
  const st = showcaseStation();
  fs.writeFileSync(path.join(st.musicDir, 'Guest Showcase', 'Drama — 1 — Pilot.guest.json'),
    JSON.stringify({ ...SHOWCASE, requires: [...SHOWCASE.requires, 'file:ep1-identity'] }));
  st.setConsent({ guests: { 'creator-b': { consent: true, resolved: SHOWCASE.requires } } });
  // TTS that finishes out of order must not reorder the queue.
  const pending = [];
  st.s._voiceDJ.generateTTS = (text, cb) => { st.tts.push(text); pending.push(() => cb(null, `/tmp/${text}.mp3`, text)); };
  st.s._chicagoNow = () => new Date(2026, 10, 9, 23, 1, 0);
  st.s._tick();
  // The note's render is slow: nothing may load, or be counted, before it is ready
  // (else the stream could advance into the episode ahead of its warning).
  assert.deepStrictEqual(st.engine.state.playlist, [], 'nothing loads while the lines render');
  assert.deepStrictEqual(st.injected, []);
  assert.strictEqual(fs.existsSync(st.paths.ledgerFile), false, 'nothing counted while rendering');
  while (pending.length) pending.pop()();
  assert.deepStrictEqual(st.engine.state.playlist, [path.join('Guest Showcase', EP2)]);
  assert.deepStrictEqual(st.injected.map((x) => x[1]), ['Guest Showcase intro', 'Guest Showcase: before Drama — 2 — Night'],
    'intro, then the note, both queued before the episode was loaded');
  assert.deepStrictEqual(st.tts, ['generic', 'CONTENT NOTE', 'CLOSING CREDIT'], 'every line rendered up front');
});

const failingTTS = (st, bad) => {
  st.s._voiceDJ.generateTTS = (text, cb) => { st.tts.push(text); if (bad.includes(text)) cb(new Error('tts down')); else cb(null, `/tmp/${text}.mp3`, text); };
};
const clearShowcase = (st) => st.setConsent({ guests: { 'creator-b': { consent: true, resolved: SHOWCASE.requires } } });

checkAsync('content note fails to render: that episode is held (fail closed), the other airs', async () => {
  const st = showcaseStation();
  clearShowcase(st);
  failingTTS(st, ['CONTENT NOTE']);
  st.s._chicagoNow = () => new Date(2026, 10, 9, 23, 0, 0);
  st.s._tick();
  assert.deepStrictEqual(st.engine.state.playlist, [path.join('Guest Showcase', EP1)], 'no warning → no Night');
  const led = JSON.parse(fs.readFileSync(st.paths.ledgerFile, 'utf8'));
  assert.deepStrictEqual(Object.keys(led), [`Guest Showcase/${EP1}`], 'only what loaded is counted');
});

checkAsync('only the warned episode cleared and its note fails: nothing airs, nothing counted', async () => {
  const st = showcaseStation();
  fs.writeFileSync(path.join(st.musicDir, 'Guest Showcase', 'Drama — 1 — Pilot.guest.json'),
    JSON.stringify({ ...SHOWCASE, requires: [...SHOWCASE.requires, 'file:ep1-identity'] }));
  clearShowcase(st);
  failingTTS(st, ['CONTENT NOTE']);
  st.s._chicagoNow = () => new Date(2026, 10, 9, 23, 0, 0);
  st.s._tick();
  assert.deepStrictEqual(st.engine.state.playlist, []);
  assert.deepStrictEqual(st.injected, [], 'not even the intro');
  assert.strictEqual(fs.existsSync(st.paths.ledgerFile), false);
  assert.strictEqual(st.s.getStatus().podcastPlaying, false, 'the slot is released');
});

checkAsync('the intro or a credit fails to render: the whole airing is held', async () => {
  for (const bad of ['INTRO CREDIT', 'CLOSING CREDIT']) {
    const st = showcaseStation();
    clearShowcase(st);
    failingTTS(st, [bad]);
    st.s._chicagoNow = () => new Date(2026, 10, 9, 23, 0, 0);
    st.s._tick();
    assert.deepStrictEqual(st.engine.state.playlist, [], bad);
    assert.deepStrictEqual(st.injected, [], bad);
    assert.strictEqual(fs.existsSync(st.paths.ledgerFile), false, bad);
    assert.strictEqual(st.s.getStatus().podcastPlaying, false, bad);
  }
});

checkAsync('renders that never finish: held after the timeout; a late render loads nothing', async () => {
  const st = showcaseStation();
  clearShowcase(st);
  st.s._prerenderTimeoutMs = 20;
  const pending = [];
  st.s._voiceDJ.generateTTS = (text, cb) => { pending.push(() => cb(null, `/tmp/${text}.mp3`, text)); };
  st.s._chicagoNow = () => new Date(2026, 10, 9, 23, 0, 0);
  st.s._tick();
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(st.s.getStatus().podcastPlaying, false);
  while (pending.length) pending.shift()();
  assert.deepStrictEqual(st.engine.state.playlist, []);
  assert.deepStrictEqual(st.injected, []);
});

checkAsync('consent withdrawn while the lines render: nothing loads', async () => {
  const st = showcaseStation();
  clearShowcase(st);
  const pending = [];
  st.s._voiceDJ.generateTTS = (text, cb) => { pending.push(() => cb(null, `/tmp/${text}.mp3`, text)); };
  st.s._chicagoNow = () => new Date(2026, 10, 9, 23, 0, 0);
  st.s._tick();
  st.setConsent({ guests: { 'creator-b': { consent: false, resolved: SHOWCASE.requires } } });
  while (pending.length) pending.shift()();
  assert.deepStrictEqual(st.engine.state.playlist, []);
  assert.deepStrictEqual(st.injected, []);
  assert.strictEqual(fs.existsSync(st.paths.ledgerFile), false);
});

checkAsync('spoken lines but no stream to place them in: held', async () => {
  const st = showcaseStation();
  clearShowcase(st);
  st.s._injectVoice = null;
  st.s._chicagoNow = () => new Date(2026, 10, 9, 23, 0, 0);
  st.s._tick();
  assert.deepStrictEqual(st.engine.state.playlist, []);
  assert.deepStrictEqual(st.tts, []);
});

checkAsync('one gap, two lines: the credit after an episode airs before the note for the next, however the renders finish', async () => {
  const st = showcaseStation();
  fs.writeFileSync(path.join(st.musicDir, 'Guest Showcase', 'Drama — 1 — Pilot.after.txt'), 'EP1 CREDIT');
  st.setConsent({ guests: { 'creator-b': { consent: true, resolved: SHOWCASE.requires } } });
  st.s._chicagoNow = () => new Date(2026, 10, 9, 23, 0, 0);
  st.s._tick();
  await new Promise((r) => setImmediate(r));
  // Everything was rendered before the airing; the seam queues it synchronously.
  st.s._voiceDJ.generateTTS = () => { throw new Error('no render at the seam'); };
  st.injected.length = 0;
  st.s.onTrackStart(st.engine.state.playlistMeta[0]);
  assert.deepStrictEqual(st.injected.map((x) => x[1]),
    ['Guest Showcase: after Drama — 1 — Pilot', 'Guest Showcase: before Drama — 2 — Night']);
  assert.deepStrictEqual(st.tts, ['INTRO CREDIT', 'EP1 CREDIT', 'CONTENT NOTE', 'CLOSING CREDIT']);
});

// ── the real DJ engine: nothing gets between a sealed show's episodes ──

check('DJ engine: no request, listener guest spot, wrap reshuffle or "next up" inside a sealed guest show', () => {
  const { DJEngine } = require('../server/dj-engine');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-dj-'));
  const e = new DJEngine({ musicDir: tmp });
  e._getMusicDir = () => tmp;
  e._playLedger.filePath = null;
  e.state.channel = 'dj';
  const changes = [];
  e._onTrackChange = (t) => changes.push(t);
  const st = showcaseStation();
  clearShowcase(st);
  // A real scheduler loads the episodes into the real engine.
  st.s._djEngine = e;
  st.s._chicagoNow = () => new Date(2026, 10, 9, 23, 0, 0);
  e.state.playlist = ['Some Album/song.mp3'];
  e.state.playlistMeta = [{ title: 'song', file: 'Some Album/song.mp3', album: 'Some Album' }];
  e.state.currentTrackIdx = 0;
  e.state.currentAlbum = 'Some Album';
  st.s._tick();
  const [ep1, ep2] = e.state.playlistMeta;
  assert.ok(ep1.guestSealed && ep2.guestSealed, 'guest episodes are sealed');
  // A listener request and a listener guest spot are both waiting.
  e.userQueue.push({ filename: 'Some Album/request.mp3', title: 'Request' });
  e._pendingGuest = { orderId: 'o1', staged: 'GSR/spot.mp3', title: 'Spot', album: 'GSR' };
  const before = e.state.playlistMeta.map((t) => t.file);

  // Episode 1 on: the stream's seam logic (index.js) asks what to announce.
  assert.strictEqual(e.isSealed(), true);
  assert.strictEqual(e.announceableNext(ep1), null, 'no "Next up" line between the episodes');
  assert.strictEqual(e.peekNextTrack().file, ep2.file, 'the peek is the next episode, untouched');
  assert.strictEqual(e.userQueue.length, 1, 'the request was not spliced in');
  const onEp2 = e.advanceTrack(ep1.file);
  assert.strictEqual(onEp2.file, ep2.file, 'episode 2 follows episode 1');
  assert.ok(!onEp2.guestSpot, 'not replaced by a listener guest spot');
  assert.strictEqual(e.userQueue.length, 1);

  // Episode 2 (the last) on: nothing to announce, no reshuffle of the show.
  assert.strictEqual(e.announceableNext(onEp2), null);
  assert.strictEqual(e.peekNextTrack(), null, 'end of the show: nothing peeked');
  assert.ok(!e.state._reshufflePending, 'the show was not reshuffled for a wrap');
  assert.deepStrictEqual(e.state.playlistMeta.map((t) => t.file), before);

  // It ends: the show's exhaustion hook gives the station back, and the
  // waiting request is free to go on after it.
  e.loadAlbum = (name) => {
    e.state.currentAlbum = name;
    e.state.playlist = ['Some Album/next.mp3', 'Some Album/after.mp3'];
    e.state.playlistMeta = [{ title: 'next', file: 'Some Album/next.mp3' }, { title: 'after', file: 'Some Album/after.mp3' }];
    e.state.currentTrackIdx = 0;
    return e.state.playlistMeta[0];
  };
  const back = e.advanceTrack(ep2.file);
  assert.strictEqual(st.s.getStatus().podcastPlaying, false);
  assert.ok(back && !back.guestSealed && /Some Album/.test(back.file), 'the station is back');
  assert.strictEqual(e.isSealed(), false);
  assert.strictEqual(e.announceableNext(back).file, 'Some Album/request.mp3', 'requests resume once the show is over');
  assert.strictEqual(st.injected.length >= 1, true);
});

check('index.js seam: intros go through announceableNext; no talk segment before a sealed episode', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(src, /const announce = djEngine\.announceableNext\(actual, upcoming\);/);
  assert.match(src, /if \(announce && !switchDue\) \{\s*voiceDJ\.generateIntro\(announce\);/);
  assert.match(src, /!actual\.guestSealed && voiceDJ\.shouldTalk\(actual\)/);
});

// ── fail closed on broken files ────────────────────────────────

check('a corrupt airings ledger holds capped and uncapped files alike, and is never overwritten', () => {
  const st = readingStation();
  st.setConsent(ALL_READING);
  fs.writeFileSync(st.paths.ledgerFile, '{ broken');
  const gate = gc.createGate({ musicDir: st.musicDir, folder: 'Guest Reading', ...st.paths, log: quiet });
  const r = gate.check(READ_FILE, { chicagoHour: 0 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reasons.includes('airings ledger unreadable'), r.reasons.join('; '));
  assert.strictEqual(gate.recordAiring(READ_FILE), false);
  assert.strictEqual(fs.readFileSync(st.paths.ledgerFile, 'utf8'), '{ broken');
  // A missing ledger is just an empty one.
  fs.unlinkSync(st.paths.ledgerFile);
  assert.strictEqual(gate.check(READ_FILE, { chicagoHour: 0 }).ok, true);
});

check('a malformed sidecar holds: "requires" not a list, "maxAirings" not a whole number', () => {
  const c = { guests: { 'writer-a': { consent: true, resolved: READING.requires } } };
  assert.strictEqual(gc.clearance({ ...READING, requires: 'listened:nick' }, c, {}).ok, false);
  assert.strictEqual(gc.clearance({ guest: 'writer-a' }, c, {}).ok, false, 'no requires at all');
  assert.strictEqual(gc.clearance({ ...READING, requires: [] }, c, {}).ok, true, 'an empty list is fine');
  assert.strictEqual(gc.clearance({ ...READING, maxAirings: '1' }, c, {}).ok, false);
});

checkAsync('cleared showcase forced in daylight (explicit) does not air', async () => {
  const st = showcaseStation();
  st.setConsent({ guests: { 'creator-b': { consent: true, resolved: SHOWCASE.requires } } });
  st.s._chicagoNow = () => new Date(2026, 10, 9, 15, 0, 0);
  await st.s.airNow('admin poke');
  assert.deepStrictEqual(st.engine.state.playlist, []);
});

check('one held episode does not hold the other; a file without a sidecar never airs', () => {
  const st = station('Guest Showcase', [EP1, EP2, 'stray.mp3'], {
    'Drama — 1 — Pilot.guest.json': { ...SHOWCASE, requires: [...SHOWCASE.requires, 'file:ep1-identity'] },
    'Drama — 2 — Night.guest.json': SHOWCASE,
  }, { label: 'Guest Showcase', airHours: [23], playAll: true });
  st.setConsent({ guests: { 'creator-b': { consent: true, resolved: SHOWCASE.requires } } });
  assert.deepStrictEqual(st.s._getEpisodes({ atHour: 23 }), [EP2]);
});

check('a "[[CREDIT]]" placeholder left in a spoken sidecar holds the file even with consent', () => {
  const st = showcaseStation();
  st.setConsent({ guests: { 'creator-b': { consent: true, resolved: SHOWCASE.requires } } });
  fs.writeFileSync(path.join(st.musicDir, 'Guest Showcase', 'Drama — 2 — Night.after.txt'), 'That was the drama, by [[CREDIT]].');
  assert.deepStrictEqual(st.s._getEpisodes({ atHour: 23 }), [EP1]);
  fs.writeFileSync(path.join(st.musicDir, 'Guest Showcase', 'Drama — 1 — Pilot.intro.2.txt'), 'by [[CREDIT]]');
  assert.deepStrictEqual(st.s._getEpisodes({ atHour: 23 }), []);
});

// ── the rest of the station cannot reach a guest folder ────────

check('library index (requests, votes, album lookups) skips guest folders', () => {
  const st = showcaseStation();
  fs.mkdirSync(path.join(st.musicDir, 'Some Album'));
  fs.writeFileSync(path.join(st.musicDir, 'Some Album', 'Night.mp3'), 'x');
  const utils = require('../server/utils');
  utils.invalidateCache();
  const files = utils.getFiles(st.musicDir);
  assert.ok(files.some((f) => f.startsWith('Some Album')));
  assert.ok(!files.some((f) => gc.isGuestPath(f)), files.join(', '));
  assert.strictEqual(utils.findAudioFile('Drama — 2 — Night', st.musicDir), null);
  utils.invalidateCache();
});

check('Deep Cuts never takes a guest file as filler', () => {
  const out = unreachedFiles([`Guest Reading/${READ_FILE}`, `Guest Showcase/${EP2}`, 'loose.mp3'], []);
  assert.deepStrictEqual(out, ['loose.mp3']);
});

check('/audio/ gate: held file not servable until consent; other folders untouched', () => {
  const st = readingStation();
  const rel = path.join('Guest Reading', READ_FILE);
  assert.strictEqual(gc.servable(st.musicDir, rel, st.paths.consentFile), false);
  assert.strictEqual(gc.servable(st.musicDir, 'Featured Artist/x.mp3', st.paths.consentFile), true);
  st.setConsent(ALL_READING);
  assert.strictEqual(gc.servable(st.musicDir, rel, st.paths.consentFile), true);
});

// ── wiring (source checks, the way the other slot tests pin index.js) ──

check('index.js: guest shows are gated, the reading has no DJ intro, the showcase is at 23:00', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const reading = src.slice(src.indexOf('const readingScheduler'), src.indexOf('readingScheduler.start()'));
  const showcase = src.slice(src.indexOf('const showcaseScheduler'), src.indexOf('showcaseScheduler.start()'));
  assert.match(reading, /gate: guestConsent\.createGate\(/);
  assert.match(reading, /intro: null/);
  assert.match(showcase, /gate: guestConsent\.createGate\(/);
  assert.match(showcase, /airHours: \[23\]/);
  assert.match(showcase, /playAll: true/);
  const after = src.slice(src.indexOf('afterOration:'), src.indexOf('afterOration:') + 700);
  assert.match(after, /readingScheduler\.pickTodayEpisode\(/, 'a cleared reading takes the slot after the oration');
  assert.match(src, /s\.onTrackStart\(track\)/, 'after-lines are fed by the stream');
});

check('routes.js: /audio/ consults the gate; the schedule lists guests only via the gated picker', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes.js'), 'utf8');
  const audio = src.slice(src.indexOf('// Audio file serving'), src.indexOf('// Audio file serving') + 2500);
  assert.match(audio, /guestServable\(/);
  assert.match(src, /deps\.showcaseScheduler \? deps\.showcaseScheduler\.pickTodayEpisode\(\)/);
});

check('post-now-playing never auto-posts a guest reading', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'post-now-playing.js'), 'utf8');
  assert.match(src, /\^\\\[READING\\\]/);
});

(async () => {
  for (const run of asyncQueue) await run();
  if (failures) { console.error(`\n${failures} failing`); process.exit(1); }
  console.log('\nguest-consent: all passed');
  process.exit(0);
})();
