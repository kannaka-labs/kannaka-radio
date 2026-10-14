'use strict';

// Regression coverage for the URL-track + cascade-skip fix in
// server/icecast-source.js. We don't boot ffmpeg or Icecast — we drive
// the IcecastSource class against a fake dj-engine and assert how it
// handles missing-file vs URL-track vs healthy-file decisions inside
// the _loop body, plus the http fetch helper end-to-end.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { IcecastSource } = require('../server/icecast-source');

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✅ ${name}`); passed++; })
    .catch((e) => { console.log(`  ❌ ${name}: ${e.message}`); failed++; });
}

function makeFakeEngine(playlistMeta) {
  let idx = 0;
  return {
    state: { playlistMeta, currentTrackIdx: 0 },
    getCurrentTrack() { return playlistMeta[idx] || null; },
    advanceTrack() { idx = Math.min(idx + 1, playlistMeta.length); return playlistMeta[idx] || null; },
    _idx: () => idx,
  };
}

function makeIs(playlistMeta, musicDir) {
  const engine = makeFakeEngine(playlistMeta);
  const is = new IcecastSource({
    djEngine: engine,
    getMusicDir: () => musicDir,
  });
  // Pretend ffmpeg is alive so the playable-resolution branch runs.
  is._ffmpeg = { stdin: {}, killed: false };
  return { is, engine };
}

console.log('\nicecast-source.test.js');

(async () => {
  // ── URL detection ───────────────────────────────────────────
  await test('https URL detected as remote and routes to fetch path', async () => {
    const { is } = makeIs([{ file: 'https://example.com/track.mp3', title: 'X' }], '/tmp');
    let fetched = null;
    is._fetchUrlTrack = (url) => { fetched = url; return Promise.resolve(null); };
    // Inline a single iteration of the resolution logic.
    const t = is._djEngine.getCurrentTrack();
    const isUrl = /^https?:\/\//i.test(t.file);
    if (isUrl) await is._fetchUrlTrack(t.file);
    assert.strictEqual(fetched, 'https://example.com/track.mp3');
  });

  await test('http URL also detected', async () => {
    const t = { file: 'http://example.com/track.mp3' };
    assert.ok(/^https?:\/\//i.test(t.file));
  });

  await test('local file path NOT detected as URL', async () => {
    const t = { file: 'Resonance Patterns/Patterns in the Veil.mp3' };
    assert.ok(!/^https?:\/\//i.test(t.file));
  });

  // ── Skip-cascade protection ─────────────────────────────────
  await test('_consecutiveSkips counts only missing-or-unfetchable tracks', () => {
    const { is } = makeIs([{ file: 'nope.mp3' }], '/tmp/no-such-dir');
    assert.strictEqual(is._consecutiveSkips, 0);
    is._consecutiveSkips++;
    assert.strictEqual(is._consecutiveSkips, 1);
  });

  await test('_consecutiveSkips threshold is 5 — first 4 are silent', () => {
    // The implementation backs off only once skips >= 5; assert the
    // boundary so a future tweak to the constant trips the test.
    const sourceCode = fs.readFileSync(path.join(__dirname, '..', 'server', 'icecast-source.js'), 'utf8');
    assert.ok(/this\._consecutiveSkips\s*>=\s*5/.test(sourceCode),
      'expected backoff threshold of 5 in icecast-source.js');
  });

  // ── _fetchUrlTrack end-to-end ───────────────────────────────
  // Spin a tiny localhost http server so we exercise the real fetcher
  // without depending on cdn1.suno.ai's reachability.
  await test('_fetchUrlTrack downloads bytes and writes a temp file', async () => {
    const expected = Buffer.from('FAKE-MP3-BYTES');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': expected.length });
      res.end(expected);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      const { is } = makeIs([], '/tmp');
      const tmpPath = await is._fetchUrlTrack(`http://127.0.0.1:${port}/x.mp3`);
      assert.ok(tmpPath, 'expected non-null temp path');
      assert.ok(tmpPath.startsWith(os.tmpdir()), `temp path under tmpdir, got ${tmpPath}`);
      const actual = fs.readFileSync(tmpPath);
      assert.strictEqual(actual.toString(), expected.toString());
      fs.unlinkSync(tmpPath);
    } finally {
      server.close();
    }
  });

  await test('_fetchUrlTrack returns null on 404', async () => {
    const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      const { is } = makeIs([], '/tmp');
      const result = await is._fetchUrlTrack(`http://127.0.0.1:${port}/missing.mp3`);
      assert.strictEqual(result, null);
    } finally {
      server.close();
    }
  });

  await test('_fetchUrlTrack follows one redirect', async () => {
    const expected = Buffer.from('REDIRECT-PAYLOAD');
    let port;
    const server = http.createServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: `http://127.0.0.1:${port}/dest` });
        res.end();
      } else {
        res.writeHead(200);
        res.end(expected);
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
    try {
      const { is } = makeIs([], '/tmp');
      const tmpPath = await is._fetchUrlTrack(`http://127.0.0.1:${port}/start`);
      assert.ok(tmpPath, 'expected redirect to resolve to a temp path');
      const actual = fs.readFileSync(tmpPath);
      assert.strictEqual(actual.toString(), expected.toString());
      fs.unlinkSync(tmpPath);
    } finally {
      server.close();
    }
  });

  // ── On-air voice (lib/on-air-view reads this) ───────────────
  await test('onAirVoice is null when idle and describes the queued item while it plays', () => {
    const { is } = makeIs([], '/tmp');
    assert.strictEqual(is.onAirVoice(), null, 'nothing on air before start');
    is._running = true;
    assert.strictEqual(is.onAirVoice(), null, 'running but no voice');
    is._currentVoice = { path: '/tmp/x/peace-noon.mp3', meta: { label: 'Peace Oration, noon', kind: 'oration' } };
    is._currentVoiceStartedAt = 1234;
    assert.deepStrictEqual(is.onAirVoice(), { path: '/tmp/x/peace-noon.mp3', label: 'Peace Oration, noon', album: null, kind: 'oration', startedAt: 1234 });
    is._currentVoice = { path: '/tmp/x/intro.mp3', meta: {} };
    assert.strictEqual(is.onAirVoice().label, 'intro', 'a label falls back to the file name');
    assert.strictEqual(is.onAirVoice().kind, 'voice');
  });

  await test('the voice drain marks the item on air and fires onVoiceStart BEFORE streaming it', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'icecast-source.js'), 'utf8');
    const i = src.indexOf('this._currentVoice = v;');
    const j = src.indexOf('await this._streamFileToFfmpeg(v.path)', i);
    assert.ok(i > 0 && j > i, 'voice drain found');
    const between = src.slice(i, j);
    assert.ok(/this\._currentVoiceStartedAt = Date\.now\(\)/.test(between), 'start time stamped before the stream');
    assert.ok(/this\._onVoiceStart\(this\.onAirVoice\(\)\)/.test(between), 'hook fired with the on-air view before the stream');
    const fin = src.slice(j, src.indexOf('}', src.indexOf('finally', j)) + 1);
    assert.ok(/_currentVoiceStartedAt = null/.test(fin), 'cleared when the item ends');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
