'use strict';

// voice-writeback-ledger.test.js — the write-back paths #438 left open:
//   - cross-process dedupe: the server and the cron scripts share one
//     append-only ledger, so the same words are stored once between them;
//   - KANNAKA_VOICE_WRITEBACK=force writes back under KANNAKA_READONLY=1
//     (post-research-dispatch.js runs read-only from cron), lifting READONLY
//     for the remember child only;
//   - direct adapter posts (every YouTube upload script, one-network
//     announces) are remembered by the adapter itself, once, and the fanout
//     is not remembered twice.
// The binary is mocked throughout: no test here touches a real store.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const vw = require(path.join(ROOT, 'server/voice-writeback'));

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
const logs = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-ledger-test-'));
function reset() {
  vw._reset();
  vw._setExecFile(fakeExecFile);
  vw.configure({ bin: '/fake/kannaka' });
  calls = []; behaviour = 'ok'; logs.length = 0;
  for (const k of ['KANNAKA_VOICE_WRITEBACK', 'KANNAKA_READONLY', 'KANNAKA_VOICE_WRITEBACK_DEDUPE_MS', 'KANNAKA_VOICE_WRITEBACK_LEDGER']) delete process.env[k];
}
// A second process: fresh in-process state, the same ledger file.
function asAnotherProcess() {
  const ledger = vw.ledgerPath();
  vw._reset(); vw._setExecFile(fakeExecFile); vw.configure({ bin: '/fake/kannaka' }); vw._setLedgerPath(ledger);
}
const OK = [{ name: 'bluesky', ok: true }];

function spawnClaimers(n, ledger, key) {
  const code = `
    const vw = require(${JSON.stringify(path.join(ROOT, 'server/voice-writeback'))});
    console.log = () => {};
    const go = Number(process.argv[1]);
    while (Date.now() < go) {}
    process.stdout.write(JSON.stringify(vw.claimLedger(${JSON.stringify(key)})));
    // Stay alive until every claimer has claimed: a claim from a process
    // that has exited is released (it was killed mid-store, as far as the
    // ledger can tell).
    setTimeout(() => {}, Math.max(0, go + 1500 - Date.now()));`;
  const go = Date.now() + 1500;
  return Promise.all(Array.from({ length: n }, () => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', code, String(go)], {
      env: { ...process.env, KANNAKA_VOICE_WRITEBACK_LEDGER: ledger },
    });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('error', reject);
    c.on('exit', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(new Error(`bad child output: ${out}`)); } });
  })));
}

