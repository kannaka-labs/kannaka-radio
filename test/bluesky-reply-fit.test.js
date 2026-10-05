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

if (!failed) console.log('\nAll bluesky-reply-fit tests passed');
else process.exitCode = 1;
