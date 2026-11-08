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
  delete process.env.KANNAKA_ON_AIR_DIGEST_HOURS;
  delete process.env.KANNAKA_ON_AIR_DIGEST_EXPIRE_DAYS;
  clock = Date.parse('2026-11-07T18:00:00.000Z');
  const file = opts.file || path.join(tmp, `buf-${++n}.jsonl`);
  // Most tests drive a one-hour period; the 4-hour default has its own test.
  return { d: new OnAirDigest({ file, now: () => clock, flushEveryMs: 60 * 60 * 1000, ...opts.digest }), file };
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

  await run('a long period is split into full digests under the 6000-char cap; no line is dropped', async () => {
    const { d } = fresh();
    for (let i = 0; i < 200; i++) d.record({ text: `Line number ${i}: ${'words '.repeat(20)}` });
    let flushes = 0;
    while (d.pending() && flushes < 20) { await d.flush('test'); flushes++; }
    assert.strictEqual(d.pending(), 0);
    assert.ok(flushes > 1, 'more than one digest');
    const all = calls.map((c) => c.args[1]).join('\n');
    for (const c of calls) {
      assert.ok(c.args[1].length <= vw.MAX_TEXT_CHARS + 400, `memory is ${c.args[1].length} chars`);
      assert.ok(!c.args[1].includes('[…truncated]') && !/more line\(s\) said/.test(c.args[1]), 'nothing cut');
    }
    for (let i = 0; i < 200; i++) assert.ok(all.includes(`Line number ${i}: `), `line ${i} kept`);
  });

  await run('a buffer holding a full digest is written before the period is up', async () => {
    const { d } = fresh();
    d.start();
    try {
      for (let i = 0; i < 60; i++) d.record({ text: `Busy hour line ${i}: ${'words '.repeat(20)}` });
      await vw.flush(1000);
      assert.ok(calls.length >= 1, 'flushed on a full buffer, not on the clock');
    } finally { d.stop(); }
  });

  await run('the default period is 4 hours (KANNAKA_ON_AIR_DIGEST_HOURS overrides); digests expire in 30 days', async () => {
    fresh();
    const file = path.join(tmp, `buf-${++n}.jsonl`);
    const d = new OnAirDigest({ file, now: () => clock });
    d.record({ text: 'Four hours of patter, one memory.' });
    clock += 61 * 60 * 1000;
    assert.strictEqual(d.maybeFlush(), null, 'not after one hour');
    clock += 3 * 60 * 60 * 1000;
    await d.maybeFlush();
    assert.strictEqual(calls.length, 1, 'after four');
    const args = calls[0].args;
    const at = args.indexOf('--expires');
    assert.ok(at > 0, args.join(' '));
    assert.strictEqual(args[at + 1], new Date(clock + 30 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
    process.env.KANNAKA_ON_AIR_DIGEST_HOURS = '2';
    process.env.KANNAKA_ON_AIR_DIGEST_EXPIRE_DAYS = '0';
    const d2 = new OnAirDigest({ file: path.join(tmp, `buf-${++n}.jsonl`), now: () => clock });
    d2.record({ text: 'Two-hour period, no expiry.' });
    clock += 2 * 60 * 60 * 1000;
    await d2.maybeFlush();
    assert.strictEqual(calls.length, 2);
    assert.ok(!calls[1].args.includes('--expires'));
    delete process.env.KANNAKA_ON_AIR_DIGEST_HOURS;
    delete process.env.KANNAKA_ON_AIR_DIGEST_EXPIRE_DAYS;
  });

  await run('a failing store backs off (15, 30, 60, 120 min), logged once per failure, and resets on success', async () => {
    const { d } = fresh();
    d.record({ text: 'Keep trying, gently.' });
    clock += 61 * 60 * 1000;
    behaviour = 'fail';
    await d.maybeFlush();
    assert.strictEqual(calls.length, 1);
    clock += 5 * 60 * 1000;
    assert.strictEqual(d.maybeFlush(), null, 'no retry 5 min later');
    clock += 10 * 60 * 1000;
    await d.maybeFlush();
    assert.strictEqual(calls.length, 2, 'retried after 15 min');
    clock += 15 * 60 * 1000;
    assert.strictEqual(d.maybeFlush(), null, 'then waits 30');
    clock += 15 * 60 * 1000;
    await d.maybeFlush();
    assert.strictEqual(calls.length, 3);
    assert.ok(logs.some((l) => /next try in 30 min/.test(l)), logs.join('\n'));
    behaviour = 'ok';
    clock += 60 * 60 * 1000;
    const r = await d.maybeFlush();
    assert.strictEqual(r.stored, true);
    assert.ok(logs.some((l) => /back-off reset/.test(l)));
    d.record({ text: 'Next period.' });
    clock += 61 * 60 * 1000;
    assert.ok(d.maybeFlush(), 'no back-off after a success');
  });

  await run('switched off, nothing is buffered; the buffer is capped either way', async () => {
    const { d, file } = fresh();
    process.env.KANNAKA_VOICE_WRITEBACK = '0';
    assert.strictEqual(d.record({ text: 'Not kept while off.' }), 'disabled');
    process.env.KANNAKA_READONLY = '1'; delete process.env.KANNAKA_VOICE_WRITEBACK;
    assert.strictEqual(d.record({ text: 'Not kept while read-only.' }), 'disabled');
    process.env.KANNAKA_VOICE_WRITEBACK = 'force';
    assert.strictEqual(d.record({ text: 'Kept under force.' }), 'buffered');
    delete process.env.KANNAKA_READONLY; delete process.env.KANNAKA_VOICE_WRITEBACK;
    assert.strictEqual(d.pending(), 1);
    for (let i = 0; i < 2100; i++) d.record({ text: `filler ${i}` });
    assert.strictEqual(d.pending(), 2000);
    assert.ok(logs.some((l) => /buffer over 2000 lines: dropped the 1 oldest/.test(l)));
    const onDisk = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.strictEqual(onDisk.length, 2000);
    assert.ok(!onDisk[0].includes('Kept under force.'), 'the oldest went first');
  });

  await run('buffered lines survive a restart and are written by the next process', async () => {
    const { d, file } = fresh();
    d.record({ text: 'Said before the restart.' });
    d.record({ text: 'Also before the restart.' });
    const d2 = new OnAirDigest({ file, now: () => clock, flushEveryMs: 60 * 60 * 1000 });
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

  await run('a restart that kills a store mid-flight loses nothing: the next process stores the digest', async () => {
    // PR #439 review: the claim used to read as "already stored" after the
    // server (and its `kannaka remember` child) died, and the restart threw
    // the buffered lines away.
    const { d, file } = fresh();
    d.record({ text: 'Said just before the deploy.' });
    behaviour = 'hang';
    d.flush('test');
    for (let k = 0; k < 20; k++) await new Promise((r) => setImmediate(r));
    assert.strictEqual(calls.length, 1, 'the store started');
    const ledger = vw.ledgerPath();
    const claim = JSON.parse(fs.readFileSync(ledger, 'utf8').trim().split('\n').pop());
    assert.strictEqual(claim.s, 'p', 'a claim, not a stored record');
    assert.strictEqual(claim.pid, process.pid);
    // The server is killed: its pid is gone. (A pid that just exited stands in.)
    const dead = await new Promise((resolve) => {
      const c = require('child_process').spawn(process.execPath, ['-e', '']);
      c.on('exit', () => resolve(c.pid));
    });
    fs.writeFileSync(ledger, JSON.stringify({ ...claim, pid: dead }) + '\n');
    assert.ok(fs.readFileSync(file, 'utf8').includes('Said just before the deploy.'), 'still on disk');
    // The restarted server.
    vw._reset(); vw._setExecFile(fakeExecFile); vw.configure({ bin: '/fake/kannaka' }); vw._setLedgerPath(ledger);
    behaviour = 'ok'; calls = [];
    const d2 = new OnAirDigest({ file, now: () => clock, flushEveryMs: 60 * 60 * 1000 });
    const r = await d2.flush('test');
    assert.strictEqual(r.stored, true, JSON.stringify(r));
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].args[1].includes('Said just before the deploy.'));
    assert.strictEqual(d2.pending(), 0);
  });

  await run('a live process still storing the same digest is waited for, not counted as stored', async () => {
    const { d } = fresh();
    d.record({ text: 'Being stored elsewhere.' });
    const key = d.build(d._take()).text.replace(/\s+/g, ' ').trim().toLowerCase();
    // Another live process (this one's pid stands in) claimed it a moment ago.
    assert.strictEqual(vw.claimLedger(key).ok, true);
    const r = await d.flush('test');
    assert.strictEqual(r.stored, false);
    assert.strictEqual(r.alreadyStored, false);
    assert.ok(/being stored by another process/.test(r.reason), r.reason);
    assert.strictEqual(d.pending(), 1, 'kept for the next try');
    assert.strictEqual(calls.length, 0);
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
    assert.ok(!/flushForShutdown/.test(idx), 'no shutdown flush: a store started at SIGTERM is killed with the server');
    assert.ok(/onAirDigest\.stop\(\);/.test(idx));
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
