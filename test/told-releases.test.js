'use strict';

// told-releases.test.js — scripts/told-releases.js writes a software release
// into her store once, labelled as something she was TOLD (not said, not
// lived). The binary and GitHub are mocked: no real store, no network.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const vw = require(path.join(ROOT, 'server/voice-writeback'));
const { main, toldMemory, plainNotes } = require(path.join(ROOT, 'scripts/told-releases.js'));

let failed = 0;
const realLog = console.log;
async function run(name, fn) {
  try { await fn(); realLog(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}: ${e.stack || e.message}`); failed++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'told-'));
let calls = [];
let behaviour = 'ok';
function fakeExecFile(bin, args, opts, cb) {
  calls.push({ bin, args, opts });
  setImmediate(() => cb(behaviour === 'fail' ? Object.assign(new Error('boom'), { code: 1 }) : null, '', ''));
}
let n = 0;
function reset() {
  vw._reset(); vw._setExecFile(fakeExecFile); vw.configure({ bin: '/fake/kannaka' });
  vw._setLedgerPath(path.join(tmp, `ledger-${++n}.jsonl`));
  calls = []; behaviour = 'ok';
  delete process.env.KANNAKA_VOICE_WRITEBACK; delete process.env.KANNAKA_READONLY;
  process.env.TOLD_RELEASES_REPOS = 'kannaka-labs/kannaka-memory';
  delete process.env.TOLD_RELEASES_SINCE;
}
const NOW = new Date('2026-11-15T03:00:00Z');
const REL = (tag, at, body = '## What changed\n\n- **Built-in encoder**: no Ollama needed. See [docs](https://x.example/d).\n```sh\nkannaka remember hi\n```') =>
  ({ tag_name: tag, name: tag, published_at: at, body, html_url: `https://github.com/kannaka-labs/kannaka-memory/releases/tag/${tag}` });
function io(rels, state) {
  const o = { out: [], err: [] };
  o.io = { out: (s) => o.out.push(s), err: (s) => o.err.push(s), now: () => NOW,
    fetchReleases: async (repo) => { if (rels instanceof Error) throw rels; return rels; }, stateFile: state };
  return o;
}

(async () => {
  realLog('told-releases.test.js');

  await run('the label says told, by whom and when; never said, never lived', () => {
    const m = toldMemory('kannaka-labs/kannaka-memory', REL('v0.17.0', '2026-11-14T20:00:00Z'), '2026-11-15T03:00:00.000Z');
    assert.ok(m.label.startsWith('[Provenance: told to me at 2026-11-15T03:00:00.000Z by the release watcher'));
    assert.ok(/something I was told, not something I said and not something I lived/.test(m.label));
    assert.ok(m.text.startsWith('kannaka-memory v0.17.0 was released on 2026-11-14T20:00:00Z.'));
    assert.ok(!/\bI (remember|released|shipped|became)\b/i.test(m.text));
  });

  await run('release notes are flattened and cut, code blocks dropped', () => {
    const p = plainNotes(REL('v1', 'x').body);
    assert.strictEqual(p, 'What changed - Built-in encoder: no Ollama needed. See docs.');
    assert.ok(plainNotes('word '.repeat(600)).length <= 910);
  });

  await run('a new release is stored once with the told label and its exact tag', async () => {
    reset();
    const state = path.join(tmp, 's1.json');
    const o = io([REL('v0.17.0', '2026-11-14T20:00:00Z')], state);
    assert.strictEqual(await main([], o.io), 0);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].args[0], 'remember');
    assert.ok(calls[0].args[1].startsWith('[Provenance: told to me at'));
    assert.ok(calls[0].args[1].includes('kannaka-memory v0.17.0 was released'));
    assert.ok(calls[0].args[1].includes('Links: https://github.com/kannaka-labs/kannaka-memory/releases/tag/v0.17.0'));
    assert.ok(!/said publicly|said, not lived/.test(calls[0].args[1]), 'not labelled as something she said');
    const again = io([REL('v0.17.0', '2026-11-14T20:00:00Z')], state);
    assert.strictEqual(await main([], again.io), 0);
    assert.strictEqual(calls.length, 1, 'the second run tells her nothing new');
  });

  await run('releases from before the window are marked seen and not written', async () => {
    reset();
    const state = path.join(tmp, 's2.json');
    const o = io([REL('v0.10.0', '2026-06-01T00:00:00Z'), REL('v0.16.22', '2026-11-14T10:00:00Z')], state);
    assert.strictEqual(await main([], o.io), 0);
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].args[1].includes('v0.16.22'));
    assert.strictEqual(JSON.parse(fs.readFileSync(state, 'utf8')).seen['kannaka-labs/kannaka-memory@v0.10.0'], 'before-window');
  });

  await run('a failed store is not marked seen and is tried again', async () => {
    reset(); behaviour = 'fail';
    const state = path.join(tmp, 's3.json');
    const o = io([REL('v0.16.21', '2026-11-13T10:00:00Z')], state);
    assert.strictEqual(await main([], o.io), 1);
    assert.ok(!JSON.parse(fs.readFileSync(state, 'utf8')).seen['kannaka-labs/kannaka-memory@v0.16.21']);
    vw._reset(); vw._setExecFile(fakeExecFile); vw.configure({ bin: '/fake/kannaka' }); vw._setLedgerPath(path.join(tmp, 'ledger-retry.jsonl'));
    behaviour = 'ok';
    assert.strictEqual(await main([], io([REL('v0.16.21', '2026-11-13T10:00:00Z')], state).io), 0);
    assert.ok(JSON.parse(fs.readFileSync(state, 'utf8')).seen['kannaka-labs/kannaka-memory@v0.16.21']);
  });

  await run('--dry-run prints the memory and writes neither store nor state', async () => {
    reset();
    const state = path.join(tmp, 's4.json');
    const o = io([REL('v0.17.0', '2026-11-14T20:00:00Z')], state);
    assert.strictEqual(await main(['--dry-run'], o.io), 0);
    assert.strictEqual(calls.length, 0);
    assert.ok(!fs.existsSync(state));
    assert.ok(o.out.join('\n').includes('told to me at'));
  });

  await run('a fetch failure is reported, exits 1, and stores nothing', async () => {
    reset();
    const o = io(new Error('kannaka-labs/kannaka-memory: HTTP 403'), path.join(tmp, 's5.json'));
    assert.strictEqual(await main([], o.io), 1);
    assert.strictEqual(calls.length, 0);
    assert.ok(o.err.join(' ').includes('HTTP 403'));
  });

  vw._reset();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed) { console.error(`${failed} told-releases test(s) failed`); process.exit(1); }
  realLog('told-releases: all passed');
})();
