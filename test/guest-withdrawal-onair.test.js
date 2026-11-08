'use strict';

// guest-withdrawal-onair.test.js — when a guest withdraws (#443), what is
// queued or on /stream right now goes too: their intro, content note and
// closing credit leave the voice queue, their episode is cut (not by killing
// ffmpeg: no 15 s reconnect, no queued voice swallowed as "aired"), the cut
// episode is advanced with aired:false and never reaches the on-air digest,
// and the next thing on air is the next episode that is not theirs, or the
// album the show interrupted. Driven through the real IcecastSource loop and
// a real PodcastScheduler over a small fake engine.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Writable } = require('stream');
const gc = require('../server/guest-consent');
const gw = require('../server/guest-withdrawal');
const { PodcastScheduler } = require('../server/podcast-scheduler');
const { IcecastSource } = require('../server/icecast-source');

let failures = 0;
const queue = [];
function check(name, fn) {
  queue.push(async () => {
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e}`); }
  });
}
const quiet = { log: () => {}, warn: () => {} };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await tick(5); }
  throw new Error('timed out waiting');
}

/** Just enough of DJEngine: mid-stream swap, wrap → exhaustion hook, loadAlbum. */
class FakeEngine {
  constructor() {
    this.state = { channel: 'dj', playlist: ['Late Night/song.mp3'], playlistMeta: [{ file: 'Late Night/song.mp3', title: 'song' }],
      history: [], currentTrackIdx: 0, currentAlbum: 'Late Night' };
    this.advances = [];
    this._onPlaylistExhausted = null;
    this.onAdvance = null;
  }
  getCurrentTrack() { return this.state.playlistMeta[this.state.currentTrackIdx] || null; }
  peekNextTrack() { return this.state.playlistMeta[this.state.currentTrackIdx + 1] || null; }
  loadAlbum(name) {
    this.state.currentAlbum = name;
    this.state.playlistMeta = [{ file: `${name}/next.mp3`, title: 'next' }];
    this.state.playlist = this.state.playlistMeta.map((t) => t.file);
    this.state.currentTrackIdx = 0;
  }
  advanceTrack(file, { aired = true } = {}) {
    this.advances.push({ file, aired });
    const prev = this.getCurrentTrack();
    let cur;
    if (file && prev && prev.file !== file) cur = prev; // swapped mid-stream: the new current airs next
    else {
      this.state.currentTrackIdx++;
      if (this.state.currentTrackIdx >= this.state.playlist.length) {
        if (!(this._onPlaylistExhausted && this._onPlaylistExhausted())) this.state.currentTrackIdx = 0;
      }
      cur = this.getCurrentTrack();
    }
    if (this.onAdvance) this.onAdvance(cur);
    return cur;
  }
}

/** An ffmpeg that swallows stdin at once and never exits. */
function fakeFfmpeg() {
  const ff = new EventEmitter();
  ff.stdin = new Writable({ write(_c, _e, cb) { setImmediate(cb); } });
  ff.killed = false;
  ff.exitCode = null;
  ff.kills = 0;
  ff.kill = () => { ff.kills++; };
  return ff;
}

const EP1 = 'Drama — 1 — Pilot.mp3';
const EP2 = 'Drama — 2 — Night.mp3';
const FOLDER = 'Guest Showcase';

function station({ ep2Guest = 'creator-b', ttsDeferred = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gwa-'));
  const musicDir = path.join(root, 'music');
  const voiceDir = path.join(root, 'voice');
  fs.mkdirSync(path.join(musicDir, FOLDER), { recursive: true });
  fs.mkdirSync(voiceDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
  for (const f of [EP1, EP2]) fs.writeFileSync(path.join(musicDir, FOLDER, f), Buffer.alloc(4096, 0x55));
  fs.writeFileSync(path.join(musicDir, FOLDER, 'Drama — 1 — Pilot.guest.json'), JSON.stringify({ guest: 'creator-b', requires: [] }));
  fs.writeFileSync(path.join(musicDir, FOLDER, 'Drama — 2 — Night.guest.json'), JSON.stringify({ guest: ep2Guest, requires: [] }));
  fs.writeFileSync(path.join(musicDir, FOLDER, 'Drama — 1 — Pilot.after.txt'), 'CREDIT ONE');
  fs.writeFileSync(path.join(musicDir, FOLDER, 'Drama — 2 — Night.before.txt'), 'CONTENT NOTE');
  fs.writeFileSync(path.join(musicDir, FOLDER, 'Drama — 2 — Night.after.txt'), 'CREDIT TWO');
  const P = { ...gc.defaultPaths(root, {}), ...gw.defaultPaths(root, {}) };
  const guests = { 'creator-b': { consent: true, resolved: [] }, 'creator-c': { consent: true, resolved: [] } };
  fs.writeFileSync(P.consentFile, JSON.stringify({ guests }));
  const gate = gc.createGate({ musicDir, folder: FOLDER, ...P, log: quiet });
  const engine = new FakeEngine();
  const pendingTts = [];
  let n = 0;
  const voiceDJ = {
    generateTTS(text, cb) {
      const p = path.join(voiceDir, `v${++n}.mp3`);
      fs.writeFileSync(p, 'v');
      if (ttsDeferred) pendingTts.push(() => cb(null, p, text)); else cb(null, p, text);
    },
  };
  const aired = { tracks: [], voices: [] };
  const src = new IcecastSource({
    djEngine: engine, getMusicDir: () => musicDir,
    onTrackAired: (t) => aired.tracks.push(t.file),
    onVoiceAired: (v) => aired.voices.push(v.meta.label),
    onTrackStart: (t) => { if (t && t.isPodcastScheduled) s.onTrackStart(t); },
  });
  src._ffmpeg = fakeFfmpeg();
  src._running = true;
  // Episodes "last" a minute (so they are mid-air when withdrawn); voice is instant.
  src._probeDurationMs = async (p) => (p.includes(`${path.sep}music${path.sep}`) ? 60000 : 1);
  const broadcasts = [];
  const s = new PodcastScheduler({
    djEngine: engine, voiceDJ, broadcast: () => {}, broadcastState: () => broadcasts.push(Date.now()),
    getMusicDir: () => musicDir, gate,
    injectVoice: (p, meta) => src.injectAudio(p, meta),
    onairFile: path.join(root, 'onair.json'),
    show: { label: 'Guest Showcase', folder: FOLDER, airHours: [23], playAll: true, newReleasePriority: false,
      trackPrefix: '[FEATURED]', intro: () => 'INTRO' },
  });
  s._waitForPodcastEnd = () => {};
  s._chicagoNow = () => new Date(2026, 10, 9, 23, 0, 0);
  const withdraw = (guest) => {
    gw.withdraw(P.withdrawalsFile, { guest, channel: 'link' });
    return s.withdrawGuest(guest, { icecastSource: src });
  };
  return { root, musicDir, P, gate, engine, src, s, aired, broadcasts, pendingTts, withdraw };
}

const labels = (src) => src._voiceQueue.map((v) => v.meta.label);

check('every voice item a guest airing queues names its guests', async () => {
  const st = station();
  await st.s.airNow('test');
  assert.deepStrictEqual(labels(st.src), ['Guest Showcase intro']);
  assert.deepStrictEqual(st.src._voiceQueue[0].meta.guestAiring, { show: 'Guest Showcase', guests: ['creator-b'] });
  st.s.onTrackStart(st.engine.state.playlistMeta[0]);
  for (const v of st.src._voiceQueue) assert.ok(v.meta.guestAiring && v.meta.guestAiring.guests.includes('creator-b'), v.meta.label);
});

check('withdrawn while loaded but not yet on air: intro dropped, show never starts, the album resumes', async () => {
  const st = station();
  await st.s.airNow('test');
  let doneErr = null;
  st.src._voiceQueue[0].onDone = (e) => { doneErr = e; };
  const res = st.withdraw('creator-b');
  assert.strictEqual(res.dropped, 1);
  assert.strictEqual(doneErr && doneErr.message, 'withdrawn');
  assert.deepStrictEqual(labels(st.src), []);
  assert.strictEqual(res.ended, true);
  assert.strictEqual(res.cut, null, 'the song on air is not theirs and plays on');
  assert.strictEqual(st.engine.getCurrentTrack().file, 'Late Night/next.mp3');
  assert.strictEqual(st.s.getStatus().podcastPlaying, false);
  // The song on air ends: the engine's swap path plays the album, not the episode.
  assert.strictEqual(st.engine.advanceTrack('Late Night/song.mp3').file, 'Late Night/next.mp3');
  assert.ok(st.broadcasts.length > 0, 'the web player is told (the SPA path)');
});

check('withdrawn mid-episode: cut without killing ffmpeg, aired:false, credit + next note dropped, ident still airs', async () => {
  const st = station();
  await st.s.airNow('test');
  st.src._voiceQueue = []; // the intro has aired; EP1 is next
  st.engine.onAdvance = () => { st.src._running = false; };
  const loop = st.src._loop();
  await until(() => st.src._activeStream && st.src._activeStream.kind === 'track');
  // onTrackStart queued EP1's credit and EP2's note; a station ident is queued too.
  assert.deepStrictEqual(labels(st.src), ['Guest Showcase: after Drama — 1 — Pilot', 'Guest Showcase: before Drama — 2 — Night']);
  const ident = path.join(st.root, 'voice', 'ident.mp3');
  fs.writeFileSync(ident, 'i');
  st.src.injectAudio(ident, { label: 'Station ident', kind: 'sting' });
  const res = st.withdraw('creator-b');
  assert.strictEqual(res.dropped, 2);
  assert.ok(res.cut && res.cut.kind === 'track' && res.cut.track.file === path.join(FOLDER, EP1));
  assert.strictEqual(res.ended, true);
  await loop;
  assert.strictEqual(st.src._ffmpeg.kills, 0, 'ffmpeg was not killed');
  assert.deepStrictEqual(st.aired.tracks, [], 'the cut episode never reaches onTrackAired (the on-air digest)');
  assert.deepStrictEqual(st.aired.voices, ['Station ident'], 'nothing of theirs is "said on air"; the ident is');
  assert.deepStrictEqual(st.engine.advances, [{ file: path.join(FOLDER, EP1), aired: false }]);
  assert.strictEqual(st.engine.getCurrentTrack().file, 'Late Night/next.mp3', 'the interrupted album comes back');
  assert.strictEqual(st.gate.check(EP1).ok, false, 'and it is held from now on');
});

check('two guests in one showcase: only the one who withdrew leaves; the other airs on', async () => {
  const st = station({ ep2Guest: 'creator-c' });
  await st.s.airNow('test');
  st.src._voiceQueue = [];
  st.engine.onAdvance = () => { st.src._running = false; };
  const loop = st.src._loop();
  await until(() => st.src._activeStream && st.src._activeStream.kind === 'track');
  assert.deepStrictEqual(st.src._voiceQueue.map((v) => v.meta.guestAiring.guests), [['creator-b'], ['creator-c']]);
  const res = st.withdraw('creator-b');
  assert.strictEqual(res.dropped, 1, 'only EP1\'s credit');
  assert.deepStrictEqual(labels(st.src), ['Guest Showcase: before Drama — 2 — Night'], 'creator-c\'s note stays');
  assert.strictEqual(res.ended, false);
  await loop;
  assert.deepStrictEqual(st.engine.advances, [{ file: path.join(FOLDER, EP1), aired: false }]);
  assert.strictEqual(st.engine.getCurrentTrack().file, path.join(FOLDER, EP2), 'creator-c\'s episode is next');
  assert.deepStrictEqual(st.aired.voices, ['Guest Showcase: before Drama — 2 — Night']);
  // Withdrawing creator-c (not on air) while creator-b's slot is gone changes nothing for others.
  const st2 = station({ ep2Guest: 'creator-c' });
  await st2.s.airNow('test');
  st2.src._voiceQueue = [];
  st2.engine.onAdvance = () => { st2.src._running = false; };
  const loop2 = st2.src._loop();
  await until(() => st2.src._activeStream && st2.src._activeStream.kind === 'track');
  const r2 = st2.withdraw('creator-c');
  assert.strictEqual(r2.cut, null, 'creator-b\'s episode on air is not cut');
  assert.deepStrictEqual(labels(st2.src), ['Guest Showcase: after Drama — 1 — Pilot']);
  assert.deepStrictEqual(st2.engine.state.playlist, [path.join(FOLDER, EP1)]);
  st2.src.cutCurrent('end the test');
  await loop2;
});

check('a guest\'s voice item on air (their credit) is cut and never counted as said', async () => {
  const st = station();
  await st.s.airNow('test');
  // Make the credit long, so it is still streaming when the guest withdraws.
  st.src._probeDurationMs = async () => 60000;
  st.engine.onAdvance = () => { st.src._running = false; };
  st.engine.state.playlistMeta = [{ file: 'Late Night/song.mp3', title: 'song' }];
  st.engine.state.playlist = ['Late Night/song.mp3'];
  fs.mkdirSync(path.join(st.musicDir, 'Late Night'), { recursive: true });
  fs.writeFileSync(path.join(st.musicDir, 'Late Night', 'song.mp3'), 'x');
  st.src._voiceQueue = [];
  const credit = path.join(st.root, 'voice', 'credit.mp3');
  fs.writeFileSync(credit, 'c');
  st.src.injectAudio(credit, { label: 'credit', guestAiring: { show: 'Guest Showcase', guests: ['creator-b'] } });
  const loop = st.src._loop();
  await until(() => st.src._activeStream && st.src._activeStream.kind === 'track');
  st.src.cutCurrent('song done'); // the song "ends"; the credit starts
  await until(() => st.src._activeStream && st.src._activeStream.kind === 'voice');
  const res = st.withdraw('creator-b');
  assert.ok(res.cut && res.cut.kind === 'voice');
  await loop;
  assert.deepStrictEqual(st.aired.voices, [], 'the cut credit is not "said on air"');
});

check('withdrawn while the spoken lines render: the re-check holds the airing, nothing loads', async () => {
  const st = station({ ttsDeferred: true });
  st.s.airNow('test');
  await tick();
  assert.deepStrictEqual(st.engine.state.playlist, ['Late Night/song.mp3'], 'nothing loads while rendering');
  gw.withdraw(st.P.withdrawalsFile, { guest: 'creator-b', channel: 'email' });
  while (st.pendingTts.length) { st.pendingTts.shift()(); await tick(1); }
  assert.deepStrictEqual(st.engine.state.playlist, ['Late Night/song.mp3']);
  assert.deepStrictEqual(labels(st.src), []);
  assert.strictEqual(fs.existsSync(st.P.ledgerFile), false, 'not counted as an airing');
});

check('withdrawGuest is idempotent and a no-op for a show without a gate', async () => {
  const st = station();
  await st.s.airNow('test');
  st.withdraw('creator-b');
  const again = st.s.withdrawGuest('creator-b', { icecastSource: st.src });
  assert.deepStrictEqual(again, { dropped: 0, removed: [], cut: null, ended: false });
  const plain = new PodcastScheduler({ djEngine: new FakeEngine(), voiceDJ: {}, broadcast() {}, broadcastState() {}, getMusicDir: () => st.musicDir });
  assert.deepStrictEqual(plain.withdrawGuest('creator-b', { icecastSource: st.src }), { dropped: 0, removed: [], cut: null, ended: false });
});

check('cutCurrent settles a stalled stream at once and dropQueued reaches an item mid bed-mix', async () => {
  const src = new IcecastSource({ djEngine: new FakeEngine(), getMusicDir: () => os.tmpdir() });
  const ff = fakeFfmpeg();
  ff.stdin = new Writable({ highWaterMark: 16, write() { /* never drains: back-pressure */ } });
  src._ffmpeg = ff;
  src._running = true;
  src._probeDurationMs = async () => 60000;
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gwc-')), 'big.mp3');
  fs.writeFileSync(f, Buffer.alloc(1 << 20, 0x55));
  const p = src._streamFileToFfmpeg(f, 0, { kind: 'track', track: { file: 'x' } });
  await until(() => src._activeStream);
  assert.strictEqual(src.cutCurrent('test', (a) => a.kind === 'voice'), null, 'the predicate is honoured');
  assert.ok(src.cutCurrent('test'));
  assert.deepStrictEqual(await p, { cut: true });
  assert.strictEqual(src._activeStream, null);
  assert.strictEqual(src.cutCurrent('again'), null);
  const item = { path: f, meta: { guestAiring: { show: 'S', guests: ['g'] } } };
  src._drainingItem = item;
  assert.strictEqual(src.dropQueued((m) => m.guestAiring && m.guestAiring.guests.includes('g')), 1);
  assert.strictEqual(item.dropped, 'withdrawn');
});

check('a cut that lands while the file is still being probed stops it before a byte is sent', async () => {
  const src = new IcecastSource({ djEngine: new FakeEngine(), getMusicDir: () => os.tmpdir() });
  const ff = fakeFfmpeg();
  let written = 0;
  ff.stdin = new Writable({ write(c, e, cb) { written += c.length; cb(); } });
  src._ffmpeg = ff;
  src._running = true;
  let release;
  src._probeDurationMs = () => new Promise((res) => { release = () => res(60000); });
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gwp-')), 'probe.mp3');
  fs.writeFileSync(f, Buffer.alloc(4096, 0x55));
  const p = src._streamFileToFfmpeg(f, 0, { kind: 'track', track: { file: 'x', isPodcastScheduled: true } });
  await until(() => release);
  const info = src.cutCurrent('withdrawn mid-probe', (a) => a.kind === 'track' && a.track.file === 'x');
  assert.ok(info, 'the probing file is cuttable');
  release();
  assert.deepStrictEqual(await p, { cut: true });
  assert.strictEqual(written, 0, 'nothing of the withdrawn file reached ffmpeg');
  assert.strictEqual(src._activeStream, null);
});

check('the server wiring: both guest schedulers, the link route hook, the log watcher', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.ok(/for \(const s of \[readingScheduler, showcaseScheduler\]\) \{\s*try \{ s\.withdrawGuest\(guest, \{ icecastSource \}\)/.test(src));
  assert.ok(/deps\.onGuestWithdrawn = applyGuestWithdrawal/.test(src));
  assert.ok(/watchWithdrawals\(GUEST_PATHS\.withdrawalsFile, applyGuestWithdrawal\)/.test(src));
});

check('the log watcher applies rows the CLI writes, once each', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gww-'));
  const file = path.join(root, 'workspace', 'guest-withdrawals.jsonl');
  gw.withdraw(file, { guest: 'old', channel: 'link' });
  const seen = [];
  const w = gw.watchWithdrawals(file, (g) => seen.push(g), { pollMs: 20, log: quiet });
  try {
    gw.withdraw(file, { guest: 'new-one', channel: 'email' });
    gw.reconsent(file, { guest: 'old', evidence: 'x' });
    await until(() => seen.length >= 1);
    await tick(80);
    w.scan();
    assert.deepStrictEqual(seen, ['new-one'], 'existing rows and re-consents are not applied; new ones once');
  } finally { w.close(); }
});

(async () => {
  console.log('guest-withdrawal-onair.test.js');
  for (const t of queue) await t();
  if (failures) { console.error(`\n${failures} guest-withdrawal-onair test(s) failed`); process.exit(1); }
  console.log('all passed');
  process.exit(0);
})();
