'use strict';
/**
 * track-request-route.test.js — POST /api/request is open, and bounded.
 *
 * Asking for a song should not need a credential; that is the point of the
 * endpoint. What it did need was a floor. Before this, an empty POST answered
 * 200, and there was no limit at all on how many a single caller could send —
 * each one broadcast to every connected listener and pushed into a 500-entry
 * in-memory log, so a flood rolled genuine requests out of it.
 */

const http = require('http');
const assert = require('node:assert');
const setupRoutes = require('../server/routes');

function noop() {}

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
    } else { console.log(`  ok   ${name}`); }
  } catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

/** A handler plus the list of everything it pushed at listeners. */
function makeStation() {
  const broadcasts = [];
  const handler = setupRoutes({
    djEngine: {
      state: { trackStartedAt: Date.now(), currentTrackIdx: 0 },
      getNowPlaying: () => ({ title: 'T', album: 'A', file: 't.mp3' }),
      getSchedule: () => [], getPlaylist: () => [], getRecentHistory: () => [],
      getCurrentBlock: () => 'B', advance: noop, jumpToTrack: noop, skipBy: noop,
    },
    perception: { perceive: noop, getHistory: () => [] },
    nats: { connected: false, publish: noop },
    flux: { publish: noop, publishMemoryStored: noop, publishDreamCompleted: noop },
    live: { isLive: () => false },
    voiceDJ: { speak: noop, synthesizeIntro: noop },
    syncManager: { broadcast: noop },
    voteManager: { snapshot: () => ({}) },
    webrtcSignaling: { handle: noop },
    musicGen: { generate: noop },
    broadcast: (m) => { broadcasts.push(m); },
    floor: { addReaction: noop, countListeners: () => 0, snapshot: () => ({ count: 0, vibe: 0, reactions: [], perTrack: {} }) },
    config: { spaPath: __dirname, getMusicDir: () => '/tmp/music-test', musicDir: '/tmp/music-test' },
    gsHub: null,
  });
  return { handler, broadcasts };
}

function post(handler, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const req = http.request({
        host: '127.0.0.1', port, path: '/api/request', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end(payload);
    });
  });
}

console.log('track-request-route');

test('a genuine request still works without any credential', async () => {
  const { handler, broadcasts } = makeStation();
  const r = await post(handler, { from: 'rogue-agent', trackTitle: 'Ghost Signal' }, { 'x-forwarded-for': '10.0.0.1' });
  assert.strictEqual(r.status, 200, r.body);
  assert.ok(JSON.parse(r.body).ok);
  assert.strictEqual(broadcasts.length, 1, 'listeners are told');
  assert.strictEqual(broadcasts[0].from, 'rogue-agent');
});

test('an empty body is a 400, and nothing reaches the listeners', async () => {
  const { handler, broadcasts } = makeStation();
  const r = await post(handler, {}, { 'x-forwarded-for': '10.0.0.2' });
  assert.strictEqual(r.status, 400, r.body);
  assert.match(JSON.parse(r.body).error, /trackTitle or a message/);
  assert.strictEqual(broadcasts.length, 0, 'an empty request must not be broadcast');
});

test('a body that is not JSON is a 400, not a 500', async () => {
  const { handler } = makeStation();
  const r = await post(handler, 'not json at all', { 'x-forwarded-for': '10.0.0.3' });
  assert.strictEqual(r.status, 400, r.body);
  assert.match(JSON.parse(r.body).error, /JSON/);
});

test('a control character never reaches a listener', async () => {
  const { handler, broadcasts } = makeStation();
  const r = await post(handler,
    { from: 'a' + String.fromCharCode(10) + 'STATION', trackTitle: 'x' },
    { 'x-forwarded-for': '10.0.0.4' });
  assert.strictEqual(r.status, 200, r.body);
  assert.strictEqual(broadcasts[0].from, 'a STATION');
});

test('an over-long message is refused and not broadcast', async () => {
  const { handler, broadcasts } = makeStation();
  const r = await post(handler, { from: 'x', message: 'z'.repeat(5000) }, { 'x-forwarded-for': '10.0.0.5' });
  assert.strictEqual(r.status, 400, r.body);
  assert.strictEqual(broadcasts.length, 0);
});

test('one caller cannot flood the log or the listeners', async () => {
  const { handler, broadcasts } = makeStation();
  const ip = { 'x-forwarded-for': '10.9.9.9' };
  let limited = 0;
  let accepted = 0;
  for (let i = 0; i < 30; i++) {
    const r = await post(handler, { from: 'flood', trackTitle: `t${i}` }, ip);
    if (r.status === 429) limited++;
    else if (r.status === 200) accepted++;
  }
  assert.ok(limited > 0, 'the flood must be refused at some point');
  assert.ok(accepted <= 20, `at most the per-window allowance got through, saw ${accepted}`);
  assert.strictEqual(broadcasts.length, accepted, 'a refused request broadcasts nothing');
});

test('a different caller is not punished for the flooder', async () => {
  const { handler } = makeStation();
  const flood = { 'x-forwarded-for': '10.9.9.10' };
  for (let i = 0; i < 25; i++) await post(handler, { from: 'flood', trackTitle: `t${i}` }, flood);
  const r = await post(handler, { from: 'someone-else', trackTitle: 'Ghost Signal' }, { 'x-forwarded-for': '10.9.9.11' });
  assert.strictEqual(r.status, 200, `a second listener should still be served: ${r.body}`);
});

Promise.all(pending).then(() => {
  if (failures) { console.error(`track-request-route: ${failures} failed`); process.exit(1); }
  console.log('track-request-route: all passed');
});
