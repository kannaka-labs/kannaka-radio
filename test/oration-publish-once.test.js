'use strict';
/**
 * oration-publish-once.test.js — one slot, one publication.
 *
 * Queueing the oration's audio and publishing its text are different
 * promises. releaseInFlightSlot hands a slot back when the audio never
 * reached a listener (#54) so its window can retry — but by then the Bluesky
 * teaser and the OpenClawCity artifact have already gone out, and OBC has no
 * delete route for an artifact.
 *
 * Before the fix, a release inside the window re-composed and re-published,
 * and the city received two different ~3,000-word orations about seven
 * minutes apart under one title and one date. It happened four times:
 * noon on 2026-09-09, -10 and -11, and midnight on 2026-09-12. The trigger
 * in the journal was a restart draining the voice queue mid-window, not a
 * bare TTS failure — which is why the guard has to live on disk.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PeaceOration } = require('../server/peace-oration');

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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oration-once-'));

// 17:05 UTC on a September day is 12:05 in Chicago: hour 12, minute 5, inside
// the 0..14 retry window the scheduler fires in.
const FAKE_NOW = new Date('2026-09-13T17:05:00Z');
const SLOT = '2026-09-13T12';
const RealDate = Date;
function freezeClock() {
  global.Date = class extends RealDate {
    constructor(...args) { return args.length ? new RealDate(...args) : new RealDate(FAKE_NOW); }
    static now() { return FAKE_NOW.getTime(); }
  };
}
function thawClock() { global.Date = RealDate; }

/**
 * A PeaceOration wired to stubs: a voice DJ that accepts and never calls
 * back (the audio is "queued", which is all _tick waits for), and recorders
 * in place of the two outbound publishers.
 */
function makeOration(composeText) {
  const posts = { bluesky: [], obc: [] };
  const aired = [];
  const o = new PeaceOration({
    dataDir,
    voiceDJ: {
      executeOration(text) { aired.push(text); return true; },
    },
    broadcast: { post: async () => ({ ok: true }) },
  });
  o._compose = () => Promise.resolve(composeText);
  o._postToBluesky = async (t) => { posts.bluesky.push(t); };
  o._postToOpenClawCity = async (t) => { posts.obc.push(t); };
  return { o, posts, aired };
}

console.log('oration-publish-once');

test('a slot publishes once, however many times its audio is retried', async () => {
  freezeClock();
  try {
    const { o, posts, aired } = makeOration('FIRST ORATION');
    await o._tick();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(posts.obc.length, 1, 'published to the city once');
    assert.strictEqual(posts.bluesky.length, 1);
    assert.strictEqual(aired.length, 1);
    assert.ok(o._lastFired[SLOT], 'slot recorded as fired');

    // The audio never reached a listener, so the slot is handed back.
    assert.strictEqual(o.releaseInFlightSlot('tts-failed'), SLOT);
    assert.ok(!o._lastFired[SLOT], 'slot is available to its window again');

    await o._tick();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(aired.length, 2, 'the retry does put it back on air');
    assert.strictEqual(posts.obc.length, 1, 'and does NOT publish a second artifact');
    assert.strictEqual(posts.bluesky.length, 1);
  } finally { thawClock(); }
});

test('the retry airs the oration that was published, not a new one', async () => {
  freezeClock();
  try {
    const { o, aired } = makeOration('FIRST ORATION');
    await o._tick();
    await new Promise((r) => setImmediate(r));
    o.releaseInFlightSlot('tts-failed');
    o._compose = () => Promise.resolve('A SECOND ORATION');
    await o._tick();
    await new Promise((r) => setImmediate(r));
    assert.ok(aired[1].includes('FIRST ORATION'), 'same text back on air');
    assert.ok(!aired[1].includes('A SECOND ORATION'), 'compose was not called again');
  } finally { thawClock(); }
});

test('a restart mid-window does not republish, and re-airs the same text', async () => {
  freezeClock();
  try {
    const first = makeOration('THE PUBLISHED ORATION');
    await first.o._tick();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(first.posts.obc.length, 1);
    // Shutdown drains the voice queue and hands the slot back (#54). This is
    // what actually happened on 2026-09-12 at 05:07.
    first.o.releaseInFlightSlot('shutdown:no-voice-in-flight');

    // A NEW process on the same data dir. Nothing in memory survives.
    const second = makeOration('AN ENTIRELY NEW ORATION');
    assert.ok(second.o._published[SLOT], 'the publication mark survived the restart');
    await second.o._tick();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(second.posts.obc.length, 0, 'the city is not given a second one');
    assert.strictEqual(second.posts.bluesky.length, 0);
    assert.strictEqual(second.aired.length, 1, 'but the oration still airs');
    assert.ok(second.aired[0].includes('THE PUBLISHED ORATION'),
      'and it is the oration the city already holds');
  } finally { thawClock(); }
});

test('the next slot is a new publication', async () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'oration-once-b-'));
  const o = new PeaceOration({ dataDir: dir2, voiceDJ: { executeOration: () => true } });
  const obc = [];
  o._postToBluesky = async () => {};
  o._postToOpenClawCity = async (t) => { obc.push(t); };
  o._publishOnce('2026-09-13T12', 'noon');
  o._publishOnce('2026-09-13T12', 'noon again');
  o._publishOnce('2026-09-14T00', 'midnight');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(obc, ['noon', 'midnight']);
});

test('the publication ledger is written before the posts go out', () => {
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'oration-once-c-'));
  const o = new PeaceOration({ dataDir: dir3, voiceDJ: { executeOration: () => true } });
  let ledgerOnDiskWhenPosting = null;
  const ledger = path.join(dir3, 'peace-oration-published.json');
  o._postToBluesky = async () => {};
  o._postToOpenClawCity = async () => {};
  const realPost = o._postToBluesky;
  o._postToBluesky = async (t) => {
    ledgerOnDiskWhenPosting = fs.existsSync(ledger);
    return realPost(t);
  };
  o._publishOnce('2026-09-13T12', 'text');
  assert.strictEqual(ledgerOnDiskWhenPosting, true,
    'a crash between the mark and the post must cost a miss, never a duplicate');
});

Promise.all(pending).then(() => {
  if (failures) { console.error(`oration-publish-once: ${failures} failed`); process.exit(1); }
  console.log('oration-publish-once: all passed');
});
