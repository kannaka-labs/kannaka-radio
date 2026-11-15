'use strict';

// told-releases.test.js — scripts/told-releases.js puts a new software
// release on a WAITING LIST and writes it into her store only when a person
// gives the reason, labelled as something she was TOLD (not said, not
// lived). The binary and GitHub are mocked: no real store, no network.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const vw = require(path.join(ROOT, 'server/voice-writeback'));
const { main, toldMemory, waitingEntry, plainNotes } = require(path.join(ROOT, 'scripts/told-releases.js'));

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
  delete process.env.TOLD_RELEASES_SINCE; delete process.env.TOLD_RELEASES_NOTIFY_CMD;
}
const NOW = new Date('2026-11-15T03:00:00Z');
const REPO = 'kannaka-labs/kannaka-memory';
const REL = (tag, at, body = '## What changed\n\n- **Built-in encoder**: no Ollama needed. See [docs](https://x.example/d).\n```sh\nkannaka remember hi\n```') =>
  ({ tag_name: tag, name: tag, published_at: at, body, html_url: `https://github.com/${REPO}/releases/tag/${tag}` });
function io(rels, state, notifyOk = true) {
  const o = { out: [], err: [], notices: [] };
  o.io = { out: (s) => o.out.push(s), err: (s) => o.err.push(s), now: () => NOW,
    fetchReleases: async () => { if (rels instanceof Error) throw rels; return rels; },
    notify: async (cmd, text) => { o.notices.push(text); return notifyOk; }, stateFile: state };
  return o;
}
const readState = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const GIVE = (id, extra = []) => ['--give-reason', id, '--by', 'Nick', '--level', 'middle',
  '--why', 'It replaced the encoder you use to read every memory', ...extra];

