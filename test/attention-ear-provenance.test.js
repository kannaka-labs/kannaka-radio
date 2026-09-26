/**
 * attention-ear-provenance.test.js — KANNAKA.attention.ear must carry MEASURED
 * perception, never the mock placeholder (#124).
 *
 * hearTrack() seeds `current` with generateMockPerception() synchronously and
 * only fills in `kannaka hear` output ~500ms later. server/index.js used to
 * read getCurrentPerception() immediately after calling it, so the attention
 * bus received fabricated tempo/centroid/RMS/pitch on every track change and
 * never once saw a real measurement.
 *
 * perception.js already refuses to CACHE mock numbers ("fabricated numbers are
 * exactly what we're trying to stop") — this closes the same hole on the wire.
 */

'use strict';

const assert = require('assert');
const path = require('path');
const { PerceptionEngine } = require('../server/perception');

let passed = 0;
let failed = 0;

function test(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

const TRACK = { title: 'T', album: 'Ghost Signals', file: 't.mp3' };

(async () => {
  console.log('\nattention-ear-provenance.test.js');

  // A binary that cannot exist, so `kannaka hear` fails and perception stays
  // mock — the state in which NOTHING should be published.
  const engine = new PerceptionEngine({
    kannakabin: path.join(__dirname, '__no_such_kannaka__', 'kannaka'),
    getMusicDir: () => path.join(__dirname, '__no_such_music__'),
    getCurrentTrack: () => TRACK,
    broadcast: () => {},
  });

  let hookCalls = [];
  engine.hearTrack(TRACK, (perc) => hookCalls.push(perc));

  // The mock is installed synchronously — that is the value the old code read.
  const immediate = engine.getCurrentPerception();
  test('#124 getCurrentPerception() right after hearTrack() is the MOCK',
    !!immediate && immediate.source !== 'kannaka-ear',
    `source=${immediate && immediate.source} — if this is already real, the test no longer proves anything`);

  await new Promise((r) => setTimeout(r, 1200));

  test('#124 the real-perception hook does NOT fire when analysis fails',
    hookCalls.length === 0,
    `hook fired ${hookCalls.length}x with ${JSON.stringify(hookCalls[0] && hookCalls[0].source)}`);

  test('#124 no hook call ever carries mock-sourced perception',
    hookCalls.every((p) => p && p.source === 'kannaka-ear'),
    `sources=${JSON.stringify(hookCalls.map((p) => p && p.source))}`);

  // The publisher itself must reject anything not measured.
  const src = require('fs').readFileSync(
    path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  test('#124 publishEarAttention refuses non-measured perception',
    /perc\.source !== "kannaka-ear"\) return;/.test(src),
    'the publisher needs its own guard, not just a well-behaved caller');
  test('#124 the ear envelope forwards provenance to subscribers',
    /source: perc\.source,/.test(src),
    'a subscriber should not have to assume the numbers were measured');
  test('#124 neither track-change path reads perception synchronously any more',
    !/hearTrack\(actual\);\s*\n\s*(?:const perc|.*getCurrentPerception)/.test(src) &&
    // onTrackHeard publishes the ear event and stores the memory (#289);
    // track-memory-store.test.js pins that it still calls publishEarAttention.
    (src.match(/hearTrack\(actual, \(perc\) => (?:publishEarAttention|onTrackHeard)\(actual, perc\)/g) || []).length === 2,
    'both the talk-segment and normal track-change paths should use the hook');

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  Attention ear provenance: ${passed} passed, ${failed} failed`);
  console.log(`${'─'.repeat(50)}`);
  process.exit(failed === 0 ? 0 : 1);
})();
