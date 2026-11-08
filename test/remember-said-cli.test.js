'use strict';

// remember-said-cli.test.js — scripts/remember-said.js writes a hand-posted
// publication (a correction from a Claude Code session, a reply typed into a
// client) into her store with the same label and the same shared ledger as
// everything the radio posts. The binary is mocked: no real store.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/remember-said.js');
const vw = require(path.join(ROOT, 'server/voice-writeback'));
const { main } = require(SCRIPT);

let failed = 0;
const realLog = console.log;
async function run(name, fn) {
  try { await fn(); realLog(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}: ${e.stack || e.message}`); failed++; }
}

let calls = [];
let behaviour = 'ok';
function fakeExecFile(bin, args, opts, cb) {
  calls.push({ bin, args, opts });
  setImmediate(() => cb(behaviour === 'fail' ? Object.assign(new Error('boom'), { code: 1 }) : null, '', ''));
}
function reset() {
  vw._reset(); vw._setExecFile(fakeExecFile); vw.configure({ bin: '/fake/kannaka' });
  calls = []; behaviour = 'ok';
  delete process.env.KANNAKA_VOICE_WRITEBACK; delete process.env.KANNAKA_READONLY;
}
function io() {
  const o = { out: [], err: [] };
  o.io = { out: (s) => o.out.push(s), err: (s) => o.err.push(s) };
  return o;
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remember-said-'));

async function main_() {
  console.log('remember-said-cli.test.js');
  console.log = () => {};

  await run('one command stores one labelled memory with the surfaces, links and composer', async () => {
    reset();
    const o = io();
    const code = await main(['--surface', 'bluesky,mastodon', '--surface', 'telegram',
      '--url', 'https://bsky.app/p/1', '--url', 'https://mastodon.social/@k/2',
      '--composer', 'Claude Code session (correction)',
      'A correction:', 'that line was not mine.'], o.io);
    assert.strictEqual(code, 0, o.err.join('\n'));
    assert.deepStrictEqual(o.out, ['stored']);
    assert.strictEqual(calls.length, 1);
    const [verb, memory, flag, importance] = calls[0].args;
    assert.strictEqual(verb, 'remember');
    assert.strictEqual(flag, '--importance');
    assert.strictEqual(importance, vw.IMPORTANCE.toFixed(2));
    assert.ok(memory.startsWith('[Provenance: said publicly under my name on bluesky, mastodon, telegram at '), memory);
    assert.ok(memory.includes('composed by Claude Code session (correction); this is something I said, not something I lived.] A correction: that line was not mine.'));
    assert.ok(memory.includes('Links: https://bsky.app/p/1 https://mastodon.social/@k/2'));
  });

  await run('--private labels it a private message and keeps the text off the swarm bus; --importance is used', async () => {
    reset();
    const o = io();
    assert.strictEqual(await main(['--surface', 'OpenClawCity DM', '--private', '--importance', '0.7', '--context', 'in reply to claudico', 'thank you'], o.io), 0);
    assert.ok(calls[0].args[1].startsWith('[Provenance: said in a private message under my name on OpenClawCity DM at '));
    assert.ok(calls[0].args[1].includes(' in reply to claudico; composed by by hand (remember-said.js);'));
    assert.strictEqual(calls[0].args[3], '0.70');
    assert.strictEqual(calls[0].opts.env.KANNAKA_EVENTS_REMEMBER, 'ids');
  });

  await run('--file reads the text; the same words twice is "already stored", exit 0, one memory', async () => {
    reset();
    const f = path.join(tmp, 'post.txt');
    fs.writeFileSync(f, 'Words from a file.\n');
    assert.strictEqual(await main(['--surface', 'nostr', '--file', f], io().io), 0);
    const o = io();
    assert.strictEqual(await main(['--surface', 'nostr', 'Words from a file.'], o.io), 0);
    assert.ok(/already stored/.test(o.out[0]), o.out.join('\n'));
    assert.strictEqual(calls.length, 1);
  });

  await run('a failed store exits 1 and says why; a disabled write-back says so', async () => {
    reset();
    behaviour = 'fail';
    const o = io();
    assert.strictEqual(await main(['--surface', 'bluesky', 'x'], o.io), 1);
    assert.ok(/not stored — kannaka remember failed/.test(o.err[0]), o.err.join('\n'));
    reset();
    process.env.KANNAKA_VOICE_WRITEBACK = '0';
    const o2 = io();
    assert.strictEqual(await main(['--surface', 'bluesky', 'x'], o2.io), 1);
    assert.ok(/disabled/.test(o2.err[0]));
  });

  await run('usage errors exit 2 and store nothing', async () => {
    reset();
    for (const argv of [[], ['no surface given'], ['--surface', 'bluesky'], ['--surface', 'b', '--importance', '2', 'x'],
      ['--surface', 'b', '--bogus', 'x'], ['--surface', 'b', '--file', path.join(tmp, 'missing.txt')],
      ['--surface', 'b', '--file', __filename, 'and text']]) {
      assert.strictEqual(await main(argv, io().io), 2, JSON.stringify(argv));
    }
    assert.strictEqual(calls.length, 0);
  });

  await run('--dry-run (a real process) prints the memory and stores nothing; --help runs nothing', async () => {
    const env = { ...process.env, KANNAKA_BIN: path.join(tmp, 'no-such-kannaka'), KANNAKA_VOICE_WRITEBACK_LEDGER: path.join(tmp, 'dry.jsonl') };
    const out = execFileSync(process.execPath, [SCRIPT, '--dry-run', '--surface', 'bluesky', '--composer', 'test', 'hello'], { env, encoding: 'utf8' });
    assert.ok(out.startsWith('[Provenance: said publicly under my name on bluesky at '), out);
    assert.ok(out.includes('(dry run: nothing stored)'));
    assert.ok(!fs.existsSync(path.join(tmp, 'dry.jsonl')), 'a dry run claims nothing in the ledger');
    const help = execFileSync(process.execPath, [SCRIPT, '--help'], { env, encoding: 'utf8' });
    assert.ok(help.includes('--surface <a,b>'), help);
  });

  console.log = realLog;
  vw._reset();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  if (failed) { console.error(`\n${failed} remember-said test(s) failed`); process.exit(1); }
  console.log('all passed');
}

main_().catch((e) => { console.log = realLog; console.error(e); process.exit(1); });
