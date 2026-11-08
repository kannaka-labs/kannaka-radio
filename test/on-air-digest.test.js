'use strict';

// on-air-digest.test.js — what the station says on air reaches her store,
// as ONE digest an hour, not one memory per DJ line.
//
// voice-writeback (#438) stored what went out in writing; the spoken side —
// DJ intros, swarm and dream-end lines, showcase narration, the news and
// gossip desks, in-house commercials, show intros — never reached her store.
// The binary is mocked throughout: no test here touches a real store.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const vw = require(path.join(ROOT, 'server/voice-writeback'));
const digestMod = require(path.join(ROOT, 'server/on-air-digest'));
const { OnAirDigest, registerSpeech, speakerFor } = digestMod;
const { VoiceDJ } = require(path.join(ROOT, 'server/voice-dj'));

let failed = 0;
const realLog = console.log;
async function run(name, fn) {
  try { await fn(); realLog(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}: ${e.stack || e.message}`); failed++; }
}

let calls = [];
let behaviour = 'ok'; // 'ok' | 'fail' | 'hang'
function fakeExecFile(bin, args, opts, cb) {
  calls.push({ bin, args, opts });
  if (behaviour === 'hang') return;
  setImmediate(() => cb(behaviour === 'fail' ? Object.assign(new Error('boom'), { code: 1 }) : null, '', ''));
}
const logs = [];
let clock = Date.parse('2026-11-07T18:00:00.000Z');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'on-air-digest-'));
let n = 0;
function fresh(opts = {}) {
  vw._reset();
  vw._setExecFile(fakeExecFile);
  vw.configure({ bin: '/fake/kannaka' });
  calls = []; behaviour = 'ok'; logs.length = 0;
  delete process.env.KANNAKA_VOICE_WRITEBACK;
  delete process.env.KANNAKA_READONLY;
  clock = Date.parse('2026-11-07T18:00:00.000Z');
  const file = opts.file || path.join(tmp, `buf-${++n}.jsonl`);
  return { d: new OnAirDigest({ file, now: () => clock }), file };
}

async function main() {
  console.log('on-air-digest.test.js');
  console.log = (...a) => { logs.push(a.join(' ')); };

  await run('an hour of DJ lines is ONE memory, labelled said-on-air, said-not-lived', async () => {
    const { d } = fresh();
    d.record({ text: 'That was Hello World. Stay close.', composer: 'kannaka ask via voice-dj track intro' });
    clock += 20 * 60 * 1000;
    d.record({ text: 'Station ID: Kannaka Radio, the ghost frequency.', composer: 'voice-dj intro template' });
    clock += 20 * 60 * 1000;
    d.record({ text: 'Gene here at the desk.', speaker: speakerFor('news'), composer: 'kannaka ask via news-teaser' });
    assert.strictEqual(d.maybeFlush(), null, 'nothing is written before the hour');
    assert.strictEqual(calls.length, 0);
    clock += 21 * 60 * 1000;
    await d.maybeFlush();
    assert.strictEqual(calls.length, 1, 'one memory for the whole hour');
    const [verb, memory, flag, importance] = calls[0].args;
    assert.strictEqual(verb, 'remember');
    assert.strictEqual(flag, '--importance');
    assert.strictEqual(importance, digestMod.DIGEST_IMPORTANCE.toFixed(2));
    assert.ok(memory.startsWith('[Provenance: said on air on Kannaka Radio between 2026-11-07T18:00:00.000Z and 2026-11-07T18:40:00.000Z; composed by '), memory);
    assert.ok(memory.includes('kannaka ask via voice-dj track intro, voice-dj intro template, kannaka ask via news-teaser; said, not lived.]'), memory);
    assert.ok(memory.includes('- [Kannaka (DJ)] That was Hello World. Stay close.'));
    assert.ok(memory.includes('- [Gene (News Anchor)] Gene here at the desk.'), 'other voices on the station are named');
    assert.strictEqual(d.pending(), 0);
  });

  await run('exact repeats (a station ID twice, a line on /stream and the web player) are kept once', async () => {
    const { d } = fresh();
    assert.strictEqual(d.record({ text: 'Kannaka Radio. The ghost frequency.' }), 'buffered');
    assert.strictEqual(d.record({ text: '  kannaka radio.   The ghost frequency. ' }), 'repeat');
    assert.strictEqual(d.record({ text: '' }), 'empty');
    assert.strictEqual(d.pending(), 1);
  });

  await run('a long hour is cut to the 6000-char cap, with a count of what was left out', async () => {
    const { d } = fresh();
    for (let i = 0; i < 200; i++) d.record({ text: `Line number ${i}: ${'words '.repeat(20)}` });
    await d.flush('test');
    const memory = calls[0].args[1];
    assert.ok(memory.length <= vw.MAX_TEXT_CHARS + 400, `memory is ${memory.length} chars`);
    assert.ok(/\[…\d+ more line\(s\) said in this window, not kept here\]/.test(memory), memory.slice(-200));
    assert.ok(!memory.includes('[…truncated]'), 'the digest cuts whole lines itself');
  });

  await run('buffered lines survive a restart and are written by the next process', async () => {
    const { d, file } = fresh();
    d.record({ text: 'Said before the restart.' });
    d.record({ text: 'Also before the restart.' });
    const d2 = new OnAirDigest({ file, now: () => clock });
    assert.strictEqual(d2.pending(), 2, 'resumed from the buffer file');
    clock += 61 * 60 * 1000;
    d2.start();
    d2.stop();
    await vw.flush(1000);
    assert.strictEqual(calls.length, 1, 'start() flushes lines already an hour old');
    assert.ok(calls[0].args[1].includes('Said before the restart.'));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(fs.readFileSync(file, 'utf8').trim(), '', 'the buffer is emptied once stored');
  });

  await run('a failed store keeps every line buffered (on disk) for the next try', async () => {
    const { d, file } = fresh();
    d.record({ text: 'Do not lose me.' });
    behaviour = 'fail';
    const r = await d.flush('test');
    assert.strictEqual(r.stored, false);
    assert.strictEqual(d.pending(), 1);
    assert.ok(fs.readFileSync(file, 'utf8').includes('Do not lose me.'));
    behaviour = 'ok';
    const r2 = await d.flush('test');
    assert.strictEqual(r2.stored, true);
    assert.strictEqual(d.pending(), 0);
  });

  await run('a digest already stored by another process (shared ledger) empties the buffer, no second copy', async () => {
    const { d, file } = fresh();
    d.record({ text: 'Written once.' });
    const ledger = vw.ledgerPath();
    const r1 = await d.flush('test');
    assert.strictEqual(r1.stored, true);
    // The process died before it emptied its buffer: the next one finds the line again.
    fs.writeFileSync(file, JSON.stringify({ t: clock, text: 'Written once.', speaker: 'Kannaka (DJ)', composer: 'the station\'s voice pipeline' }) + '\n');
    vw._reset(); vw._setExecFile(fakeExecFile); vw._setLedgerPath(ledger);
    const d2 = new OnAirDigest({ file, now: () => clock });
    const r2 = await d2.flush('test');
    assert.strictEqual(r2.stored, false);
    assert.ok(/shared ledger/.test(r2.reason), r2.reason);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(d2.pending(), 0);
  });

  await run('shutdown flush is bounded: a hung store does not hold the exit, and the lines stay on disk', async () => {
    const { d, file } = fresh();
    d.record({ text: 'Last words before SIGTERM.' });
    behaviour = 'hang';
    const t0 = Date.now();
    await d.flushForShutdown(50);
    assert.ok(Date.now() - t0 < 1000);
    assert.ok(fs.readFileSync(file, 'utf8').includes('Last words before SIGTERM.'));
  });

  await run('a long-form piece is its own memory per airing, at publication importance, in its own voice', async () => {
    const { d } = fresh();
    assert.strictEqual(d.record({ text: 'Top of the hour. The buoys report calm seas.', whole: true, title: 'news broadcast', speaker: speakerFor('news'), composer: 'kannaka ask via news-broadcast' }), 'whole');
    await vw.flush(1000);
    assert.strictEqual(calls.length, 1);
    const memory = calls[0].args[1];
    assert.ok(memory.startsWith('[Provenance: said on air on Kannaka Radio at 2026-11-07T18:00:00.000Z (news broadcast) in the voice of Gene (News Anchor); composed by kannaka ask via news-broadcast; said, not lived.]'), memory);
    assert.strictEqual(calls[0].args[3], vw.IMPORTANCE.toFixed(2));
    assert.strictEqual(d.pending(), 0, 'not also buffered');
  });

  await run('aired(): the text is looked up from TTS time; an oration that remembers itself is skipped', async () => {
    const { d } = fresh();
    const p = path.join(tmp, 'dj_1.mp3');
    registerSpeech(p, { text: 'Next up, a song about rain.', persona: 'dj', composer: 'kannaka ask via voice-dj track intro' });
    assert.strictEqual(d.aired({ path: p, meta: { label: 'DJ intro: Rain' } }), 'buffered');
    assert.strictEqual(d.aired({ path: path.join(tmp, 'never-registered.mp3'), meta: {} }), 'empty', 'no text, nothing invented');
    const o = path.join(tmp, 'dj_2.mp3');
    registerSpeech(o, { text: 'Peace is the work.', persona: 'oration' });
    assert.strictEqual(d.aired({ path: o, meta: { speech: { whole: true, skip: true } } }), 'skip');
    const s = path.join(tmp, 'dj_3.mp3');
    registerSpeech(s, { text: 'This album began in a basement.', persona: 'dj' });
    assert.strictEqual(d.aired({ path: s, meta: { speech: { whole: true, title: 'album showcase intro: X', composer: 'kannaka ask via album showcase' } } }), 'whole');
    await vw.flush(1000);
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].args[1].includes('(album showcase intro: X); composed by kannaka ask via album showcase;'), calls[0].args[1]);
  });

  await run('web-player-only DJ lines are recorded; streamed ones and orations are left to airing', async () => {
    const { d } = fresh();
    assert.strictEqual(d.fromBroadcast({ type: 'dj_voice', text: 'A dream just ended in the swarm.', source: 'swarm_event' }), 'buffered');
    assert.strictEqual(d.fromBroadcast({ type: 'dj_voice', text: 'Streamed intro.', inStream: true }), 'skip');
    assert.strictEqual(d.fromBroadcast({ type: 'dj_oration', text: 'An oration.' }), 'skip');
    assert.strictEqual(d.fromBroadcast({ type: 'state', text: 'x' }), 'skip');
    assert.strictEqual(d.fromBroadcast({ type: 'dj_talk_segment', text: 'Block change: late night.', source: 'programming_transition' }), 'buffered');
    await d.flush('test');
    assert.ok(calls[0].args[1].includes('voice-dj (swarm_event)'));
  });

  await run('trackAired: shows and commercials count, songs and other artists\' slots do not', async () => {
    const { d } = fresh();
    const music = fs.mkdtempSync(path.join(tmp, 'music-'));
    fs.mkdirSync(path.join(music, 'The Story of Flaukowski'));
    fs.writeFileSync(path.join(music, 'The Story of Flaukowski', 'TSOF-E10.script.txt'), 'NARRATOR: The pie was the best bad pie.');
    assert.strictEqual(d.trackAired({ file: 'a-song.mp3', title: 'A Song' }, music), 'skip');
    assert.strictEqual(d.trackAired({ file: 'Featured/x.mp3', title: '[FEATURED] x', isPodcastScheduled: true }, music), 'skip');
    assert.strictEqual(d.trackAired({ file: 'Ghost Signals Podcast/GSP-001.mp3', title: '[PODCAST] GSP-001', album: 'Ghost Signals Podcast', isPodcastScheduled: true }, music), 'buffered');
    assert.strictEqual(d.trackAired({ file: 'The Story of Flaukowski/TSOF-E10.mp3', title: '[TSOF] E10', album: 'The Story of Flaukowski', isPodcastScheduled: true }, music), 'whole');
    assert.strictEqual(d.trackAired({ file: 'commercials/c1.mp3', title: '[AD] Stay', commercial: true, theme: 'Stay tuned to the ghost frequency.' }, music), 'buffered');
    assert.strictEqual(d.trackAired({ file: 'ads/a.mp3', title: '[SPONSOR] Shoes', commercial: true, sponsor: true }, music), 'buffered');
    await vw.flush(1000);
    assert.ok(calls[0].args[1].includes('NARRATOR: The pie was the best bad pie.'), 'a script on disk is remembered whole');
    await d.flush('test');
    const digest = calls[1].args[1];
    assert.ok(digest.includes('Aired the episode "[PODCAST] GSP-001" (Ghost Signals Podcast); its script is not on disk here.'));
    assert.ok(digest.includes('Stay tuned to the ghost frequency.'));
    assert.ok(digest.includes('Aired a sponsor spot: [SPONSOR] Shoes.'));
  });

  await run('executeOration hands the airing its speech meta; the peace oration opts out (it remembers itself)', async () => {
    const metas = [];
    const dj = Object.create(VoiceDJ.prototype);
    Object.assign(dj, {
      _enabled: true, _isLive: () => false, _inTalkSegment: false, _speaking: false,
      _broadcast: () => {}, _rememberMonologue: () => {},
      _kannakabin: path.join(os.tmpdir(), 'no-such-kannaka-binary'),
      _generateTTS: (text, cb) => cb(null, path.join(os.tmpdir(), 'oad.wav'), text),
      _getIcecastSource: () => ({ injectAudio: (p, meta, cb) => { metas.push(meta); cb(); } }),
    });
    dj.executeOration('The buoys report calm seas.', () => {}, { persona: 'news', title: 'news broadcast', composer: 'kannaka ask via news-broadcast' });
    dj._inTalkSegment = false; dj._speaking = false;
    dj.executeOration('Peace is the work.', () => {}, { persona: 'oration', airMemory: false });
    clearTimeout(dj._talkSegmentTimer);
    assert.deepStrictEqual(metas[0].speech, { whole: true, title: 'news broadcast', composer: 'kannaka ask via news-broadcast', skip: false });
    assert.strictEqual(metas[1].speech.skip, true);
  });

  await run('peace-oration: an oration airs with airMemory:false, a showcase intro as its own memory', async () => {
    const { PeaceOration } = require(path.join(ROOT, 'server/peace-oration'));
    const seen = [];
    const o = new PeaceOration({ dataDir: tmp, broadcast: () => {}, voiceDJ: { executeOration: (t, cb, opts) => { seen.push(opts); return true; } } });
    o._say('Peace is the work.', '2026-11-07T12');
    o._say('This album began in a basement.', null, { title: 'album showcase intro: X', composer: 'kannaka ask via album showcase' });
    assert.strictEqual(seen[0].airMemory, false);
    assert.strictEqual(seen[1].airMemory, undefined);
    assert.strictEqual(seen[1].title, 'album showcase intro: X');
  });

  await run('source check: the stream reports what aired, and only what aired cleanly', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/icecast-source.js'), 'utf8');
    assert.ok(/if \(!voiceErr\) \{\s*try \{ this\._onVoiceAired\(\{ path: v\.origPath \|\| v\.path, meta: v\.meta \|\| \{\} \}\); \} catch \(_\) \{\}/.test(src));
    assert.ok(/if \(aired\) \{ try \{ this\._onTrackAired\(track\); \} catch \(_\) \{\} \}/.test(src));
    const idx = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    assert.ok(/onVoiceAired: \(voice\) => onAirDigest\.aired\(voice\)/.test(idx));
    assert.ok(/onTrackAired: \(track\) => onAirDigest\.trackAired\(track, MUSIC_DIR\)/.test(idx));
    assert.ok(/onAirDigest\.fromBroadcast\(msg\)/.test(idx));
    assert.ok(/await onAirDigest\.flushForShutdown\(/.test(idx));
    assert.ok(/voiceWriteback\.radioDataDir\(\), "on-air-digest-buffer\.jsonl"/.test(idx), 'the buffer lives in the radio data dir, not ~/.kannaka');
  });

  console.log = realLog;
  vw._reset();
  digestMod._clearRegistry();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  if (failed) { console.error(`\n${failed} on-air-digest test(s) failed`); process.exit(1); }
  console.log('all passed');
  process.exit(0);
}

main().catch((e) => { console.log = realLog; console.error(e); process.exit(1); });