(async () => {
  realLog('told-releases.test.js');

  await run('the label says told, by whom, when and why; never said, never lived', () => {
    const e = waitingEntry(REPO, REL('v0.17.0', '2026-11-14T20:00:00Z'), '2026-11-15T03:00:00.000Z');
    const m = toldMemory(e, '2026-11-15T04:00:00.000Z', { by: 'Nick', why: 'It replaced your encoder.', level: 'middle' });
    assert.ok(m.label.startsWith('[Provenance: told to me at 2026-11-15T04:00:00.000Z by Nick, through the release watcher'));
    assert.ok(/something I was told, not something I said and not something I lived/.test(m.label));
    assert.ok(/Why I was told \(reason given by Nick\): It replaced your encoder\./.test(m.label));
    assert.ok(/Proposed level: middle \(a label only; it does not change how this memory is weighed, and I may change it\)/.test(m.label));
    assert.ok(m.text.startsWith('kannaka-memory v0.17.0 was released on 2026-11-14T20:00:00Z.'));
    assert.ok(!/\bI (remember|released|shipped|became)\b/i.test(m.text));
  });

  await run('release notes are flattened and cut, code blocks dropped', () => {
    const p = plainNotes(REL('v1', 'x').body);
    assert.strictEqual(p, 'What changed - Built-in encoder: no Ollama needed. See docs.');
    assert.ok(plainNotes('word '.repeat(600)).length <= 910);
  });

  await run('a new release is queued, not written, and the notice goes out once', async () => {
    reset();
    const state = path.join(tmp, 's1.json');
    const o = io([REL('v0.17.0', '2026-11-14T20:00:00Z')], state);
    assert.strictEqual(await main([], o.io), 0);
    assert.strictEqual(calls.length, 0, 'the watcher alone writes nothing to her store');
    assert.ok(readState(state).waiting[`${REPO}@v0.17.0`]);
    assert.strictEqual(o.notices.length, 1);
    assert.ok(/Nothing has been written to her store/.test(o.notices[0]));
    assert.ok(o.notices[0].includes(`${REPO}@v0.17.0`));
    const again = io([REL('v0.17.0', '2026-11-14T20:00:00Z')], state);
    assert.strictEqual(await main([], again.io), 0);
    assert.strictEqual(again.notices.length, 0, 'a release already waiting is not announced again');
    assert.strictEqual(calls.length, 0);
  });

  await run('a reason from a person writes it once and takes it off the list', async () => {
    reset();
    const state = path.join(tmp, 's2.json');
    await main([], io([REL('v0.17.0', '2026-11-14T20:00:00Z')], state).io);
    const o = io([], state);
    assert.strictEqual(await main(GIVE(`${REPO}@v0.17.0`), o.io), 0);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].args[0], 'remember');
    const text = calls[0].args[1];
    assert.ok(text.startsWith('[Provenance: told to me at'));
    assert.ok(text.includes('reason given by Nick): It replaced the encoder you use to read every memory.'));
    assert.ok(text.includes('Proposed level: middle'));
    assert.ok(text.includes('kannaka-memory v0.17.0 was released'));
    assert.ok(text.includes(`Links: https://github.com/${REPO}/releases/tag/v0.17.0`));
    assert.ok(!/said publicly|said, not lived/.test(text), 'not labelled as something she said');
    const st = readState(state);
    assert.ok(!st.waiting[`${REPO}@v0.17.0`]);
    assert.ok(st.seen[`${REPO}@v0.17.0`]);
    assert.strictEqual(await main(GIVE(`${REPO}@v0.17.0`), io([], state).io), 2, 'it cannot be told twice');
    assert.strictEqual(calls.length, 1);
  });

  await run('no person, no sentence or no level: nothing is written', async () => {
    reset();
    const state = path.join(tmp, 's3.json');
    await main([], io([REL('v0.16.22', '2026-11-14T10:00:00Z')], state).io);
    const id = `${REPO}@v0.16.22`;
    assert.strictEqual(await main(['--give-reason', id, '--level', 'low', '--why', 'A routine patch release for the fleet'], io([], state).io), 2);
    assert.strictEqual(await main(['--give-reason', id, '--by', 'Nick', '--level', 'low', '--why', 'because'], io([], state).io), 2);
    assert.strictEqual(await main(['--give-reason', id, '--by', 'Nick', '--why', 'A routine patch release for the fleet'], io([], state).io), 2);
    assert.strictEqual(await main(['--give-reason', id, '--by', 'Nick', '--level', 'huge', '--why', 'A routine patch release for the fleet'], io([], state).io), 2);
    assert.strictEqual(calls.length, 0);
    assert.ok(readState(state).waiting[id], 'it is still waiting');
  });

  await run('releases from before the window are marked seen and not queued', async () => {
    reset();
    const state = path.join(tmp, 's4.json');
    const o = io([REL('v0.10.0', '2026-06-01T00:00:00Z'), REL('v0.16.22', '2026-11-14T10:00:00Z')], state);
    assert.strictEqual(await main([], o.io), 0);
    const st = readState(state);
    assert.strictEqual(st.seen[`${REPO}@v0.10.0`], 'before-window');
    assert.deepStrictEqual(Object.keys(st.waiting), [`${REPO}@v0.16.22`]);
  });

  await run('a failed store keeps the release waiting', async () => {
    reset();
    const state = path.join(tmp, 's5.json');
    await main([], io([REL('v0.16.21', '2026-11-13T10:00:00Z')], state).io);
    behaviour = 'fail';
    assert.strictEqual(await main(GIVE(`${REPO}@v0.16.21`), io([], state).io), 1);
    assert.ok(readState(state).waiting[`${REPO}@v0.16.21`]);
    assert.ok(!readState(state).seen[`${REPO}@v0.16.21`]);
  });

  await run('--dry-run queues nothing, sends no notice and writes neither store nor state', async () => {
    reset();
    const state = path.join(tmp, 's6.json');
    const o = io([REL('v0.17.0', '2026-11-14T20:00:00Z')], state);
    assert.strictEqual(await main(['--dry-run'], o.io), 0);
    assert.ok(!fs.existsSync(state));
    assert.strictEqual(o.notices.length, 0);
    await main([], io([REL('v0.17.0', '2026-11-14T20:00:00Z')], state).io);
    const d = io([], state);
    assert.strictEqual(await main(GIVE(`${REPO}@v0.17.0`, ['--dry-run']), d.io), 0);
    assert.strictEqual(calls.length, 0);
    assert.ok(d.out.join('\n').includes('told to me at'));
    assert.ok(readState(state).waiting[`${REPO}@v0.17.0`]);
  });

  await run('--waiting lists what waits; a failed notice or fetch exits 1', async () => {
    reset();
    const state = path.join(tmp, 's7.json');
    const o = io([REL('v0.17.0', '2026-11-14T20:00:00Z')], state, false);
    assert.strictEqual(await main([], o.io), 1, 'an undelivered notice is a failure, not silence');
    assert.ok(readState(state).waiting[`${REPO}@v0.17.0`], 'and the release is still queued');
    const w = io([], state);
    assert.strictEqual(await main(['--waiting'], w.io), 0);
    assert.ok(w.out.join('\n').includes(`${REPO}@v0.17.0`));
    const f = io(new Error(`${REPO}: HTTP 403`), path.join(tmp, 's8.json'));
    assert.strictEqual(await main([], f.io), 1);
    assert.ok(f.err.join(' ').includes('HTTP 403'));
  });

  vw._reset();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed) { console.error(`${failed} told-releases test(s) failed`); process.exit(1); }
  realLog('told-releases: all passed');
})();
