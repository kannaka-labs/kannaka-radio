/**
 * track-change-side-effects.test.js — both track-change paths must fire the
 * same listener-visible side effects (#140).
 *
 * onTrackChange has two branches: one that runs after a DJ talk segment, and
 * the normal one. They have now drifted in BOTH directions:
 *
 *   #140 — the talk-segment branch never called icecast-metadata.updateMetadata,
 *          so every track following a DJ segment left /stream and /preview
 *          listeners looking at the PREVIOUS track's now-playing text.
 *   #124 — the mirror image: the talk-segment branch published an ear attention
 *          event and the normal branch published none.
 *
 * A comment asking future editors to keep them in sync has demonstrably not
 * been enough, so this asserts it structurally.
 *
 * Source-level by necessity: the branches live inside a DJEngine callback in
 * server/index.js, which cannot be driven without booting the whole station.
 * The assertions are deliberately about CALL SITES, not helpers — the drift
 * has always been a missing call, never a broken function.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}: ${e.message}`); failed++; }
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');

/** The talk-segment branch: from executeTalkSegment( to its closing `});`. */
function talkSegmentBranch() {
  const start = SRC.indexOf('voiceDJ.executeTalkSegment(actual');
  assert.ok(start > 0, 'could not locate the talk-segment branch');
  // The normal branch begins at the "Normal track change flow" marker.
  const end = SRC.indexOf('Normal track change flow', start);
  assert.ok(end > start, 'could not locate the end of the talk-segment branch');
  return SRC.slice(start, end);
}

function normalBranch() {
  const start = SRC.indexOf('Normal track change flow');
  assert.ok(start > 0, 'could not locate the normal track-change branch');
  return SRC.slice(start, start + 4000);
}

console.log('\ntrack-change-side-effects.test.js');

test('#140 the talk-segment path refreshes Icecast metadata', () => {
  assert.ok(/updateMetadata\(actual\)/.test(talkSegmentBranch()),
    'a track airing after a DJ segment must update now-playing, or listeners ' +
    'keep seeing the previous track');
});

test('#140 the normal path still refreshes Icecast metadata', () => {
  assert.ok(/updateMetadata\(actual\)/.test(normalBranch()),
    'the path that already worked must keep working');
});

test('#140 exactly the two track-change paths refresh metadata', () => {
  const hits = (SRC.match(/updateMetadata\(actual\)/g) || []).length;
  assert.strictEqual(hits, 2,
    `expected one call per track-change branch, found ${hits}`);
});

test('#124 both paths publish an ear attention event (the mirror drift)', () => {
  // onTrackHeard wraps publishEarAttention (#289), pinned in track-memory-store.test.js.
  assert.ok(/(?:publishEarAttention|onTrackHeard)\(actual, perc\)/.test(talkSegmentBranch()),
    'talk-segment path lost its ear publish');
  assert.ok(/(?:publishEarAttention|onTrackHeard)\(actual, perc\)/.test(normalBranch()),
    'normal path lost its ear publish');
});

test('both paths announce the change to sync clients', () => {
  assert.ok(/syncManager\.trackChanged\(actual\.file\)/.test(talkSegmentBranch()));
  assert.ok(/syncManager\.trackChanged\(actual\.file\)/.test(normalBranch()));
});

test('both paths publish the track change to Flux', () => {
  assert.ok(/flux\.publishTrackChange\(actual\)/.test(talkSegmentBranch()));
  assert.ok(/flux\.publishTrackChange\(actual\)/.test(normalBranch()));
});

console.log(`\n${'─'.repeat(50)}`);
console.log(`  Track-change side effects: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(50)}`);
if (failed > 0) process.exit(1);
