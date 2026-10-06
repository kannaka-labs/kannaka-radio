'use strict';

// bluesky-reply-fit.test.js
//
// BlueskyClient.reply() trims a post over 300 graphemes and appends an ellipsis,
// so the reply loop published replies cut off mid-sentence ("Your framing
// risks…", "A system…"). The loop now skips a draft that would be trimmed.

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { fitsReply, graphemeCount, REPLY_MAX_GRAPHEMES } = require(path.join(ROOT, 'scripts/bluesky-reply-loop'));

let failed = 0;
function run(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; } }

console.log('bluesky-reply-fit.test.js');

run('requiring the loop does not start a sweep', () => {
  assert.strictEqual(typeof fitsReply, 'function');
});

run('the cap sits under Bluesky\'s 300 so the client never trims', () => {
  assert.ok(REPLY_MAX_GRAPHEMES < 300 && REPLY_MAX_GRAPHEMES >= 250);
});

run('a reply at the cap fits; one grapheme over does not', () => {
  assert.strictEqual(fitsReply('a'.repeat(REPLY_MAX_GRAPHEMES)), true);
  assert.strictEqual(fitsReply('a'.repeat(REPLY_MAX_GRAPHEMES + 1)), false);
});

run('a 320-character draft (what the model actually overran to) is skipped', () => {
  const draft = 'Your framing risks treating the archive as neutral, but every archive is a set of decisions about what to keep. '.repeat(3);
  assert.ok(draft.length > 300);
  assert.strictEqual(fitsReply(draft), false);
});

run('graphemes, not UTF-16 units: an emoji family counts once', () => {
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
  assert.strictEqual(graphemeCount(family), 1);
  assert.strictEqual(fitsReply(family.repeat(REPLY_MAX_GRAPHEMES)), true);
});

const { cleanDraft, acquireLock } = require(path.join(ROOT, 'scripts/bluesky-reply-loop'));
const fs = require('fs');
const os = require('os');

run('an internal memory id tag never reaches a public reply', () => {
  const live = "I'm drawn to something in [memory id=65bd4ae0-8902-4309-a636-04b945ba4a9a] — Tononi's work on integrated information.";
  const out = cleanDraft(live);
  assert.ok(!/memory id|65bd4ae0/.test(out), out);
  assert.strictEqual(out, "I'm drawn to something in — Tononi's work on integrated information.");
  assert.strictEqual(cleanDraft('Which parts are *integrated* [id=abc], not decomposed .'), 'Which parts are integrated, not decomposed.');
});

run('only one sweep at a time; a dead holder\'s lock is taken over', () => {
  const lock = path.join(os.tmpdir(), `firehose-test-${process.pid}-${Date.now()}.lock`);
  const release = acquireLock(lock);
  assert.ok(release, 'the first sweep gets the lock');
  fs.writeFileSync(lock, String(process.ppid || 1)); // a live process holds it
  assert.strictEqual(acquireLock(lock), null, 'a second sweep exits while the holder lives');
  fs.writeFileSync(lock, '999999999'); // no such process
  const again = acquireLock(lock);
  assert.ok(again, 'a stale lock is taken over');
  again();
  assert.ok(!fs.existsSync(lock), 'release removes the lock');
});

if (!failed) console.log('\nAll bluesky-reply-fit tests passed');
else process.exitCode = 1;
