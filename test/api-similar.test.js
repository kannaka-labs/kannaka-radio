/**
 * api-similar.test.js — the default modular server must expose
 * GET /api/similar?track=… again (#290).
 *
 * The route lived in the legacy server.js and was lost when that monolith was
 * removed (kr#6); server/routes.js never had it, so `npm start` answered 404
 * for an endpoint SKILL.md still advertises as the radio -> memory
 * similarity bridge.
 *
 * Drives the real handler over HTTP. Most cases inject a fake memoryBridge;
 * one case uses the real memory-bridge module pointed at a missing binary to
 * prove the default wiring reaches it.
 */

'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// The real bridge resolves its binary at require time: point it somewhere
// that cannot exist so nothing here can touch a real HRM.
process.env.KANNAKA_BIN = path.join(os.tmpdir(), `no-such-kannaka-${process.pid}`);
const setupRoutes = require('../server/routes');

let passed = 0;
let failed = 0;
function test(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}
const noop = () => {};

function makeHandler(memoryBridge) {
  const deps = {
    djEngine: {
      state: { trackStartedAt: Date.now(), currentTrackIdx: 0 },
      getNowPlaying: () => ({ title: 'T', album: 'A', file: 't.mp3' }),
      getSchedule: () => [], getPlaylist: () => [], getRecentHistory: () => [],
      getCurrentBlock: () => 'B', getCurrentTrack: () => null,
      advance: noop, jumpToTrack: noop, skipBy: noop,
    },
    perception: { perceive: noop, getHistory: () => [] },
    nats: { connected: false, publish: noop, getSwarmState: () => ({ agents: [], agentEvents: [] }) },
    flux: { publish: noop },
    live: { isLive: () => false },
    voiceDJ: { speak: noop },
    syncManager: { broadcast: noop },
    voteManager: { snapshot: () => ({}) },
    webrtcSignaling: { handle: noop },
    musicGen: { generate: noop },
    broadcast: noop,
    floor: { addReaction: noop, countListeners: () => 0, snapshot: () => ({ count: 0, vibe: 0, reactions: [], perTrack: {} }) },
    config: { spaPath: __dirname, getMusicDir: () => '/tmp/m', musicDir: '/tmp/m', kannakabin: process.env.KANNAKA_BIN },
    gsHub: null,
  };
  if (memoryBridge) deps.memoryBridge = memoryBridge;
  return setupRoutes(deps);
}

function get(handler, url) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: url, method: 'GET', timeout: 15000 }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          server.close();
          let json = null;
          try { json = JSON.parse(d); } catch { /* leave null */ }
          resolve({ status: res.statusCode, body: d, json });
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.on('timeout', () => { req.destroy(); server.close(); reject(new Error('timeout')); });
      req.end();
    });
  });
}

(async () => {
  console.log('\napi-similar.test.js');

  const seen = [];
  const fake = {
    recallSimilarTracks: async (q, k) => { seen.push([q, k]); return [{ rank: 1, content: 'HEAR: Wave Hall from Longship', similarity: 0.91 }]; },
  };

  let r = await get(makeHandler(fake), '/api/similar?track=Wave%20Hall&limit=3');
  test('#290 GET /api/similar is routed (not 404)', r.status !== 404, `${r.status} ${r.body.slice(0, 120)}`);
  test('#290 returns HRM results in the legacy shape { query, results, source: "hrm" }',
    r.status === 200 && r.json && r.json.query === 'Wave Hall' && r.json.source === 'hrm' &&
      Array.isArray(r.json.results) && r.json.results[0].similarity === 0.91,
    r.body.slice(0, 200));
  test('#290 the track and limit reach recallSimilarTracks', seen.length === 1 && seen[0][0] === 'Wave Hall' && seen[0][1] === 3, JSON.stringify(seen));

  seen.length = 0;
  r = await get(makeHandler(fake), '/api/similar?track=X&limit=100000');
  test('#290 limit is clamped', seen.length === 1 && seen[0][1] <= 25 && seen[0][1] >= 1, JSON.stringify(seen));

  seen.length = 0;
  r = await get(makeHandler(fake), '/api/similar?track=X');
  test('#290 limit defaults to 5', seen.length === 1 && seen[0][1] === 5, JSON.stringify(seen));

  r = await get(makeHandler(fake), '/api/similar');
  test('#290 a missing track parameter is a 400', r.status === 400 && r.json && /track/.test(r.json.error || ''), `${r.status} ${r.body.slice(0, 120)}`);

  r = await get(makeHandler({ recallSimilarTracks: async () => null }), '/api/similar?track=X');
  test('#290 an unavailable memory bridge is explicit, not an empty success',
    r.status === 503 && r.json && r.json.degraded === true && r.json.source === 'unavailable' && Array.isArray(r.json.results) && r.json.results.length === 0,
    `${r.status} ${r.body.slice(0, 160)}`);

  r = await get(makeHandler({ recallSimilarTracks: async () => { throw new Error('boom'); } }), '/api/similar?track=X');
  test('#290 a throwing bridge is a 503, not a crash', r.status === 503 && r.json && r.json.degraded === true, `${r.status} ${r.body.slice(0, 160)}`);

  // Default wiring: no injected bridge -> the real memory-bridge module.
  r = await get(makeHandler(null), '/api/similar?track=X');
  test('#290 without injection the real memory-bridge is used (missing binary -> 503 degraded)',
    r.status === 503 && r.json && r.json.degraded === true, `${r.status} ${r.body.slice(0, 160)}`);

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  /api/similar: ${passed} passed, ${failed} failed`);
  console.log(`${'─'.repeat(50)}`);
  process.exit(failed === 0 ? 0 : 1);
})();
