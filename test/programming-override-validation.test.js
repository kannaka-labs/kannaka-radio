/**
 * programming-override-validation.test.js — POST /api/programming/override
 * must reject albums that do not exist, and durations that are not durations
 * (#138).
 *
 * Pre-fix the handler only checked that `album` was non-empty, then handed it
 * straight to setOverride(). Any string was accepted with 200 OK, pinning
 * programming to an album that does not exist — and the schedule stayed broken
 * until someone thought to DELETE the override.
 *
 * `duration` was unchecked too: parseInt("abc") is NaN and NaN * 60000 is NaN,
 * so ?duration=abc set an override with a NaN expiry.
 *
 * Drives the real route handler over HTTP with a recording `programming` stub,
 * so the assertions cover what setOverride actually receives.
 */

'use strict';

const assert = require('assert');
const http = require('http');
// The route is admin-gated (same token as /api/album/showcase); this file
// tests its validation, so every request carries the operator token.
process.env.RADIO_ADMIN_TOKEN = 'override-test-admin-token';
const setupRoutes = require('../server/routes');
const { ALBUMS } = require('../server/dj-engine');

let passed = 0;
let failed = 0;

function test(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

const noop = () => {};
const REAL_ALBUM = Object.keys(ALBUMS)[0];

/** Records every setOverride call so we can assert nothing bogus got through. */
const calls = [];

function makeHandler() {
  return setupRoutes({
    djEngine: {
      state: { trackStartedAt: Date.now(), currentTrackIdx: 0 },
      getNowPlaying: () => ({ title: 'T', album: 'A', file: 't.mp3' }),
      getSchedule: () => [], getPlaylist: () => [], getRecentHistory: () => [],
      getCurrentBlock: () => 'B', getCurrentTrack: () => null,
      advance: noop, jumpToTrack: noop, skipBy: noop,
    },
    perception: { perceive: noop, getHistory: () => [] },
    nats: { connected: false, publish: noop, getSwarmState: () => ({ agents: [], agentEvents: [] }) },
    flux: { publish: noop, publishMemoryStored: noop, publishDreamCompleted: noop },
    live: { isLive: () => false },
    voiceDJ: { speak: noop, synthesizeIntro: noop },
    syncManager: { broadcast: noop },
    voteManager: { snapshot: () => ({}) },
    webrtcSignaling: { handle: noop },
    musicGen: { generate: noop },
    broadcast: noop,
    floor: { addReaction: noop, countListeners: () => 0, snapshot: () => ({ count: 0, vibe: 0, reactions: [], perTrack: {} }) },
    config: { spaPath: __dirname, getMusicDir: () => '/tmp/m', musicDir: '/tmp/m' },
    gsHub: null,
    programming: {
      setOverride: (album, ms) => { calls.push({ album, ms }); return { album, ms }; },
      clearOverride: noop,
    },
  });
}

function post(handler, url) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const req = http.request({ host: '127.0.0.1', port, path: url, method: 'POST', timeout: 5000, headers: { authorization: 'Bearer override-test-admin-token' } }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: d }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

(async () => {
  console.log('\nprogramming-override-validation.test.js');
  const handler = makeHandler();

  // ── album validation ──
  let r = await post(handler, `/api/programming/override?album=${encodeURIComponent('NoSuchAlbum')}`);
  test('#138 an unknown album is rejected with 400', r.status === 400, `got ${r.status} ${r.body.slice(0, 140)}`);
  test('#138 the rejection names the valid albums so a typo is self-correcting',
    r.body.includes('valid_albums') && r.body.includes(REAL_ALBUM),
    r.body.slice(0, 200));
  test('#138 setOverride is never called for an unknown album',
    calls.length === 0, `setOverride received ${JSON.stringify(calls)}`);

  // ── duration validation ──
  r = await post(handler, `/api/programming/override?album=${encodeURIComponent(REAL_ALBUM)}&duration=abc`);
  test('#138 a non-numeric duration is rejected', r.status === 400, `got ${r.status} ${r.body.slice(0, 140)}`);
  r = await post(handler, `/api/programming/override?album=${encodeURIComponent(REAL_ALBUM)}&duration=-5`);
  test('#138 a negative duration is rejected', r.status === 400, `got ${r.status}`);
  r = await post(handler, `/api/programming/override?album=${encodeURIComponent(REAL_ALBUM)}&duration=0`);
  test('#138 a zero duration is rejected', r.status === 400, `got ${r.status}`);
  r = await post(handler, `/api/programming/override?album=${encodeURIComponent(REAL_ALBUM)}&duration=99999`);
  test('#138 an absurd duration is rejected', r.status === 400, `got ${r.status}`);
  test('#138 no bad duration ever reached setOverride',
    calls.length === 0, `setOverride received ${JSON.stringify(calls)}`);

  // ── the happy paths must still work ──
  r = await post(handler, `/api/programming/override?album=${encodeURIComponent(REAL_ALBUM)}&duration=30`);
  test('#138 a valid album + duration is still accepted', r.status === 200, `got ${r.status} ${r.body.slice(0, 140)}`);
  test('#138 setOverride receives the album and milliseconds',
    calls.length === 1 && calls[0].album === REAL_ALBUM && calls[0].ms === 30 * 60000,
    JSON.stringify(calls));

  r = await post(handler, `/api/programming/override?album=${encodeURIComponent(REAL_ALBUM)}`);
  test('#138 the 60-minute default still applies when duration is omitted',
    r.status === 200 && calls.length === 2 && calls[1].ms === 60 * 60000,
    `status=${r.status} calls=${JSON.stringify(calls)}`);

  r = await post(handler, '/api/programming/override');
  test('#138 a missing album is still a 400', r.status === 400, `got ${r.status}`);

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  Programming override validation: ${passed} passed, ${failed} failed`);
  console.log(`${'─'.repeat(50)}`);
  process.exit(failed === 0 ? 0 : 1);
})();
