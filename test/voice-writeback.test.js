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
const { broadcastPost, broadcastReply } = require(path.join(ROOT, 'server/broadcasters'));

let failed = 0;
async function run(name, fn) {
  try { await fn(); realLog(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; }
}

// ── harness ─────────────────────────────────────────────────────────────
let calls = [];
let behaviour = 'ok'; // 'ok' | 'fail' | 'hang' | 'throw' | 'manual'
let held = []; // 'manual': callbacks the test releases itself
function fakeExecFile(bin, args, opts, cb) {
  calls.push({ bin, args, opts });
  if (behaviour === 'throw') throw new Error('spawn exploded');
  if (behaviour === 'hang') return;
  if (behaviour === 'manual') { held.push(cb); return; }
  setImmediate(() => cb(behaviour === 'fail' ? Object.assign(new Error('boom'), { code: 1 }) : null, '', ''));
}
const logs = [];
const realLog = console.log;
function reset() {
  vw._reset();
  vw._setExecFile(fakeExecFile);
  vw.configure({ bin: '/fake/kannaka' });
  calls = []; behaviour = 'ok'; held = []; logs.length = 0;
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
    Cls.prototype.reply = async function () {
      return { ok: true, url: `https://${name}.example/reply/1` };
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

  await run('default binary is the one server/index.js resolves (read from its source)', async () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    const m = src.match(/const KANNAKA_BIN = ([\s\S]*?);\r?\n/);
    assert.ok(m, 'server/index.js defines KANNAKA_BIN');
    // Evaluate server/index.js's own expression with its BASE_DIR (the repo root).
    const serverBin = () => new Function('process', 'path', 'BASE_DIR', `return ${m[1]};`)(process, path, ROOT);
    const saved = process.env.KANNAKA_BIN;
    try {
      process.env.KANNAKA_BIN = '/opt/kannaka';
      assert.strictEqual(vw.defaultBin(), serverBin());
      delete process.env.KANNAKA_BIN;
      assert.strictEqual(path.resolve(vw.defaultBin()), path.resolve(serverBin()));
    } finally {
      if (saved !== undefined) process.env.KANNAKA_BIN = saved; else delete process.env.KANNAKA_BIN;
    }
  });

  await run('source check: every script posting outside broadcastPost writes back with its own binary', async () => {
    const fs = require('fs');
    for (const f of ['bluesky-reply-loop.js', 'mastodon-reply-loop.js', 'nostr-reply-loop.js',
      'research-reply-claudico.js', 'post-research-dispatch.js', 'research-from-city.js']) {
      const src = fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8');
      assert.ok(/voiceWriteback\.rememberPublication\(/.test(src), `${f} remembers what it posts`);
      assert.ok(/voiceWriteback\.configure\(\{ bin: KANNAKA_BIN \}\)/.test(src), `${f} remembers with the binary it asks with`);
    }
  });

  await run('broadcastReply writes back ONCE, as a reply, with the reply links', async () => {
    reset();
    const prior = [{ name: 'bluesky', ok: true }, { name: 'mastodon', ok: true }];
    const replies = await broadcastReply(prior, 'Listen at noon.', { composer: 'test composer' });
    await vw.flush(1000);
    assert.strictEqual(replies.filter((r) => r.ok).length, 2);
    assert.strictEqual(calls.length, 1);
    const memory = calls[0].args[1];
    assert.ok(memory.includes('as a reply under my own earlier post;'), memory);
    assert.ok(memory.includes('https://bluesky.example/reply/1') && memory.includes('https://mastodon.example/reply/1'));
  });

  await run('the post link is kept in the memory; template copy is stored light', async () => {
    reset();
    await broadcastPost({ text: 'Now playing: a song', link: 'https://radio.example/', composer: 'template', template: true }, {});
    await vw.flush(1000);
    assert.ok(calls[0].args[1].includes('https://radio.example/'), calls[0].args[1]);
    assert.strictEqual(calls[0].args[3], vw.TEMPLATE_IMPORTANCE.toFixed(2));
    reset();
    await broadcastPost({ text: 'her own words', composer: 'kannaka ask' }, {});
    await vw.flush(1000);
    assert.strictEqual(calls[0].args[3], vw.IMPORTANCE.toFixed(2));
  });

  await run('stores run one at a time (the CLI takes no write lock for remember)', async () => {
    reset();
    behaviour = 'manual';
    const ok = [{ name: 'bluesky', ok: true }];
    const a = vw.rememberPublication({ text: 'first', results: ok, composer: 'x' });
    const b = vw.rememberPublication({ text: 'second', results: ok, composer: 'x' });
    await tick(); await tick();
    assert.strictEqual(calls.length, 1, 'the second store waits for the first');
    held.shift()(null);
    await a; await tick();
    assert.strictEqual(calls.length, 2);
    held.shift()(null);
    assert.strictEqual((await b).stored, true);
  });

  await run('a private message keeps its text off the swarm bus; a public one does not ask to', async () => {
    reset();
    const saved = process.env.KANNAKA_EVENTS_REMEMBER;
    delete process.env.KANNAKA_EVENTS_REMEMBER;
    try {
      await vw.rememberPublication({ text: 'dm', results: [{ name: 'OpenClawCity DM', ok: true }], private: true, composer: 'x' });
      await vw.rememberPublication({ text: 'post', results: [{ name: 'bluesky', ok: true }], composer: 'x' });
      assert.strictEqual(calls[0].opts.env.KANNAKA_EVENTS_REMEMBER, 'ids');
      assert.strictEqual(calls[1].opts.env.KANNAKA_EVENTS_REMEMBER, undefined);
    } finally {
      if (saved !== undefined) process.env.KANNAKA_EVENTS_REMEMBER = saved;
    }
  });

  await run('the dedupe map forgets entries older than the window', async () => {
    reset();
    process.env.KANNAKA_VOICE_WRITEBACK_DEDUPE_MS = '1';
    const ok = [{ name: 'bluesky', ok: true }];
    await vw.rememberPublication({ text: 'old', results: ok, composer: 'x' });
    await new Promise((r) => setTimeout(r, 10));
    await vw.rememberPublication({ text: 'new', results: ok, composer: 'x' });
    assert.strictEqual(vw._recentSize(), 1, 'only the fresh entry is kept');
  });

  await run('a scheduled oration ends in exactly two memories: its teaser and itself', async () => {
    reset();
    const os = require('os');
    const fs = require('fs');
    const { PeaceOration } = require(path.join(ROOT, 'server/peace-oration'));
    const o = new PeaceOration({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vw-oration-')), voiceDJ: null, broadcast: () => {} });
    o._askDirectWithRetry = async () => 'Twice a day I stop the music to speak for peace. Come listen.';
    o._postToOpenClawCity = async () => ({ ok: true, url: 'https://obc.example/a/1' });
    const realWarn = console.warn; console.warn = () => {};
    o._publishOnce('2026-11-06T12', 'Peace is the work that begins while the guns are loud.');
    for (let i = 0; i < 200 && calls.length < 2; i++) await tick();
    await vw.flush(1000);
    await tick();
    console.warn = realWarn;
    assert.strictEqual(calls.length, 2, calls.map((c) => c.args[1]).join('\n'));
    const [teaser, oration] = calls[0].args[1].includes('teaser') ? [calls[0], calls[1]] : [calls[1], calls[0]];
    assert.ok(/composed by hosted model via peace-oration teaser/.test(teaser.args[1]), teaser.args[1]);
    assert.ok(/Kannaka Radio \(queued for air, peace oration 2026-11-06T12\)/.test(oration.args[1]), oration.args[1]);
    assert.ok(oration.args[1].includes('https://obc.example/a/1'));
  });

  await tick();
  console.log = realLog;
  vw._reset();
  if (failed) { console.error(`\n${failed} voice-writeback test(s) failed`); process.exit(1); }
  console.log('all passed');
}

main().catch((e) => { console.log = realLog; console.error(e); process.exit(1); });
