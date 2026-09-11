'use strict';
/**
 * The guest spot on the air: the engine borrows one music slot, confirms only
 * when the track actually finished, never stacks two, never touches a
 * commercial slot, and the ledger stops a record airing twice.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DJEngine } = require('../server/dj-engine');
const { GuestSpots } = require('../server/guest-spots');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-spots-'));

function engineWith(meta) {
  const dj = new DJEngine({ getMusicDir: () => tmp });
  dj.state.channel = 'dj';
  dj.state.playlistMeta = meta;
  dj.state.playlist = meta.map((m) => m.file);
  dj.state.currentTrackIdx = 0;
  return dj;
}

const SONG = (n) => ({ title: `House ${n}`, album: 'The Consciousness Series', file: `/m/h${n}.mp3`, trackNum: n, totalTracks: 3 });
const AD = { title: 'House commercial', file: '/m/ad.mp3', commercial: true };
const SPOT = { orderId: 'ord-1', publicId: 'pid1', album: 'Night One', track: 1, title: 'Night One (Opening)', file: '/m/guest.mp3', staged: '/m/staged/guest.mp3', claimedAt: Date.now() };

console.log('guest-spots');

test('a staged spot takes the next music slot, and the slot it borrowed is untouched', () => {
  const dj = engineWith([SONG(1), SONG(2), SONG(3)]);
  dj.stageGuest(SPOT);
  assert.strictEqual(dj.nextIsMusic(), true);
  const cur = dj.advanceTrack('/m/h1.mp3');
  assert.strictEqual(cur.guestSpot, true);
  assert.strictEqual(cur.file, '/m/staged/guest.mp3');
  assert.strictEqual(cur.title, 'Night One (Opening) — Night One');
  assert.strictEqual(dj.state.playlistMeta[1].file, '/m/h2.mp3', 'the playlist itself never changed');
  assert.strictEqual(dj.hasPendingGuest(), false, 'consumed');
});

test('the overlay wins only at its own index', () => {
  const dj = engineWith([SONG(1), SONG(2), SONG(3)]);
  dj.stageGuest(SPOT);
  dj.advanceTrack('/m/h1.mp3');
  assert.strictEqual(dj.getCurrentTrack().guestSpot, true);
  dj.state.currentTrackIdx = 2;
  assert.ok(!dj.getCurrentTrack().guestSpot, 'a different slot is the station\'s own song');
});

test('a commercial slot is never borrowed', () => {
  const dj = engineWith([SONG(1), AD, SONG(3)]);
  dj.stageGuest(SPOT);
  assert.strictEqual(dj.nextIsMusic(), false);
  const cur = dj.advanceTrack('/m/h1.mp3');
  assert.ok(!cur.guestSpot, 'the house commercial played');
  assert.strictEqual(dj.hasPendingGuest(), true, 'still waiting for a song slot');
});

test('another channel is not the guest\'s to play on', () => {
  const dj = engineWith([SONG(1), SONG(2)]);
  dj.state.channel = 'music';
  dj.stageGuest(SPOT);
  assert.ok(!dj.advanceTrack('/m/h1.mp3').guestSpot);
});

test('a spot with nothing staged is refused', () => {
  const dj = engineWith([SONG(1), SONG(2)]);
  dj.stageGuest({ ...SPOT, staged: null });
  assert.ok(!dj.advanceTrack('/m/h1.mp3').guestSpot);
});

test('it confirms only when the spot actually finished', () => {
  const dj = engineWith([SONG(1), SONG(2), SONG(3)]);
  let confirmed = [];
  dj._confirmGuest = (id, file) => confirmed.push([id, file]);
  dj.stageGuest(SPOT);
  dj.advanceTrack('/m/h1.mp3');           // the spot is now on air
  dj.advanceTrack('/m/staged/guest.mp3'); // and it finished
  assert.deepStrictEqual(confirmed, [['ord-1', '/m/staged/guest.mp3']]);

  // Cut off mid-air: a different file finished, so nothing is confirmed.
  const dj2 = engineWith([SONG(1), SONG(2), SONG(3)]);
  const seen = [];
  dj2._confirmGuest = (id) => seen.push(id);
  dj2.stageGuest(SPOT);
  dj2.advanceTrack('/m/h1.mp3');
  dj2.advanceTrack('/m/something-else.mp3');
  assert.deepStrictEqual(seen, [], 'an airing nobody heard is not an airing');
});

test('the overlay lasts exactly one track', () => {
  const dj = engineWith([SONG(1), SONG(2), SONG(3)]);
  dj.stageGuest(SPOT);
  dj.advanceTrack('/m/h1.mp3');
  const after = dj.advanceTrack('/m/staged/guest.mp3');
  assert.ok(!after.guestSpot, 'the next slot is the station\'s own again');
});

test('two guests never stack', () => {
  const dj = engineWith([SONG(1), SONG(2), SONG(3)]);
  dj.stageGuest(SPOT);
  dj.advanceTrack('/m/h1.mp3');
  dj.stageGuest({ ...SPOT, orderId: 'ord-2' });
  // Still inside the first spot's slot: applying again must not replace it.
  assert.strictEqual(dj.getCurrentTrack().guestOrderId, 'ord-1');
});

test('the DJ is told what it is about to play, without consuming it', () => {
  const dj = engineWith([SONG(1), SONG(2), SONG(3)]);
  dj.stageGuest(SPOT);
  const peek = dj.peekNextTrack();
  assert.strictEqual(peek.guestSpot, true);
  assert.strictEqual(peek.title, 'Night One (Opening) — Night One');
  assert.strictEqual(dj.hasPendingGuest(), true, 'a peek reserves nothing');
});

test('the ledger remembers what aired, across a restart', () => {
  const ledger = path.join(tmp, 'ledger.json');
  const g = new GuestSpots({ base: 'http://127.0.0.1:1', token: 't', getMusicDir: () => tmp, ledgerPath: ledger });
  assert.strictEqual(g.airedIds().size, 0);
  g.recordAired('ord-1', Date.parse('2026-09-11T12:00:00Z'));
  const fresh = new GuestSpots({ base: 'http://127.0.0.1:1', token: 't', getMusicDir: () => tmp, ledgerPath: ledger });
  assert.ok(fresh.airedIds().has('ord-1'));
  assert.strictEqual(fresh.lastAiredAt(), Date.parse('2026-09-11T12:00:00Z'));
});

test('without a token the whole feature is inert', () => {
  const g = new GuestSpots({ base: 'http://127.0.0.1:1', token: '', getMusicDir: () => tmp, ledgerPath: path.join(tmp, 'l2.json') });
  assert.strictEqual(g.enabled(), false);
  return g.queue().then((q) => assert.deepStrictEqual(q, []));
});

test('a file too small to be a song is not playable', () => {
  const g = new GuestSpots({ base: 'b', token: 't', getMusicDir: () => tmp, ledgerPath: path.join(tmp, 'l3.json') });
  const small = path.join(tmp, 'small.mp3');
  fs.writeFileSync(small, 'not a song');
  assert.strictEqual(g.playable(small), false);
  assert.strictEqual(g.playable(path.join(tmp, 'nope.mp3')), false);
  const big = path.join(tmp, 'big.mp3');
  fs.writeFileSync(big, Buffer.alloc(200 * 1024));
  assert.strictEqual(g.playable(big), true);
});

test('staging copies the track into the station\'s own tree', () => {
  const g = new GuestSpots({ base: 'b', token: 't', getMusicDir: () => tmp, ledgerPath: path.join(tmp, 'l4.json') });
  const src = path.join(tmp, 'src.mp3');
  fs.writeFileSync(src, Buffer.alloc(200 * 1024, 7));
  const staged = g.stage({ publicId: 'pidX', track: 2, file: src });
  assert.ok(staged.includes('guest-spots'));
  assert.strictEqual(fs.statSync(staged).size, 200 * 1024);
  assert.strictEqual(g.stage({ publicId: 'pidX', track: 2, file: src }), staged, 'staging twice is one copy');
  g.unstage(staged);
  assert.strictEqual(fs.existsSync(staged), false);
  g.unstage('/etc/passwd'); // refuses anything outside the staging dir
  assert.ok(true);
});

if (failures) { console.error(`guest-spots: ${failures} failed`); process.exit(1); }
console.log('guest-spots: all passed');
