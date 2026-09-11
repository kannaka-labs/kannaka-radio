'use strict';
/**
 * The guest-spot policy: one airing per record, oldest first, a cooldown
 * between guests, and never a slot that cannot play.
 */
const assert = require('node:assert');
const { chooseNext, titleFor, spotEntry, DEFAULT_COOLDOWN_MS } = require('../server/guest-spots-core');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

const Q = [
  { orderId: 'o-late', publicId: 'p2', album: 'Second', track: 2, title: 'Later', file: '/m/b.mp3', requestedAt: '2026-09-11T10:00:00Z' },
  { orderId: 'o-early', publicId: 'p1', album: 'First', track: 1, title: 'Earlier', file: '/m/a.mp3', requestedAt: '2026-09-11T09:00:00Z' },
];
const base = { airedIds: new Set(), now: Date.parse('2026-09-11T12:00:00Z'), cooldownMs: DEFAULT_COOLDOWN_MS };

console.log('guest-spots-core');

test('the oldest request goes next', () => {
  assert.strictEqual(chooseNext(Q, base).orderId, 'o-early');
});

test('a record that already aired here is never chosen again', () => {
  const r = chooseNext(Q, { ...base, airedIds: new Set(['o-early']) });
  assert.strictEqual(r.orderId, 'o-late');
  assert.strictEqual(chooseNext(Q, { ...base, airedIds: new Set(['o-early', 'o-late']) }), null);
});

test('the cooldown holds the queue back and then lets it go', () => {
  const justAired = base.now - 10 * 60 * 1000;
  assert.strictEqual(chooseNext(Q, { ...base, lastAiredAt: justAired }), null);
  const longAgo = base.now - 2 * 60 * 60 * 1000;
  assert.strictEqual(chooseNext(Q, { ...base, lastAiredAt: longAgo }).orderId, 'o-early');
  // A station that wants guests back to back can say so.
  assert.strictEqual(chooseNext(Q, { ...base, lastAiredAt: justAired, cooldownMs: 0 }).orderId, 'o-early');
});

test('a file the station cannot play is not a slot', () => {
  const r = chooseNext(Q, { ...base, playable: (f) => f !== '/m/a.mp3' });
  assert.strictEqual(r.orderId, 'o-late');
  assert.strictEqual(chooseNext(Q, { ...base, playable: () => false }), null);
});

test('rows missing what an airing needs are ignored', () => {
  const junk = [
    { orderId: 'x', file: '/m/x.mp3' },                       // no track number
    { publicId: 'y', track: 1, file: '/m/y.mp3' },            // no order id
    { orderId: 'z', track: 1, requestedAt: '2026-01-01' },    // no file
    null,
  ];
  assert.strictEqual(chooseNext(junk, base), null);
  assert.strictEqual(chooseNext(undefined, base), null);
});

test('a guest entry borrows the slot and names itself, and is never a commercial', () => {
  const slot = { title: 'House Song', album: 'The Consciousness Series', file: '/m/house.mp3', trackNum: 3, totalTracks: 9 };
  const e = spotEntry(slot, Q[1], '/music/guest-spots/p1-1.mp3');
  assert.strictEqual(e.file, '/music/guest-spots/p1-1.mp3');
  assert.strictEqual(e.title, 'Earlier — First');
  assert.strictEqual(e.guestSpot, true);
  assert.strictEqual(e.guestOrderId, 'o-early');
  assert.ok(!e.commercial, 'a guest spot is a song, not an ad');
  assert.strictEqual(e.trackNum, 3, 'it keeps the slot it borrowed');
  assert.strictEqual(titleFor(Q[1]), 'Earlier — First');
});

if (failures) { console.error(`guest-spots-core: ${failures} failed`); process.exit(1); }
console.log('guest-spots-core: all passed');
