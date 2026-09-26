/**
 * dreams-no-fabrication.test.js — the Dreams API must not fabricate success
 * when the memory bridge fails or answers with something that is not JSON
 * (#297).
 *
 * Pre-fix, GET /api/dreams answered 200 with generated mock dreams when
 * `kannaka search` could not be spawned or printed non-JSON, and
 * POST /api/dreams/trigger answered `{ ok: true, dream: <mock> }` when
 * `kannaka dream` exited 0 without JSON — so a broken bridge looked like a
 * radio that had dreamed.
 *
 * Drives the real handler over HTTP with `config.kannakabin` pointed at small
 * stub executables (POSIX shebang scripts; skipped on win32).
 */

'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const setupRoutes = require('../server/routes');

let passed = 0;
let failed = 0;
function test(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

const noop = () => {};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dreams-nofab-'));

function stub(name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/usr/bin/env node\n${body}\n`);
  try { fs.chmodSync(p, 0o755); } catch { /* win32 */ }
  return p;
}

const MISSING = path.join(dir, 'no-such-kannaka');
const TEXT_OK = stub('kannaka-text', `process.stdout.write('dream completed but not json\\n');`);
const JSON_OK = stub('kannaka-json', `
const a = process.argv.slice(2);
if (a[0] === 'search') process.stdout.write(JSON.stringify([{ id: 'm1', content: 'real memory' }]));
else process.stdout.write(JSON.stringify({ strengthened: 2, pruned: 1 }));
`);

const ADMIN_TOKEN = 'dreams-nofab-token';
process.env.RADIO_ADMIN_TOKEN = ADMIN_TOKEN;

let broadcasts = [];
function makeHandler(bin) {
  return setupRoutes({
    djEngine: {
      state: { trackStartedAt: Date.now(), currentTrackIdx: 0 },
      getNowPlaying: () => ({ title: 'T', album: 'A', file: 't.mp3' }),
      getSchedule: () => [], getPlaylist: () => [], getRecentHistory: () => [],
      getCurrentBlock: () => 'B', getCurrentTrack: () => null,
      generateMockDream: () => ({ content: 'The ghost dreams in silence...', type: 'echo' }),
      generateMockDreams: () => ({ dreams: [{ id: 'mock-1', content: 'fake' }], generated: 'x', source: 'mock' }),
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
    broadcast: (m) => broadcasts.push(m),
    floor: { addReaction: noop, countListeners: () => 0, snapshot: () => ({ count: 0, vibe: 0, reactions: [], perTrack: {} }) },
    config: { spaPath: __dirname, getMusicDir: () => '/tmp/m', musicDir: '/tmp/m', kannakabin: bin },
    gsHub: null,
  });
}

function call(handler, method, url) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: url, method, timeout: 15000,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }, (res) => {
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

const looksHealthy = (r) => r.status === 200 && r.json && !r.json.degraded;
const hasMock = (r) => /mock-1|"fake"|ghost dreams in silence/.test(r.body);

(async () => {
  console.log('\ndreams-no-fabrication.test.js');
  if (process.platform === 'win32') {
    console.log('  (skipped: stub executables need a POSIX shebang)');
    process.exit(0);
  }

  // ── GET /api/dreams ────────────────────────────────────
  let r = await call(makeHandler(MISSING), 'GET', '/api/dreams');
  test('#297 GET /api/dreams: spawn failure is not a healthy 200', !looksHealthy(r), `${r.status} ${r.body.slice(0, 160)}`);
  test('#297 GET /api/dreams: spawn failure is flagged degraded', !!(r.json && r.json.degraded === true), r.body.slice(0, 160));
  test('#297 GET /api/dreams: spawn failure serves no fabricated dreams', !hasMock(r) && r.json && Array.isArray(r.json.dreams) && r.json.dreams.length === 0, r.body.slice(0, 160));

  r = await call(makeHandler(TEXT_OK), 'GET', '/api/dreams');
  test('#297 GET /api/dreams: non-JSON output is not a healthy 200', !looksHealthy(r), `${r.status} ${r.body.slice(0, 160)}`);
  test('#297 GET /api/dreams: non-JSON output is flagged degraded', !!(r.json && r.json.degraded === true), r.body.slice(0, 160));
  test('#297 GET /api/dreams: non-JSON output serves no fabricated dreams', !hasMock(r), r.body.slice(0, 160));

  r = await call(makeHandler(JSON_OK), 'GET', '/api/dreams');
  test('GET /api/dreams: a real JSON result is still served as 200', r.status === 200 && r.json && Array.isArray(r.json.dreams) && r.json.dreams[0].id === 'm1' && !r.json.degraded, r.body.slice(0, 160));

  // ── POST /api/dreams/trigger ───────────────────────────
  broadcasts = [];
  r = await call(makeHandler(MISSING), 'POST', '/api/dreams/trigger');
  test('#297 trigger: spawn failure answers ok:false', !!(r.json && r.json.ok === false), r.body.slice(0, 160));
  test('#297 trigger: spawn failure carries no fabricated dream', !hasMock(r) && !(r.json && (r.json.dream || r.json.fallback)), r.body.slice(0, 200));

  r = await call(makeHandler(TEXT_OK), 'POST', '/api/dreams/trigger');
  test('#297 trigger: exit 0 + non-JSON stdout is not ok:true', !!(r.json && r.json.ok === false), r.body.slice(0, 200));
  test('#297 trigger: exit 0 + non-JSON stdout carries no fabricated dream', !hasMock(r) && !(r.json && r.json.dream), r.body.slice(0, 200));
  test('#297 trigger: exit 0 + non-JSON stdout is flagged degraded', !!(r.json && r.json.degraded === true), r.body.slice(0, 200));
  test('#297 trigger: an unverified dream is not broadcast to listeners', broadcasts.length === 0, JSON.stringify(broadcasts).slice(0, 160));

  r = await call(makeHandler(JSON_OK), 'POST', '/api/dreams/trigger');
  test('trigger: a real JSON dream is still ok:true and broadcast',
    r.status === 200 && r.json && r.json.ok === true && r.json.dream && r.json.dream.strengthened === 2 && broadcasts.length === 1,
    r.body.slice(0, 160));

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  Dreams no-fabrication: ${passed} passed, ${failed} failed`);
  console.log(`${'─'.repeat(50)}`);
  process.exit(failed === 0 ? 0 : 1);
})();
