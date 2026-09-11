'use strict';
/**
 * The guest spot on the air: the engine borrows one music slot, confirms only
 * when the track actually finished, never stacks two, never touches a
 * commercial slot, and the ledger stops a record airing twice.
 *
 * The last five cases are what the first live spin taught on 2026-09-11.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DJEngine } = require('../server/dj-engine');
const { GuestSpots } = require('../server/guest-spots');
const { chooseNext } = require('../server/guest-spots-core');

let failures = 0;
const pending = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => console.log(`  ok   ${name}`),
        (e) => { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); },
      ));
    } else {
      console.log(`  ok   ${name}`);
    }
  } catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-spots-'));
const spots = (n) => new GuestSpots({ base: 'http://127.0.0.1:1', token: 't', getMusicDir: () => tmp, ledgerPath: path.join(tmp, `l${n}.json`) });

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
  const confirmed = [];
  dj._confirmGuest = (id, file) => confirmed.push([id, file]);
  dj.stageGuest(SPOT);
  dj.advanceTrack('/m/h1.mp3');           // the spot is now on air
  dj.advanceTrack('/m/staged/guest.mp3'); // and it finished
  assert.deepStrictEqual(confirmed, [['ord-1', '/m/staged/guest.mp3']]);

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
  const g = spots(3);
  const small = path.join(tmp, 'small.mp3');
  fs.writeFileSync(small, 'not a song');
  assert.strictEqual(g.playable(small), false);
  assert.strictEqual(g.playable(path.join(tmp, 'nope.mp3')), false);
  const big = path.join(tmp, 'big.mp3');
  fs.writeFileSync(big, Buffer.alloc(200 * 1024));
  assert.strictEqual(g.playable(big), true);
});

test('staging copies the track into the station\'s own tree', () => {
  const g = spots(4);
  const src = path.join(tmp, 'src.mp3');
  fs.writeFileSync(src, Buffer.alloc(200 * 1024, 7));
  const staged = g.stage({ publicId: 'pidX', track: 2, file: src });
  assert.ok(staged.includes('guest-spots'));
  assert.strictEqual(fs.statSync(staged).size, 200 * 1024);
  assert.strictEqual(g.stage({ publicId: 'pidX', track: 2, file: src }), staged, 'staging twice is one copy');
});

// ── What the first live spin taught (2026-09-11) ────────────────────────
// The poller re-staged the record WHILE it was on air, and confirming deleted
// the file the duplicate then tried to read. With the file present that
// duplicate would have aired the record a second time.

test('a record on air is never staged over itself', () => {
  const dj = engineWith([SONG(1), SONG(2), SONG(3)]);
  assert.strictEqual(dj.stageGuest(SPOT), true);
  dj.advanceTrack('/m/h1.mp3');
  assert.strictEqual(dj.guestOnAir(), true);
  assert.strictEqual(dj.stageGuest({ ...SPOT }), false, 'the poller may not queue it again mid-air');
  assert.strictEqual(dj.hasPendingGuest(), false);
});

test('a record in flight is not chosen again while the studio still lists it', () => {
  const g = spots(5);
  const queue = [{ orderId: 'o-early', publicId: 'p1', album: 'A', track: 1, title: 'T', file: '/m/a.mp3', requestedAt: '2026-09-11T09:00:00Z' }];
  const pick = () => chooseNext(queue, { airedIds: new Set([...g.airedIds(), ...g.inFlight()]), now: Date.now(), playable: () => true });
  assert.strictEqual(pick().orderId, 'o-early');
  g.markInFlight('o-early');
  assert.strictEqual(pick(), null, 'staged once is staged');
  g.releaseStale(-1); // everything, however recent
  assert.strictEqual(pick().orderId, 'o-early', 'a reservation that never aired comes back');
});

test('a confirm whose file has vanished is not an airing', () => {
  const g = spots(6);
  g.markInFlight('ord-gone');
  return g.confirmAired('ord-gone', path.join(tmp, 'never-existed.mp3')).then((r) => {
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /gone at confirm/);
    assert.strictEqual(g.airedIds().has('ord-gone'), false, 'it can still come back around');
    assert.strictEqual(g.inFlight().has('ord-gone'), false, 'and it is no longer held');
  });
});

test('a confirm with the file still there counts, even when the studio cannot be told', () => {
  const g = spots(7);
  const f = path.join(tmp, 'real.mp3');
  fs.writeFileSync(f, Buffer.alloc(200 * 1024));
  return g.confirmAired('ord-real', f).then((r) => {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.told, false, 'nothing is listening on that port');
    assert.ok(g.airedIds().has('ord-real'), 'the station knows it aired regardless');
    assert.strictEqual(fs.existsSync(f), true, 'confirming never deletes what just played');
  });
});

test('staged files are swept by age, not by confirm', () => {
  const g = spots(8);
  const src = path.join(tmp, 'sweep-src.mp3');
  fs.writeFileSync(src, Buffer.alloc(200 * 1024));
  const staged = g.stage({ publicId: 'sweepme', track: 1, file: src });
  assert.strictEqual(fs.existsSync(staged), true);
  assert.ok(g.sweepStaged(-1) >= 1, 'an old one goes');
  assert.strictEqual(fs.existsSync(staged), false);
});

Promise.all(pending).then(() => {
  if (failures) { console.error(`guest-spots: ${failures} failed`); process.exit(1); }
  console.log('guest-spots: all passed');
});
