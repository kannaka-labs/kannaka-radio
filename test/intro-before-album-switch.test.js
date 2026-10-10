'use strict';

// intro-before-album-switch.test.js
//
// 2026-10-10: the DJ introduced "Heartbeat on the Bus" (Swarm Intentions), then the
// 3-track rotation switched to SEVEN PORTALS and that song never aired. The intro is
// chosen from the current playlist BEFORE programming's onTrackChange runs, so
// ProgrammingSchedule.switchDueAtNextTrack() must say when the next change will
// switch albums, and index.js must skip the pre-announcement then.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProgrammingSchedule } = require('../server/programming');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchdue-'));
function make({ channel = 'dj', podcast = false } = {}) {
  const dj = { state: { channel, currentAlbum: 'X' }, loadAlbum: () => ({ file: 'x.mp3' }) };
  const p = new ProgrammingSchedule({ djEngine: dj, voiceDJ: null, broadcast() {}, broadcastState() {},
    getPodcastStatus: () => ({ podcastPlaying: podcast }), dataDir });
  p._currentBlock = p.getCurrentBlock();
  return p;
}

let failed = 0;
function run(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; } }
console.log('intro-before-album-switch.test.js');

run('two tracks into an album, the next change switches', () => {
  const p = make(); p._tracksSinceAlbumSwitch = 2;
  assert.strictEqual(p.switchDueAtNextTrack(), true);
});
run('earlier in the run, no switch is due', () => {
  const p = make(); p._tracksSinceAlbumSwitch = 0;
  assert.strictEqual(p.switchDueAtNextTrack(), false);
  p._tracksSinceAlbumSwitch = 1;
  assert.strictEqual(p.switchDueAtNextTrack(), false);
});
run('a block change at the next seam counts as a switch', () => {
  const p = make(); p._tracksSinceAlbumSwitch = 0; p._currentBlock = { label: 'some other block' };
  assert.strictEqual(p.switchDueAtNextTrack(), true);
});
run('podcast, active override or another channel: programming will not switch', () => {
  let p = make({ podcast: true }); p._tracksSinceAlbumSwitch = 2;
  assert.strictEqual(p.switchDueAtNextTrack(), false);
  p = make({ channel: 'music' }); p._tracksSinceAlbumSwitch = 2;
  assert.strictEqual(p.switchDueAtNextTrack(), false);
  p = make(); p._tracksSinceAlbumSwitch = 2; p._override = { album: 'X', until: Date.now() + 60000 };
  assert.strictEqual(p.switchDueAtNextTrack(), false);
});
run('the prediction matches what onTrackChange then does', () => {
  const p = make(); let switched = 0;
  p._switchAlbumInBlock = () => { switched++; p._tracksSinceAlbumSwitch = 0; };
  for (let i = 0; i < 7; i++) {
    const due = p.switchDueAtNextTrack();
    const before = switched;
    p.onTrackChange({ file: `t${i}.mp3` });
    assert.strictEqual(switched > before, due, `change ${i}: predicted ${due}`);
  }
});
run('index.js gates the pre-announcement on it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.ok(/switchDueAtNextTrack\(\)/.test(src) && /!switchDue\)/.test(src), 'index.js does not consult switchDueAtNextTrack');
});

fs.rmSync(dataDir, { recursive: true, force: true });
if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('all passed');