async function main() {
  console.log('voice-writeback-ledger.test.js');
  console.log = (...a) => { logs.push(a.join(' ')); };

  await run('the same words from a second process are not stored again (shared ledger)', async () => {
    reset();
    const r1 = await vw.rememberPublication({ text: 'Field guide: interference.', results: OK, composer: 'server' });
    asAnotherProcess();
    const r2 = await vw.rememberPublication({ text: '  field guide:   INTERFERENCE. ', results: OK, composer: 'cron' });
    assert.strictEqual(r1.stored, true);
    assert.strictEqual(r2.stored, false);
    assert.ok(/identical text already stored in this window \(shared ledger\)/.test(r2.reason), r2.reason);
    assert.strictEqual(calls.length, 1);
    assert.ok(logs.some((l) => /not stored: .* — identical text already stored in this window \(shared ledger\)/.test(l)));
  });

  await run('concurrent claims from 6 real processes: exactly one wins', async () => {
    reset();
    const ledger = path.join(tmp, 'race.jsonl');
    const results = await spawnClaimers(6, ledger, 'the same oration');
    assert.strictEqual(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
    const lines = fs.readFileSync(ledger, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 1, 'one claim line, no torn or doubled writes');
    assert.ok(!fs.existsSync(`${ledger}.lock`), 'the lock is released');
  });

  await run('a failed store releases its claim in the ledger, so another process can store it', async () => {
    reset();
    behaviour = 'fail';
    const r1 = await vw.rememberPublication({ text: 'retry across processes', results: OK, composer: 'x' });
    asAnotherProcess();
    behaviour = 'ok';
    const r2 = await vw.rememberPublication({ text: 'retry across processes', results: OK, composer: 'x' });
    assert.strictEqual(r1.stored, false);
    assert.strictEqual(r2.stored, true);
    assert.ok(fs.readFileSync(vw.ledgerPath(), 'utf8').includes('"r":1'));
  });

  await run('the ledger records the completed store, not just the claim', async () => {
    reset();
    const r = await vw.rememberPublication({ text: 'stored for real', results: OK, composer: 'x' });
    assert.strictEqual(r.stored, true);
    const lines = fs.readFileSync(vw.ledgerPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual(lines.map((e) => e.s), ['p', 's'], JSON.stringify(lines));
    assert.strictEqual(lines[0].pid, process.pid);
    asAnotherProcess();
    const r2 = await vw.rememberPublication({ text: 'stored for real', results: OK, composer: 'x' });
    assert.strictEqual(r2.alreadyStored, true);
  });

  await run('a claim whose process died, or whose lease ran out, does not block the same words', async () => {
    reset();
    const dead = await new Promise((resolve) => {
      const c = spawn(process.execPath, ['-e', '']);
      c.on('exit', () => resolve(c.pid));
    });
    const crypto = require('crypto');
    const h = (t) => crypto.createHash('sha256').update(t).digest('hex');
    const now = Date.now();
    fs.writeFileSync(vw.ledgerPath(), [
      { h: h('killed mid-store'), t: now, s: 'p', pid: dead, host: os.hostname() },
      { h: h('lease ran out'), t: now - vw.LEDGER_LEASE_MS - 1000, s: 'p', pid: process.pid, host: os.hostname() },
      { h: h('still storing'), t: now, s: 'p', pid: process.pid, host: os.hostname() },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    assert.strictEqual(vw.claimLedger('killed mid-store').ok, true, 'dead claimer');
    assert.strictEqual(vw.claimLedger('lease ran out').ok, true, 'expired lease');
    const busy = vw.claimLedger('still storing');
    assert.strictEqual(busy.ok, false, 'a live claimer inside its lease');
    assert.strictEqual(busy.alreadyStored, false);
    assert.ok(/being stored by another process/.test(busy.reason), busy.reason);
  });

  await run('the remember child runs at low priority, and a digest can carry --expires', async () => {
    reset();
    const reniced = [];
    const realSet = os.setPriority;
    os.setPriority = (pid, p) => { reniced.push([pid, p]); };
    try {
      vw._setExecFile((bin, args, opts, cb) => { calls.push({ bin, args, opts }); setImmediate(() => cb(null, '', '')); return { pid: 4242 }; });
      await vw.rememberPublication({ text: 'gently', results: OK, composer: 'x', expires: '2026-12-07T18:00:00Z' });
      assert.deepStrictEqual(reniced, [[4242, 15]]);
      assert.deepStrictEqual(calls[0].args.slice(-2), ['--expires', '2026-12-07T18:00:00Z']);
    } finally { os.setPriority = realSet; }
  });

  await run('claims expire with the dedupe window', async () => {
    reset();
    process.env.KANNAKA_VOICE_WRITEBACK_DEDUPE_MS = '5';
    await vw.rememberPublication({ text: 'twice a day', results: OK, composer: 'x' });
    await new Promise((r) => setTimeout(r, 20));
    asAnotherProcess();
    const r = await vw.rememberPublication({ text: 'twice a day', results: OK, composer: 'x' });
    assert.strictEqual(r.stored, true);
  });

  await run('the ledger prunes expired entries once it grows; torn lines are ignored', async () => {
    reset();
    const ledger = vw.ledgerPath();
    const old = Date.now() - 7 * 60 * 60 * 1000;
    const lines = [];
    for (let i = 0; i < 2100; i++) lines.push(JSON.stringify({ h: `h${i}`, t: old }));
    fs.writeFileSync(ledger, lines.join('\n') + '\n{"h":"torn');
    const r = vw.claimLedger('fresh words');
    assert.strictEqual(r.ok, true);
    const after = fs.readFileSync(ledger, 'utf8').trim().split('\n');
    assert.strictEqual(after.length, 1, `pruned to the one live claim, got ${after.length}`);
  });

  await run('a lock left by a dead process is broken once stale', async () => {
    reset();
    const ledger = vw.ledgerPath();
    fs.writeFileSync(`${ledger}.lock`, '');
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(`${ledger}.lock`, past, past);
    assert.strictEqual(vw.claimLedger('after a crash').ok, true);
  });

  await run('an unusable ledger falls back to in-process dedupe, logged, and still stores', async () => {
    reset();
    const blocker = path.join(tmp, 'a-file');
    fs.writeFileSync(blocker, 'x');
    vw._setLedgerPath(path.join(blocker, 'ledger.jsonl')); // parent is a file
    const r = await vw.rememberPublication({ text: 'still remembered', results: OK, composer: 'x' });
    assert.strictEqual(r.stored, true);
    assert.ok(logs.some((l) => /shared ledger unavailable .* deduping in this process only/.test(l)), logs.join('\n'));
  });

  await run('the default ledger is in the radio data dir, never under ~/.kannaka', async () => {
    const saved = process.env.KANNAKA_RADIO_DATA_DIR;
    try {
      vw._setLedgerPath(null);
      delete process.env.KANNAKA_VOICE_WRITEBACK_LEDGER;
      delete process.env.KANNAKA_RADIO_DATA_DIR;
      assert.strictEqual(vw.ledgerPath(), path.join(ROOT, 'workspace', 'voice-writeback-ledger.jsonl'));
      process.env.KANNAKA_RADIO_DATA_DIR = '/srv/radio';
      assert.strictEqual(vw.ledgerPath(), path.join('/srv/radio', 'voice-writeback-ledger.jsonl'));
      assert.ok(!vw.ledgerPath().includes('.kannaka'));
    } finally {
      if (saved !== undefined) process.env.KANNAKA_RADIO_DATA_DIR = saved; else delete process.env.KANNAKA_RADIO_DATA_DIR;
    }
  });

  await run('READONLY without force still skips, and says how to override', async () => {
    reset();
    process.env.KANNAKA_READONLY = '1';
    const r = await vw.rememberPublication({ text: 'ro', results: OK, composer: 'x' });
    assert.strictEqual(r.stored, false);
    assert.ok(/KANNAKA_VOICE_WRITEBACK=force writes back anyway/.test(r.reason), r.reason);
  });

  await run('KANNAKA_VOICE_WRITEBACK=force writes under READONLY, lifting it for the child only', async () => {
    reset();
    process.env.KANNAKA_READONLY = '1';
    process.env.KANNAKA_VOICE_WRITEBACK = 'force';
    const r = await vw.rememberPublication({ text: 'research post', results: OK, composer: 'cron' });
    assert.strictEqual(r.stored, true);
    assert.strictEqual(calls[0].opts.env.KANNAKA_READONLY, undefined, 'the remember child is not read-only');
    assert.strictEqual(process.env.KANNAKA_READONLY, '1', 'the caller stays read-only');
    reset();
    process.env.KANNAKA_VOICE_WRITEBACK = 'force';
    process.env.KANNAKA_READONLY = '1';
    process.env.KANNAKA_VOICE_WRITEBACK = '0';
    assert.ok(/disabled/.test((await vw.rememberPublication({ text: 'off', results: OK })).reason), '0 still wins');
  });

  await run('an explicit importance is honoured; out-of-range falls back', async () => {
    reset();
    await vw.rememberPublication({ text: 'a', results: OK, importance: 0.35 });
    await vw.rememberPublication({ text: 'b', results: OK, importance: 7 });
    assert.strictEqual(calls[0].args[3], '0.35');
    assert.strictEqual(calls[1].args[3], vw.IMPORTANCE.toFixed(2));
  });

  // ── direct adapter posts ──────────────────────────────────────────────
  class FakeAdapter {
    constructor(name, result) { this.name = name; this._result = result; }
    async post() { return this._result; }
  }
  vw.wrapDirectPost(FakeAdapter);

  await run('a direct YouTube upload is remembered once: title, URL, the start of the description', async () => {
    reset();
    const desc = `A standalone special. ${'Rain on Sixteenth Avenue. '.repeat(40)}`;
    const yt = new FakeAdapter('youtube', { ok: true, url: 'https://www.youtube.com/watch?v=abc' });
    await yt.post({ text: desc, media: { title: 'TSOF SP3 — Hello World', privacy: 'public' } });
    await vw.flush(1000);
    assert.strictEqual(calls.length, 1);
    const memory = calls[0].args[1];
    assert.ok(memory.startsWith('[Provenance: said publicly under my name on youtube at '), memory);
    assert.ok(memory.includes(' as a video upload on my channel; composed by unlabelled caller ('), memory);
    assert.ok(memory.includes('Video title: TSOF SP3 — Hello World\nDescription: A standalone special.'));
    assert.ok(memory.includes('Links: https://www.youtube.com/watch?v=abc'));
    const body = memory.split('Description: ')[1].split('\nLinks:')[0];
    assert.ok(body.length <= 600 + 2, `description cut to ~600 chars, got ${body.length}`);
    assert.strictEqual(calls[0].args[3], vw.IMPORTANCE.toFixed(2), 'moderate importance');
  });

  await run('a private upload, a failed post, writeBack:false and a fanout call are not remembered', async () => {
    reset();
    await new FakeAdapter('youtube', { ok: true, url: 'u' }).post({ text: 'd', media: { title: 't', privacy: 'private' } });
    await new FakeAdapter('nostr', { ok: false, error: 'down' }).post({ text: 'x' });
    await new FakeAdapter('nostr', { ok: true }).post({ text: 'y', writeBack: false });
    await new FakeAdapter('nostr', { ok: true }).post({ text: 'z', [vw.IN_FANOUT]: true });
    await vw.flush(1000);
    assert.strictEqual(calls.length, 0);
    assert.ok(logs.some((l) => /private upload, not said publicly/.test(l)));
  });

  await run('an unlisted upload is remembered, and labelled unlisted', async () => {
    reset();
    await new FakeAdapter('youtube', { ok: true, url: 'u' }).post({ text: 'd', media: { title: 'Test render', privacy: 'unlisted' } });
    await vw.flush(1000);
    assert.ok(calls[0].args[1].includes('as an unlisted video upload on my channel'));
  });

  await run('a one-network announce (post-gsp031-nostr.js shape) is remembered as a direct post', async () => {
    reset();
    await new FakeAdapter('nostr', { ok: true, url: 'nostr:note1' }).post({ text: 'Ghost Signals 031.', topic: 'podcast' });
    await vw.flush(1000);
    assert.ok(calls[0].args[1].includes('on nostr at ') && calls[0].args[1].includes('posted directly, outside the fanout'));
  });

  await run('all five real adapters are wrapped, and wrapping twice is a no-op', async () => {
    for (const [f, cls] of [['bluesky', 'BlueskyAdapter'], ['mastodon', 'MastodonAdapter'], ['telegram', 'TelegramAdapter'], ['nostr', 'NostrAdapter'], ['youtube', 'YouTubeAdapter']]) {
      const C = require(path.join(ROOT, `server/broadcasters/${f}-adapter`))[cls];
      assert.strictEqual(C.prototype.post[vw.IN_FANOUT], true, `${cls}.post writes back direct posts`);
      const before = C.prototype.post;
      vw.wrapDirectPost(C);
      assert.strictEqual(C.prototype.post, before);
    }
  });

  await run('a fanout with a YouTube video is ONE memory, not one per adapter', async () => {
    reset();
    const mods = {
      bluesky: require(path.join(ROOT, 'server/broadcasters/bluesky-adapter')).BlueskyAdapter,
      youtube: require(path.join(ROOT, 'server/broadcasters/youtube-adapter')).YouTubeAdapter,
      mastodon: require(path.join(ROOT, 'server/broadcasters/mastodon-adapter')).MastodonAdapter,
      telegram: require(path.join(ROOT, 'server/broadcasters/telegram-adapter')).TelegramAdapter,
      nostr: require(path.join(ROOT, 'server/broadcasters/nostr-adapter')).NostrAdapter,
    };
    const saved = {};
    for (const [name, C] of Object.entries(mods)) {
      saved[name] = { post: C.prototype.post, isEnabled: C.prototype.isEnabled };
      C.prototype.isEnabled = function () { return name === 'bluesky' || name === 'youtube'; };
      // The stubbed network call, then the real wrapper over it.
      C.prototype.post = async function () { return { ok: true, url: `https://${name}.example/1` }; };
      vw.wrapDirectPost(C);
    }
    try {
      const { broadcastPost } = require(path.join(ROOT, 'server/broadcasters'));
      const results = await broadcastPost({ text: 'A new track.', media: { path: 'x.mp4', title: 'A new track' }, composer: 'test' }, {});
      await vw.flush(1000);
      assert.strictEqual(results.filter((r) => r.ok).length, 2);
      assert.strictEqual(calls.length, 1, calls.map((c) => c.args[1]).join('\n'));
      assert.ok(calls[0].args[1].includes('on bluesky, youtube at '));
      // And the same adapter called directly still remembers its own post.
      reset();
      await new mods.bluesky(ROOT).post({ text: 'Direct to Bluesky.' });
      await vw.flush(1000);
      assert.strictEqual(calls.length, 1);
    } finally {
      for (const [name, C] of Object.entries(mods)) { C.prototype.post = saved[name].post; C.prototype.isEnabled = saved[name].isEnabled; }
    }
  });

  console.log = realLog;
  vw._reset();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  if (failed) { console.error(`\n${failed} voice-writeback-ledger test(s) failed`); process.exit(1); }
  console.log('all passed');
}

main().catch((e) => { console.log = realLog; console.error(e); process.exit(1); });
