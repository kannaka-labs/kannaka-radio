'use strict';

// voice-dj-recorded-intro.test.js
//
// 2026-10-10: an album can ship spoken intros recorded ahead of time (ElevenLabs), kept in a
// directory BESIDE the music dir as <track.file minus extension>.mp3 with its words in a .txt.
// prepareIntro() and generateIntro() must use one when it exists, never call the LLM or TTS for
// it, copy it into the voice cache (so /audio-voice serves it), and refuse any path that would
// leave the intro directory.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

let execCalls = 0;
cp.execFile = (bin, args, opts, cb) => { execCalls++; process.nextTick(() => cb && cb(null, '', '')); return { pid: 0 }; };

const { VoiceDJ } = require(path.join(__dirname, '..', 'server', 'voice-dj'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recint-'));
const voiceDir = path.join(tmp, 'voice');
const introDir = path.join(tmp, 'recorded-intros');
fs.mkdirSync(path.join(introDir, 'Swarm Intentions'), { recursive: true });
fs.writeFileSync(path.join(introDir, 'Swarm Intentions', '04 - Quorum.mp3'), Buffer.from('ID3recorded'));
fs.writeFileSync(path.join(introDir, 'Swarm Intentions', '04 - Quorum.txt'), 'Nine voices that agree can still be one rumor.\n');
fs.writeFileSync(path.join(tmp, 'secret.mp3'), Buffer.from('ID3outside'));

const broadcasts = [];
function makeDJ(dirOpt) {
  const dj = new VoiceDJ({
    voiceDir, kannakabin: 'kannaka', broadcast: (m) => broadcasts.push(m),
    getPerception: () => ({}), getHistory: () => [], isLive: () => false, getChannel: () => 'dj',
    recordedIntroDir: dirOpt,
  });
  dj._enabled = true;
  let ttsCalls = 0;
  dj._generateTTS = (text, cb) => { ttsCalls++; cb(new Error('tts must not run for a recorded intro')); };
  dj._askKannaka = async () => { throw new Error('llm must not run for a recorded intro'); };
  dj._tts = () => ttsCalls;
  return dj;
}

let failed = 0;
let chain = Promise.resolve();
function run(name, fn) {
  chain = chain.then(fn).then(() => console.log(`  ok  ${name}`), (e) => { console.error(`  FAIL ${name}: ${e.message}`); failed++; });
}
console.log('voice-dj-recorded-intro.test.js');

const track = { file: 'Swarm Intentions/04 - Quorum.mp3', title: 'Quorum', album: 'Swarm Intentions' };

run('a recorded intro is found, its words read, and a copy lands in the voice cache', () => {
  const r = makeDJ(introDir)._recordedIntro(track);
  assert.ok(r, 'expected a recorded intro');
  assert.strictEqual(r.file, track.file);
  assert.strictEqual(r.text, 'Nine voices that agree can still be one rumor.');
  assert.strictEqual(path.dirname(r.audioPath), voiceDir);
  assert.strictEqual(fs.readFileSync(r.audioPath, 'utf8'), 'ID3recorded');
});

run('the directory may be given lazily, as a function', () => {
  assert.ok(makeDJ(() => introDir)._recordedIntro(track));
});

run('no file, no directory, or no track means no recorded intro', () => {
  const dj = makeDJ(introDir);
  assert.strictEqual(dj._recordedIntro({ file: 'Swarm Intentions/01 - Heartbeat on the Bus.mp3' }), null);
  assert.strictEqual(makeDJ(null)._recordedIntro(track), null);
  assert.strictEqual(dj._recordedIntro({}), null);
});

run('a path that leaves the intro directory is refused', () => {
  const dj = makeDJ(introDir);
  assert.strictEqual(dj._recordedIntro({ file: '../secret.mp3' }), null);
  assert.strictEqual(dj._recordedIntro({ file: '..\\secret.mp3' }), null);
});

run('prepareIntro holds the recorded intro without the LLM or TTS', async () => {
  const dj = makeDJ(introDir);
  await dj.prepareIntro(track);
  assert.ok(dj._preparedIntro, 'prepared');
  assert.strictEqual(dj._preparedIntro.file, track.file);
  assert.strictEqual(dj._tts(), 0);
});

run('generateIntro with nothing prepared serves the recorded intro, not the template', async () => {
  const dj = makeDJ(introDir);
  broadcasts.length = 0;
  await dj.generateIntro(track);
  assert.strictEqual(dj._tts(), 0, 'no TTS');
  const msg = broadcasts.find((m) => m.type === 'dj_voice');
  assert.ok(msg, 'a dj_voice message went out');
  assert.strictEqual(msg.text, 'Nine voices that agree can still be one rumor.');
  assert.ok(/^\/audio-voice\/dj_recorded_\d+\.mp3$/.test(msg.audioUrl), msg.audioUrl);
});

run('a track without a recording still falls through to the generated path', async () => {
  const dj = makeDJ(introDir);
  await dj.generateIntro({ file: 'Elsewhere/01 - Other.mp3', title: 'Other' });
  assert.strictEqual(dj._tts(), 1, 'the template path asked TTS once');
});

chain.then(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed) { console.error(`${failed} failed`); process.exit(1); }
  console.log('all passed');
});
