/**
 * static-dir-sibling-prefix.test.js — the static file routes must not serve a
 * SIBLING folder whose name starts with the served folder's name.
 *
 * /audio/, /audio-voice/, /audio-generated/ and /models/ each checked
 * `resolved.startsWith(path.resolve(root))` with no trailing separator, so a
 * request for `..%2Fmusic-private%2Fsecret.mp3` resolved to
 * `<base>/music-private/secret.mp3`, which starts with `<base>/music`, and was
 * served. The check now compares against the root plus `path.sep`.
 *
 * Drives the real handler over HTTP against real temp directories.
 */

'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const setupRoutes = require('../server/routes');

let passed = 0;
let failed = 0;
process.exitCode = 1;
function test(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}
const noop = () => {};

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'static-prefix-'));
const dirs = {
  music: path.join(base, 'music'),
  voice: path.join(base, 'voice'),
  gen: path.join(base, 'gen'),
  models: path.join(base, 'workspace', 'models'),
};
for (const d of Object.values(dirs)) {
  fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(d + '-private', { recursive: true });
  fs.writeFileSync(path.join(d + '-private', 'secret.mp3'), 'SECRET');
  fs.writeFileSync(path.join(d, 'ok.mp3'), 'PUBLIC');
}

const handler = setupRoutes({
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
  musicGen: { generate: noop, outputDir: dirs.gen },
  broadcast: noop,
  floor: { addReaction: noop, countListeners: () => 0, snapshot: () => ({ count: 0, vibe: 0, reactions: [], perTrack: {} }) },
  config: {
    spaPath: __dirname, baseDir: base, voiceDir: dirs.voice,
    getMusicDir: () => dirs.music, musicDir: dirs.music,
  },
  gsHub: null,
});

function get(url) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: url, method: 'GET', timeout: 5000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.on('timeout', () => { req.destroy(); server.close(); reject(new Error('timeout')); });
      req.end();
    });
  });
}

(async () => {
  console.log('\nstatic-dir-sibling-prefix.test.js');

  const routes = [
    ['/audio/', 'music'],
    ['/audio-voice/', 'voice'],
    ['/audio-generated/', 'gen'],
    ['/models/', 'models'],
  ];
  for (const [prefix, name] of routes) {
    const sibling = encodeURIComponent(`../${name}-private/secret.mp3`);
    const r = await get(prefix + sibling);
    test(`${prefix} refuses the sibling folder ${name}-private/`,
      r.status === 403 && !r.body.includes('SECRET'), `${r.status} ${r.body.slice(0, 60)}`);

    const ok = await get(prefix + 'ok.mp3');
    test(`${prefix} still serves a file inside its own folder`,
      ok.status === 200 && ok.body === 'PUBLIC', `${ok.status} ${ok.body.slice(0, 60)}`);

    const up = await get(prefix + encodeURIComponent('../../etc/passwd'));
    test(`${prefix} still refuses a plain traversal`, up.status === 403, `${up.status}`);
  }

  fs.rmSync(base, { recursive: true, force: true });
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  static sibling prefix: ${passed} passed, ${failed} failed`);
  console.log(`${'─'.repeat(50)}`);
  process.exitCode = failed === 0 ? 0 : 1;
})().catch((e) => { console.error(e); process.exit(1); });
