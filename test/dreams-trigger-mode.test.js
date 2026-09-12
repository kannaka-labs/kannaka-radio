/**
 * dreams-trigger-mode.test.js — POST /api/dreams/trigger must not silently run
 * a full deep dream (#152).
 *
 * The route invoked `kannaka dream --include-audio`. That flag has never
 * existed: the CLI's arg loop ends in `else { i += 1 }`, so unknown flags are
 * dropped, and `dream_mode` then defaults to "deep". So every call kicked off a
 * FULL deep annealing pass — dream-cron.sh budgets 30 minutes for that, against
 * this route's 60s execFile timeout — which reliably timed out and answered
 * with a mock dream while the real dream ran on unattended.
 *
 * Drives the real handler over HTTP with `config.kannakabin` pointed at a
 * recorder, so the assertions cover the argv the binary actually receives.
 */

'use strict';

const assert = require('assert');
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

// A "binary" that records its argv and prints a JSON dream. Node runs it, so
// this works on any platform without a shell script.
const recordDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-argv-'));
const ARGV_LOG = path.join(recordDir, 'argv.json');
// On POSIX a shebang script IS the executable, so execFile(bin, ["dream", ...])
// hands it exactly the argv routes.js chose — which is the thing under test.
// Windows cannot exec a shebang script, so there the argv assertions fall back
// to reading the source (noted per-assertion).
const CAN_CAPTURE_ARGV = process.platform !== 'win32';
const RECORDER = path.join(recordDir, 'kannaka-recorder');
fs.writeFileSync(RECORDER, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(ARGV_LOG)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ dream: 'ok', strengthened: 1 }));
`);
try { fs.chmodSync(RECORDER, 0o755); } catch { /* win32 */ }

/** argv the route passed, or — on win32 — parsed out of routes.js source. */
function argvOrSource() {
  if (CAN_CAPTURE_ARGV) return lastArgv();
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes.js'), 'utf8');
  // Anchor on the DREAM invocation specifically — routes.js has other
  // execFile(config.kannakabin, ...) calls (e.g. the /api/dreams search).
  const m = src.match(/execFile\(config\.kannakabin,\s*\[\s*"dream"([^\]]*)\]/);
  if (!m) return null;
  return ('dream' + m[1]).replace(/["'\s]/g, '').split(',').filter(Boolean);
}

function lastArgv() {
  try { return JSON.parse(fs.readFileSync(ARGV_LOG, 'utf8')); } catch { return null; }
}

function makeHandler() {
  return setupRoutes({
    djEngine: {
      state: { trackStartedAt: Date.now(), currentTrackIdx: 0 },
      getNowPlaying: () => ({ title: 'T', album: 'A', file: 't.mp3' }),
      getSchedule: () => [], getPlaylist: () => [], getRecentHistory: () => [],
      getCurrentBlock: () => 'B', getCurrentTrack: () => null,
      generateMockDream: () => ({ mock: true }),
      generateMockDreams: () => [{ mock: true }],
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
    // execFile(kannakabin, ["dream", ...]) → node recorder.js dream ...
    config: { spaPath: __dirname, getMusicDir: () => '/tmp/m', musicDir: '/tmp/m', kannakabin: RECORDER },
    gsHub: null,
  });
}

// /api/dreams/trigger is operator-only: it is gated on RADIO_ADMIN_TOKEN and
// answers 503 when that is unset, 401 without the header. That gate is pinned
// by admin-trigger-gate.test.js; this file is about which dream MODE runs, so
// it authenticates and goes on testing the thing it is named after.
const ADMIN_TOKEN = 'dreams-mode-test-token';
process.env.RADIO_ADMIN_TOKEN = ADMIN_TOKEN;

function post(handler, url) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const req = http.request({ host: '127.0.0.1', port, path: url, method: 'POST', timeout: 15000,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: d }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.on('timeout', () => { req.destroy(); server.close(); reject(new Error('timeout')); });
      req.end();
    });
  });
}

(async () => {
  console.log('\ndreams-trigger-mode.test.js');
  const handler = makeHandler();

  // execFile runs `node <args>`; prepend the recorder so node executes it.
  // routes.js passes ["dream", "--mode", <mode>] — we assert on those.
  const origArgv = process.argv;

  let r = await post(handler, '/api/dreams/trigger');
  let argv = argvOrSource();
  // Weak form of this assertion ("no --mode deep") passes on the buggy argv
  // too, because the bug is the ABSENCE of --mode: the CLI then defaults to
  // deep. So require the mode to be stated, never inherited.
  test('#152 the mode is always stated explicitly, never left to the CLI default',
    argv !== null && argv.includes('--mode'),
    `argv=${JSON.stringify(argv)} — without --mode, kannaka dream defaults to deep`);
  test('#152 the default trigger asks for the lite pass explicitly',
    argv !== null && argv.includes('--mode') &&
      (CAN_CAPTURE_ARGV ? argv[argv.indexOf('--mode') + 1] === 'lite' : true),
    `argv=${JSON.stringify(argv)}`);
  test('#152 the nonexistent --include-audio flag is gone',
    argv !== null && !argv.includes('--include-audio'),
    `argv=${JSON.stringify(argv)} — the CLI silently drops unknown flags, which is how this hid`);
  test('#152 the response reports which mode ran',
    r.status === 200 && r.body.includes('"mode":"lite"'), `${r.status} ${r.body.slice(0, 160)}`);

  r = await post(handler, '/api/dreams/trigger?mode=deep');
  argv = argvOrSource();
  test('#152 ?mode=deep is still available when asked for explicitly',
    CAN_CAPTURE_ARGV
      ? (argv !== null && argv.includes('--mode') && argv[argv.indexOf('--mode') + 1] === 'deep')
      : r.status === 200 && r.body.includes('"mode":"deep"'),
    `argv=${JSON.stringify(argv)} body=${r.body.slice(0, 120)}`);

  r = await post(handler, '/api/dreams/trigger?mode=sideways');
  test('#152 an unknown mode is rejected rather than silently defaulting',
    r.status === 400, `got ${r.status} ${r.body.slice(0, 160)}`);

  process.argv = origArgv;
  try { fs.rmSync(recordDir, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  Dreams trigger mode: ${passed} passed, ${failed} failed`);
  console.log(`${'─'.repeat(50)}`);
  process.exit(failed === 0 ? 0 : 1);
})();
