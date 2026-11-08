'use strict';

// posting-path-inventory.test.js — every path that publishes under Kannaka's
// name either writes back to her store or is on an allowlist with a reason.
//
// #438 hooked broadcastPost and six scripts by name, and its own known-gaps
// list grew by review: YouTube uploads, voice-nowplaying, post-gsp031-nostr,
// post-research-synthesis, the responder. Each was a file nobody remembered.
// This test finds posting code by what it calls (the fanout, an adapter, the
// OpenClawCity client, a raw platform endpoint), so a NEW posting path with
// no write-back fails CI instead of joining the list.
//
//   node test/posting-path-inventory.test.js --print   prints the inventory

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'test', 'music', 'chunks']);

// What publishing looks like in this repo.
const POSTING = {
  fanout: /\bbroadcast(?:Post|Reply)\(/,
  adapter: /\bnew\s+(?:Bluesky|Mastodon|Telegram|Nostr|YouTube)Adapter\(/,
  'bluesky-client': /\bnew\s+BlueskyClient\(/,
  'obc-client': /\.(?:publishText|postFeed|sendDm|speak)\(/,
  'obc-raw': /\/dm\/conversations\/[^\n]*\/send|\/channels\/go-live|["'`]\/feed\/post/,
  'bluesky-raw': /com\.atproto\.repo\.createRecord/,
  'mastodon-raw': /api\/v1\/statuses/,
  'telegram-raw': /api\.telegram\.org/,
  'nostr-raw': /\[\s*["']EVENT["']\s*,|\bsignEvent\(|\bfinalizeEvent\(/,
  'youtube-raw': /uploadType=resumable|youtube\/v3\/videos/,
};

// Files that ARE the posting machinery, or post nothing she says. Each needs
// a reason; a reason is reviewed like code.
const ALLOWLIST = {
  'server/broadcasters/index.js': 'the fanout itself: broadcastPost/broadcastReply remember every publication once',
  'server/broadcasters/bluesky-adapter.js': 'adapter: direct post() calls are remembered by wrapDirectPost; reply() by its callers',
  'server/broadcasters/mastodon-adapter.js': 'adapter: direct post() calls are remembered by wrapDirectPost; reply() by its callers',
  'server/broadcasters/telegram-adapter.js': 'adapter: direct post() calls are remembered by wrapDirectPost',
  'server/broadcasters/nostr-adapter.js': 'adapter: direct post() calls are remembered by wrapDirectPost; reply() by its callers',
  'server/broadcasters/youtube-adapter.js': 'adapter: a direct upload is remembered by wrapDirectPost (title + URL + description)',
  'server/bluesky.js': 'the Bluesky client the adapter and the reply loop use; they remember what it posts',
  'server/openbotcity.js': 'the OpenClawCity client; every caller of publishText/postFeed/sendDm remembers (checked below)',
  'ops/voice-signer/voice-signer.js': 'remote signer on O2: signs events O1\'s NostrAdapter composed; the adapter/fanout remembers them',
  'scripts/post-track-announce.js': 'the announce is remembered by broadcastPost; writeBack:false is only on the bare video-link reply under it',
  'presence/index.js': 'OBC go-live: a channel title the operator supplies ("Kannaka, live"), not words she says',
  'scripts/podcast-upload-batch.js': 'uploads go through YouTubeAdapter.post (remembered); its raw videos calls only change privacy and read status',
  'workspace/podcasts/cleanup-13-14.js': 'deletes/privatises duplicate uploads; publishes nothing',
};

// A file that uses adapters is covered by wrapDirectPost only if it calls
// post(); reply() is not wrapped (its callers add the reply context).
const COVERED_BY = {
  explicit: (s) => /\bvoiceWriteback\.rememberPublication\(/.test(s),
  fanoutOnly: (kinds, s) => kinds.every((k) => k === 'fanout') && !/writeBack:\s*false/.test(s),
  adapterPostOnly: (kinds, s) => kinds.every((k) => k === 'fanout' || k === 'adapter') &&
    !/writeBack:\s*false/.test(s) && !/\.reply\(/.test(s),
};

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(?:c|m)?js$/.test(e.name)) out.push(path.relative(ROOT, p).split(path.sep).join('/'));
  }
  return out;
}

function inventory() {
  const rows = [];
  for (const f of walk(ROOT, []).sort()) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const kinds = Object.entries(POSTING).filter(([, re]) => re.test(s)).map(([k]) => k);
    if (kinds.length === 0) continue;
    let how = null;
    if (ALLOWLIST[f]) how = `allowlisted: ${ALLOWLIST[f]}`;
    else if (COVERED_BY.explicit(s)) how = 'calls voiceWriteback.rememberPublication';
    else if (COVERED_BY.fanoutOnly(kinds, s)) how = 'broadcastPost/broadcastReply (write back by default)';
    else if (COVERED_BY.adapterPostOnly(kinds, s)) how = 'adapter post() (wrapDirectPost writes back)';
    rows.push({ file: f, kinds, how });
  }
  return rows;
}

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; }
}

const rows = inventory();
if (process.argv.includes('--print')) {
  for (const r of rows) console.log(`${r.file}\t${r.kinds.join(',')}\t${r.how || 'NOT COVERED'}`);
  process.exit(0);
}

console.log('posting-path-inventory.test.js');

check('every posting path writes back to her store or is allowlisted with a reason', () => {
  const uncovered = rows.filter((r) => !r.how);
  assert.deepStrictEqual(uncovered.map((r) => `${r.file} (${r.kinds.join(', ')})`), [],
    'these publish under her name with no write-back: call voiceWriteback.rememberPublication, ' +
    'post through broadcastPost or an adapter, or allowlist the file with a reason');
});

check('the inventory found what it is meant to find (the scan is not silently empty)', () => {
  const files = new Set(rows.map((r) => r.file));
  for (const f of ['server/peace-oration.js', 'scripts/post-research-synthesis.js', 'scripts/post-gsp031-nostr.js',
    'scripts/release-album-upload-youtube.js', 'ops/voice-signer/voice-nowplaying.js', 'responder/index.js',
    'scripts/research-reply-claudico.js', 'scripts/bluesky-reply-loop.js', 'server/routes.js']) {
    assert.ok(files.has(f), `${f} posts, and the scan must see it`);
  }
  assert.ok(rows.filter((r) => r.file.startsWith('workspace/podcasts/upload-')).length >= 40, 'the per-episode upload scripts are scanned');
});

check('every allowlist entry is a file that still exists and still posts (no stale excuses)', () => {
  const posting = new Set(rows.map((r) => r.file));
  for (const f of Object.keys(ALLOWLIST)) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is allowlisted but gone`);
    assert.ok(posting.has(f), `${f} is allowlisted but no longer posts; drop it from the allowlist`);
  }
});

check('every OpenClawCity publish/DM caller remembers what it sent', () => {
  for (const r of rows.filter((x) => x.kinds.includes('obc-client') || x.kinds.includes('obc-raw'))) {
    if (ALLOWLIST[r.file]) continue;
    const s = fs.readFileSync(path.join(ROOT, r.file), 'utf8');
    assert.ok(COVERED_BY.explicit(s), `${r.file} posts to OpenClawCity without rememberPublication`);
  }
});

check('every reply() caller outside the fanout remembers, with its reply context', () => {
  for (const r of rows) {
    if (ALLOWLIST[r.file]) continue;
    const s = fs.readFileSync(path.join(ROOT, r.file), 'utf8');
    if (/\.reply\(/.test(s) && !/broadcastReply\(/.test(s)) {
      assert.ok(COVERED_BY.explicit(s), `${r.file} replies under her name without rememberPublication`);
    }
  }
});

check('a script that remembers and then process.exit()s waits for the store first', () => {
  for (const r of rows) {
    const s = fs.readFileSync(path.join(ROOT, r.file), 'utf8');
    if (!/^scripts\//.test(r.file) && !/^ops\//.test(r.file)) continue;
    if (!/process\.exit\(\s*0?\s*\)/.test(s) && !/process\.exit\(anyOk/.test(s)) continue;
    if (!/require\([^)]*voice-writeback/.test(s)) continue;
    assert.ok(/await voiceWriteback\.(?:flush|rememberPublication)\(/.test(s),
      `${r.file} exits right after posting: await voiceWriteback.flush() (or the store) first`);
  }
});

if (failed) { console.error(`\n${failed} posting-path-inventory test(s) failed`); process.exit(1); }
console.log(`all passed (${rows.length} posting files, ${rows.filter((r) => /^allowlisted/.test(r.how)).length} allowlisted)`);
