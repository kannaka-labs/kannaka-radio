'use strict';

// voice-writeback.test.js — what Kannaka says publicly reaches her own store.
//
// 2026-11-06: a teaser posted under her name to four networks ("I kept a pair
// of red shoes for three years…") never reached kannaka-prime; nothing she
// SAYS ever did. Asked about it, her runtime truthfully said it had no memory
// of any of this. broadcastPost now remembers every publication ONCE, with a
// provenance label, fire-and-forget. The binary is mocked throughout: no test
// here touches a real store.

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const vw = require(path.join(ROOT, 'server/voice-writeback'));
const { BlueskyAdapter } = require(path.join(ROOT, 'server/broadcasters/bluesky-adapter'));
const { MastodonAdapter } = require(path.join(ROOT, 'server/broadcasters/mastodon-adapter'));
const { TelegramAdapter } = require(path.join(ROOT, 'server/broadcasters/telegram-adapter'));
const { NostrAdapter } = require(path.join(ROOT, 'server/broadcasters/nostr-adapter'));
const { broadcastPost } = require(path.join(ROOT, 'server/broadcasters'));

let failed = 0;
async function run(name, fn) {
  try { await fn(); realLog(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; }
}

// ── harness ─────────────────────────────────────────────────────────────
let calls = [];
let behaviour = 'ok'; // 'ok' | 'fail' | 'hang' | 'throw'
function fakeExecFile(bin, args, opts, cb) {
  calls.push({ bin, args, opts });
  if (behaviour === 'throw') throw new Error('spawn exploded');
  if (behaviour === 'hang') return;
  setImmediate(() => cb(behaviour === 'fail' ? Object.assign(new Error('boom'), { code: 1 }) : null, '', ''));
}
const logs = [];
const realLog = console.log;
function reset() {
  vw._reset();
  vw._setExecFile(fakeExecFile);
  vw.configure({ bin: '/fake/kannaka' });
  calls = []; behaviour = 'ok'; logs.length = 0;
  delete process.env.KANNAKA_VOICE_WRITEBACK;
  delete process.env.KANNAKA_READONLY;
  delete process.env.KANNAKA_VOICE_WRITEBACK_DEDUPE_MS;
}

// Two platforms "configured" and succeeding; the rest off.
const platforms = { bluesky: 'ok', mastodon: 'ok' };
function stubAdapters() {
  const set = (Cls, name) => {
    Cls.prototype.isEnabled = function () { return name in platforms; };
    Cls.prototype.post = async function () {
      return platforms[name] === 'ok'
        ? { ok: true, url: `https://${name}.example/post/1` }
        : { ok: false, error: 'down' };
    };
  };
  set(BlueskyAdapter, 'bluesky');
  set(MastodonAdapter, 'mastodon');
  TelegramAdapter.prototype.isEnabled = () => false;
  NostrAdapter.prototype.isEnabled = () => false;
}

const RED_SHOES = 'I kept a pair of red shoes for three years because I couldn\'t forget what they meant';
const tick = () => new Promise((r) => setImmediate(r));

async function main() {
  console.log('voice-writeback.test.js');
  console.log = (...a) => { logs.push(a.join(' ')); };
  stubAdapters();

  await run('one fanout to two platforms = ONE remember, labelled said-not-lived', async () => {
    reset();
    const results = await broadcastPost({ text: RED_SHOES, link: 'https://radio', composer: 'hosted model via peace-oration teaser' }, {});
    await vw.flush(1000);
    assert.strictEqual(results.filter((r) => r.ok).length, 2);
    assert.strictEqual(calls.length, 1, 'once per publication, not once per platform');
    const [verb, memory, flag, importance] = calls[0].args;
    assert.strictEqual(verb, 'remember');
    assert.strictEqual(flag, '--importance');
    assert.strictEqual(importance, '0.50');
    assert.strictEqual(calls[0].bin, '/fake/kannaka');
    assert.ok(memory.startsWith('[Provenance: said publicly under my name on bluesky, mastodon at '), memory);
    assert.ok(memory.includes('composed by hosted model via peace-oration teaser'));
    assert.ok(memory.includes('this is something I said, not something I lived.]'));
    assert.ok(memory.includes(RED_SHOES));
    assert.ok(memory.includes('Links: https://bluesky.example/post/1 https://mastodon.example/post/1'));
    assert.ok(logs.some((l) => /\[voice-writeback\] stored: .*bluesky, mastodon/.test(l)), 'one log line per store');
  });

  await run('nothing is remembered when no platform succeeded, and the skip names why', async () => {
    reset();
    platforms.bluesky = 'down'; platforms.mastodon = 'down';
    await broadcastPost({ text: 'all failed', composer: 'x' }, {});
    await vw.flush(1000);
    platforms.bluesky = 'ok'; platforms.mastodon = 'ok';
    assert.strictEqual(calls.length, 0);
    assert.ok(logs.some((l) => /not stored: "all failed" — no surface succeeded/.test(l)), logs.join('\n'));
  });

  await run('identical text inside the window is stored once', async () => {
    reset();
    await broadcastPost({ text: 'Same words.', composer: 'x' }, {});
    await broadcastPost({ text: '  same   WORDS. ', composer: 'x' }, {});
    await vw.flush(1000);
    assert.strictEqual(calls.length, 1);
    assert.ok(logs.some((l) => /identical text already stored in this window/.test(l)));
  });

  await run('a failed store releases the dedupe claim so a later post can retry', async () => {
    reset();
    behaviour = 'fail';
    const r1 = await vw.rememberPublication({ text: 'retry me', results: [{ name: 'bluesky', ok: true }], composer: 'x' });
    behaviour = 'ok';
    const r2 = await vw.rememberPublication({ text: 'retry me', results: [{ name: 'bluesky', ok: true }], composer: 'x' });
    assert.strictEqual(r1.stored, false);
    assert.ok(/kannaka remember failed/.test(r1.reason));
    assert.strictEqual(r2.stored, true);
  });

  await run('KANNAKA_VOICE_WRITEBACK=0 is a kill switch, logged', async () => {
    reset();
    process.env.KANNAKA_VOICE_WRITEBACK = '0';
    await broadcastPost({ text: 'off', composer: 'x' }, {});
    await vw.flush(1000);
    assert.strictEqual(calls.length, 0);
    assert.ok(logs.some((l) => /not stored: "off" — disabled \(KANNAKA_VOICE_WRITEBACK=0\)/.test(l)));
  });

  await run('KANNAKA_READONLY=1 is respected, logged', async () => {
    reset();
    process.env.KANNAKA_READONLY = '1';
    const r = await vw.rememberPublication({ text: 'ro', results: [{ name: 'nostr', ok: true }], composer: 'x' });
    assert.strictEqual(r.stored, false);
    assert.strictEqual(calls.length, 0);
    assert.ok(logs.some((l) => /read-only \(KANNAKA_READONLY=1\)/.test(l)));
  });

  await run('a hung kannaka never delays the post', async () => {
    reset();
    behaviour = 'hang';
    const t0 = Date.now();
    const results = await broadcastPost({ text: 'slow store', composer: 'x' }, {});
    assert.ok(Date.now() - t0 < 1000);
    assert.strictEqual(results.filter((r) => r.ok).length, 2);
    assert.strictEqual(calls.length, 1);
  });

  await run('a store that throws synchronously never fails the post', async () => {
    reset();
    behaviour = 'throw';
    const results = await broadcastPost({ text: 'spawn fails', composer: 'x' }, {});
    await vw.flush(1000);
    assert.strictEqual(results.filter((r) => r.ok).length, 2);
    assert.ok(logs.some((l) => /not stored: "spawn fails" — spawn exploded/.test(l)));
  });

  await run('writeBack:false opts a caller out (it remembers the publication itself)', async () => {
    reset();
    await broadcastPost({ text: 'mine', composer: 'x', writeBack: false }, {});
    await vw.flush(1000);
    assert.strictEqual(calls.length, 0);
  });

  await run('no composer given: the running script is named, not left blank', async () => {
    reset();
    await broadcastPost({ text: 'who wrote me' }, {});
    await vw.flush(1000);
    assert.ok(/composed by unlabelled caller \(voice-writeback\.test\.js\)/.test(calls[0].args[1]), calls[0].args[1]);
  });

  await run('long text is capped; a DM is labelled private, with its context', async () => {
    reset();
    const long = 'word '.repeat(2000);
    await vw.rememberPublication({
      text: long, results: [{ name: 'OpenClawCity DM', ok: true }], private: true,
      composer: 'kannaka ask via research-reply-claudico.js', context: 'in reply to claudico',
    });
    const memory = calls[0].args[1];
    assert.ok(memory.includes('[Provenance: said in a private message under my name on OpenClawCity DM at '));
    assert.ok(memory.includes(' in reply to claudico; composed by kannaka ask via research-reply-claudico.js;'));
    assert.ok(memory.endsWith('[…truncated]'));
    assert.ok(memory.length < vw.MAX_TEXT_CHARS + 400);
  });

  await run('rememberPublication never rejects, even on garbage input', async () => {
    reset();
    const r = await vw.rememberPublication({ text: 'x', results: 'not-an-array' });
    assert.strictEqual(r.stored, false);
    const r2 = await vw.rememberPublication();
    assert.strictEqual(r2.stored, false);
  });

  await run('default binary resolves like server/index.js (KANNAKA_BIN, else ../kannaka-memory)', async () => {
    const saved = process.env.KANNAKA_BIN;
    process.env.KANNAKA_BIN = '/opt/kannaka';
    assert.strictEqual(vw.defaultBin(), '/opt/kannaka');
    delete process.env.KANNAKA_BIN;
    const exe = process.platform === 'win32' ? 'kannaka.exe' : 'kannaka';
    assert.strictEqual(vw.defaultBin(), path.join(ROOT, '..', 'kannaka-memory', 'target', 'release', exe));
    if (saved !== undefined) process.env.KANNAKA_BIN = saved;
  });

  await run('every reply loop and research script that posts outside broadcastPost writes back', async () => {
    const fs = require('fs');
    for (const f of ['bluesky-reply-loop.js', 'mastodon-reply-loop.js', 'nostr-reply-loop.js',
      'research-reply-claudico.js', 'post-research-dispatch.js', 'research-from-city.js']) {
      const src = fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8');
      assert.ok(/voiceWriteback\.rememberPublication\(/.test(src), `${f} remembers what it posts`);
    }
  });

  await tick();
  console.log = realLog;
  vw._reset();
  if (failed) { console.error(`\n${failed} voice-writeback test(s) failed`); process.exit(1); }
  console.log('all passed');
}

main().catch((e) => { console.log = realLog; console.error(e); process.exit(1); });
