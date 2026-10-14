'use strict';
/**
 * sound-library.test.js — beds under the voice, stings at the seams, all off
 * by default.
 *
 * 2026-10-14: the Kannaka Sound Library (24 Stable Audio Open cues) goes on
 * the air behind SOUND_BEDS / SOUND_STINGS. This pins what must stay true:
 * flags off leaves the voice queue byte-identical; the mixer keeps the
 * voice's length and level and makes the bed audible in the voice's
 * silences; stings land only where the programming rules say; a missing
 * clip means the voice airs alone and the log says so once.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

let failures = 0;
const pending = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => console.log('  ok   ' + name),
        (e) => { failures++; console.error('  FAIL ' + name + '\n       ' + e.message); },
      ));
    } else {
      console.log('  ok   ' + name);
    }
  } catch (e) { failures++; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('sound-library');

const sl = require('../server/sound-library');
const { IcecastSource } = require('../server/icecast-source');

// ── pure rules ──────────────────────────────────────────────────────────

test('flags default off; only the literal "1" turns one on', () => {
  assert.deepStrictEqual(sl.readFlags({}), { beds: false, stings: false, sfx: false });
  assert.deepStrictEqual(sl.readFlags({ SOUND_BEDS: 'true', SOUND_STINGS: 'yes' }), { beds: false, stings: false, sfx: false });
  assert.deepStrictEqual(sl.readFlags({ SOUND_BEDS: '1', SOUND_STINGS: '1' }), { beds: true, stings: true, sfx: false });
});

test('bedFor picks the bed by context and never under a guest or a show intro', () => {
  assert.equal(sl.bedFor({ label: 'Kannaka — Peace Oration', kind: 'oration' }, 12), 'cathedral-oration');
  assert.equal(sl.bedFor({ label: 'Kannaka — Peace Oration' }, 12), 'cathedral-oration', 'label alone still matches the oration');
  assert.equal(sl.bedFor({ label: 'Kannaka — Peace Oration', kind: 'gossip' }, 16), 'newsroom-tension');
  assert.equal(sl.bedFor({ label: 'Artist Story intro' }, 12), 'warm-piano-hearth');
  assert.equal(sl.bedFor({ label: 'Featured Artist intro' }, 23), null, 'a guest slot never gets a bed');
  assert.equal(sl.bedFor({ label: 'Featured Artist: Solace Road narration', kind: 'dj' }, 23), null, 'nor a guest slot narrated as patter at night');
  assert.equal(sl.bedFor({ label: 'The Story of Flaukowski intro' }, 23), null, 'a show intro is framed by the sting');
  assert.equal(sl.bedFor({ label: 'DJ intro: Asymptote', introFor: 'x.mp3' }, 2), 'late-night-radio', 'overnight patter');
  assert.equal(sl.bedFor({ label: 'DJ intro: Asymptote', introFor: 'x.mp3' }, 14), null, 'daytime patter stays dry');
  assert.equal(sl.bedFor({ label: 'Showcase: Swarm Intentions narration', kind: 'dj' }, 23), 'late-night-radio');
  assert.equal(sl.bedFor({ label: 'Station ident', kind: 'sting' }, 2), null, 'never a bed under a sting');
  assert.equal(sl.bedFor({ label: 'Kannaka — Peace Oration', kind: 'oration', noBed: true }, 2), null, 'an explicit opt-out wins');
  assert.equal(sl.bedFor(null, 2), null);
});

test('isNight is 22:00–05:59 Chicago', () => {
  for (const h of [22, 23, 0, 3, 5]) assert.ok(sl.isNight(h), `hour ${h}`);
  for (const h of [6, 9, 12, 18, 21]) assert.ok(!sl.isNight(h), `hour ${h}`);
});

test('the chime follows the record-store ad only; the bumper precedes the first commercial of a block', () => {
  const song = { title: 'Asymptote', file: 'a.mp3' };
  const storeAd = { title: '[AD] Ghost Signals Records — The Store Is Open', file: 'c1.mp3', commercial: true };
  const atmAd = { title: '[AD] The USDC ATM — By the Door', file: 'c2.mp3', commercial: true };
  const otherAd = { title: '[AD] Air Time — This Could Be Your Ad', file: 'c3.mp3', commercial: true };
  assert.deepStrictEqual(sl.stingsForTrackChange(storeAd, song), ['chime']);
  assert.deepStrictEqual(sl.stingsForTrackChange(atmAd, song), ['chime'], 'the ATM spot is the store too');
  assert.deepStrictEqual(sl.stingsForTrackChange(otherAd, song), [], 'no chime after another ad');
  assert.deepStrictEqual(sl.stingsForTrackChange(song, otherAd), ['bumper']);
  assert.deepStrictEqual(sl.stingsForTrackChange(otherAd, storeAd), [], 'inside a block: no second bumper');
  assert.deepStrictEqual(sl.stingsForTrackChange(storeAd, otherAd), ['chime'], 'store ad then another ad: chime, no bumper');
  assert.deepStrictEqual(sl.stingsForTrackChange(song, song), []);
  assert.deepStrictEqual(sl.stingsForTrackChange(null, song), []);
});

test('the ident fires once at minute 0 of an hour, in plain DJ programming only', () => {
  const dj = { channel: 'dj', live: false, showPlaying: false, minute: 0 };
  assert.ok(sl.identDue(dj, '2026-9-14T9', null));
  assert.ok(!sl.identDue(dj, '2026-9-14T9', '2026-9-14T9'), 'already fired this hour');
  assert.ok(sl.identDue(dj, '2026-9-14T10', '2026-9-14T9'), 'next hour');
  assert.ok(!sl.identDue(Object.assign({}, dj, { minute: 1 }), '2026-9-14T9', null), 'only at :00');
  assert.ok(!sl.identDue(Object.assign({}, dj, { channel: 'music' }), '2026-9-14T9', null));
  assert.ok(!sl.identDue(Object.assign({}, dj, { live: true }), '2026-9-14T9', null), 'never over a live broadcast');
  assert.ok(!sl.identDue(Object.assign({}, dj, { showPlaying: true }), '2026-9-14T9', null), 'never inside a show');
});

test('show stings frame the podcast and TSOF, not the guest set or the story', () => {
  assert.ok(sl.showGetsStings('The Story of Flaukowski intro'));
  assert.ok(sl.showGetsStings('Ghost Signals Podcast intro'));
  assert.ok(sl.showGetsStings('Podcast'));
  assert.ok(!sl.showGetsStings('Featured Artist intro'));
  assert.ok(!sl.showGetsStings('Artist Story intro'));
  assert.ok(!sl.showGetsStings(undefined));
});

// ── runtime wiring ──────────────────────────────────────────────────────

function fakeLibrary(have) {
  const log = [];
  const lib = {
    dir: '/fake', log,
    bed: (n) => have.includes('bed:' + n) ? `/fake/beds/kannaka-bed-${n}.mp3` : (log.push('missing bed ' + n), null),
    sting: (n) => have.includes('sting:' + n) ? `/fake/stings/kannaka-sting-${n}.mp3` : (log.push('missing sting ' + n), null),
    sfx: () => null,
  };
  return lib;
}

test('flags off: no prepareVoice hook, no stings, and the icecast queue item is untouched', () => {
  const injected = [];
  const rt = sl.createSoundRuntime({ env: {}, library: fakeLibrary(['bed:cathedral-oration', 'sting:station-ident', 'sting:commercial-bumper']), inject: (p, m) => injected.push([p, m]), log: () => {} });
  assert.equal(rt.prepareVoice, null);
  rt.cues.onTrackChange({ title: 'x', file: 'x.mp3' }, { title: '[AD] y', file: 'y.mp3', commercial: true });
  rt.cues.beforeShowIntro({ label: 'The Story of Flaukowski intro' });
  rt.cues.onShowEnd('The Story of Flaukowski');
  assert.ok(rt.cues.tick({ channel: 'dj', live: false, showPlaying: false, minute: 0 }) === false);
  assert.deepStrictEqual(injected, []);
  // The queue item an injector sees is exactly what it passed: no pending mix.
  const src = new IcecastSource({ djEngine: {}, getMusicDir: () => os.tmpdir() });
  src._running = true;
  const meta = { label: 'Kannaka — Peace Oration', kind: 'oration' };
  src.injectAudio('/tmp/voice.mp3', meta);
  assert.equal(src._voiceQueue.length, 1);
  assert.deepStrictEqual(Object.keys(src._voiceQueue[0]).sort(), ['meta', 'onDone', 'path']);
  assert.equal(src._voiceQueue[0].path, '/tmp/voice.mp3');
  assert.strictEqual(src._voiceQueue[0].meta, meta);
});

test('stings on: the right clip is queued at each seam, once', () => {
  const injected = [];
  const rt = sl.createSoundRuntime({ env: { SOUND_STINGS: '1' }, library: fakeLibrary(['sting:station-ident', 'sting:commercial-bumper', 'sting:store-door-chime', 'sting:show-intro', 'sting:show-outro']), inject: (p, m) => injected.push([path.basename(p), m.kind, m.label]), log: () => {} });
  rt.cues.onTrackChange({ title: 'Asymptote', file: 'a.mp3' }, { title: '[AD] Air Time', file: 'c.mp3', commercial: true });
  rt.cues.onTrackChange({ title: '[AD] Ghost Signals Records — The Store Is Open', file: 'c.mp3', commercial: true }, { title: 'Next', file: 'n.mp3' });
  rt.cues.beforeShowIntro({ label: 'The Story of Flaukowski intro' });
  rt.cues.beforeShowIntro({ label: 'Featured Artist intro' });
  rt.cues.onShowEnd('The Story of Flaukowski');
  const t0 = new Date('2026-10-14T15:00:10Z'); // 10:00 Chicago (CDT)
  assert.equal(rt.cues.tick({ channel: 'dj', live: false, showPlaying: false }, t0), true);
  assert.equal(rt.cues.tick({ channel: 'dj', live: false, showPlaying: false }, new Date('2026-10-14T15:00:40Z')), false, 'same hour: once');
  assert.equal(rt.cues.tick({ channel: 'dj', live: false, showPlaying: false }, new Date('2026-10-14T16:00:05Z')), true, 'next hour');
  assert.deepStrictEqual(injected.map((x) => x[0]), [
    'kannaka-sting-commercial-bumper.mp3', 'kannaka-sting-store-door-chime.mp3',
    'kannaka-sting-show-intro.mp3', 'kannaka-sting-show-outro.mp3',
    'kannaka-sting-station-ident.mp3', 'kannaka-sting-station-ident.mp3',
  ]);
  assert.ok(injected.every((x) => x[1] === 'sting'), 'every sting is marked so no bed goes under it');
});

test('beds on: the hook mixes the matching bed, and a missing bed airs the voice alone with one log line', () => {
  const calls = []; const logs = [];
  const lib = fakeLibrary(['bed:cathedral-oration']);
  const rt = sl.createSoundRuntime({
    env: { SOUND_BEDS: '1' }, library: lib, nowHour: () => 2, log: () => {}, warn: (m) => logs.push(m),
    mixer: (voice, bed, out, _o, cb) => { calls.push([voice, path.basename(bed), path.basename(out)]); cb(null, out); },
  });
  assert.equal(typeof rt.prepareVoice, 'function');
  return rt.prepareVoice('/v/oration.mp3', { label: 'Kannaka — Peace Oration', kind: 'oration' }).then((mixed) => {
    assert.equal(mixed, '/v/oration.mp3.bed-cathedral-oration.mp3');
    assert.deepStrictEqual(calls, [['/v/oration.mp3', 'kannaka-bed-cathedral-oration.mp3', 'oration.mp3.bed-cathedral-oration.mp3']]);
    return rt.prepareVoice('/v/intro.mp3', { label: 'DJ intro: Asymptote' });
  }).then((mixed) => {
    assert.equal(mixed, null, 'late-night-radio is not on disk: voice alone');
    assert.equal(calls.length, 1, 'no mix attempted without the clip');
    return rt.prepareVoice('/v/intro2.mp3', { label: 'DJ intro: Chiral' });
  }).then(() => {
    assert.deepStrictEqual(lib.log, ['missing bed late-night-radio', 'missing bed late-night-radio'], 'the fake logs every lookup; the real library logs once (next test)');
    assert.deepStrictEqual(logs, []);
  });
});

test('SoundLibrary resolves clips by kind and name and warns once per missing clip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksl-'));
  fs.mkdirSync(path.join(dir, 'beds')); fs.mkdirSync(path.join(dir, 'stings')); fs.mkdirSync(path.join(dir, 'sfx'));
  fs.writeFileSync(path.join(dir, 'beds', 'kannaka-bed-cathedral-oration.mp3'), 'x');
  const warned = [];
  const lib = new sl.SoundLibrary({ dir, log: (m) => warned.push(m) });
  assert.equal(lib.bed('cathedral-oration'), path.join(dir, 'beds', 'kannaka-bed-cathedral-oration.mp3'));
  assert.equal(lib.sting('station-ident'), null);
  assert.equal(lib.sting('station-ident'), null);
  assert.equal(lib.bed('nope'), null);
  assert.equal(warned.length, 2, 'one line per missing clip, not per lookup');
  assert.ok(/missing sting "station-ident"/.test(warned[0]));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a prepared voice item waits for its mix and then streams the mixed file; a failed mix streams the original', () => {
  const src = new IcecastSource({ djEngine: {}, getMusicDir: () => os.tmpdir(), prepareVoice: (p, meta) => meta.fail ? Promise.reject(new Error('boom')) : Promise.resolve(meta.none ? null : p + '.mixed') });
  src._running = true;
  src.injectAudio('/v/a.mp3', { label: 'A' });
  src.injectAudio('/v/b.mp3', { label: 'B', fail: true });
  src.injectAudio('/v/c.mp3', { label: 'C', none: true });
  const [a, b, c] = src._voiceQueue;
  assert.ok(a.pending && typeof a.pending.then === 'function');
  return Promise.all([a.pending, b.pending, c.pending]).then(() => {
    assert.equal(a.path, '/v/a.mp3.mixed');
    assert.equal(b.path, '/v/b.mp3', 'the voice airs raw when the mix fails');
    assert.equal(c.path, '/v/c.mp3', 'and when the hook declines (no bed for this item)');
  });
});

test('the stream loop waits for the mix before it streams the item (not just the test)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksl-loop-'));
  const song = path.join(dir, 'song.mp3'); fs.writeFileSync(song, 's');
  const voice = path.join(dir, 'voice.mp3'); fs.writeFileSync(voice, 'v');
  const mixed = path.join(dir, 'voice.mp3.bed-cathedral-oration.mp3'); fs.writeFileSync(mixed, 'm');
  let resolveMix;
  const engine = {
    state: {}, getCurrentTrack: () => ({ file: song, title: 'Song' }),
    peekNextTrack: () => null, advanceTrack() { src._running = false; },
  };
  const src = new IcecastSource({
    djEngine: engine, getMusicDir: () => dir,
    prepareVoice: () => new Promise((r) => { resolveMix = r; }),
  });
  const streamed = [];
  src._ffmpeg = { stdin: {}, killed: false };
  src._streamFileToFfmpeg = async (p) => { streamed.push(path.basename(p)); };
  src._running = true;
  src.injectAudio(voice, { label: 'Kannaka — Peace Oration', kind: 'oration' });
  const loop = src._loop();
  // The song streams first; the mix lands while it plays.
  return new Promise((r) => setTimeout(r, 30)).then(() => {
    assert.deepStrictEqual(streamed, ['song.mp3'], 'the voice item is held until its mix resolves');
    resolveMix(mixed);
    return loop;
  }).then(() => {
    assert.deepStrictEqual(streamed, ['song.mp3', 'voice.mp3.bed-cathedral-oration.mp3']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── the mixer itself (needs ffmpeg/ffprobe; skipped loudly without them) ──

function have(bin) { try { cp.execFileSync(bin, ['-version'], { stdio: 'ignore' }); return true; } catch (_) { return false; } }
function meanDb(file, from, to) {
  const r = cp.spawnSync('ffmpeg', ['-v', 'info', '-ss', String(from), '-t', String(to - from), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr);
  if (!m) throw new Error('no volumedetect for ' + file + ': ' + r.stderr.slice(-300));
  return parseFloat(m[1]);
}
function durSec(file) {
  return parseFloat(cp.execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }));
}

if (!have('ffmpeg') || !have('ffprobe')) {
  console.log('  SKIP mixUnderVoice: ffmpeg/ffprobe not on PATH (the mixer is untested on this box)');
} else {
  test('mixUnderVoice keeps the voice length and level and puts the bed in the voice\'s silence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksl-mix-'));
    const voice = path.join(dir, 'voice.mp3');
    const bed = path.join(dir, 'bed.mp3');
    const out = path.join(dir, 'out.mp3');
    // A "voice": 1 s of tone, 1 s of silence, 1 s of tone, mono 24 kHz (the DJ clip shape).
    cp.execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000:duration=3',
      '-af', "volume=enable='between(t,1,2)':volume=0", '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '48k', voice]);
    // A "bed": 2 s of stereo tone at 44.1 kHz, shorter than the voice so the loop is exercised.
    cp.execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100:duration=2', '-ac', '2', '-c:a', 'libmp3lame', bed]);
    const voiceLevel = meanDb(voice, 0.1, 0.9);
    const voiceGap = meanDb(voice, 1.15, 1.85);
    return new Promise((resolve, reject) => sl.mixUnderVoice(voice, bed, out, {}, (err) => (err ? reject(err) : resolve()))).then(() => {
      const dv = durSec(voice), dm = durSec(out);
      assert.ok(Math.abs(dm - dv) <= 0.2, `duration ${dm.toFixed(2)} vs voice ${dv.toFixed(2)}`);
      const mixLevel = meanDb(out, 0.1, 0.9);
      assert.ok(Math.abs(mixLevel - voiceLevel) <= 1.0, `voice level moved ${voiceLevel.toFixed(1)} -> ${mixLevel.toFixed(1)} dB`);
      const mixGap = meanDb(out, 1.15, 1.85);
      assert.ok(mixGap > voiceGap + 20, `bed not audible in the gap: ${voiceGap.toFixed(1)} -> ${mixGap.toFixed(1)} dB`);
      assert.ok(mixGap < voiceLevel - 10, `bed too loud: gap ${mixGap.toFixed(1)} vs voice ${voiceLevel.toFixed(1)} dB`);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
}

Promise.all(pending).then(() => {
  if (failures) { console.error(`sound-library: ${failures} failed`); process.exit(1); }
  console.log('sound-library: all passed');
});
