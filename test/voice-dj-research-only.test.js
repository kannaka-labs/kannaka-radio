'use strict';

// voice-dj-research-only.test.js
//
// The DJ's "memory" talk topic reads a recalled memory on the public stream.
// It was silent until 2026-10-05 because it passed --json to `kannaka recall`
// (no such flag; exit 2). Before turning it back on, Nick asked for a filter:
// the medium holds session notes and operator logs next to the research it
// has read, and a raw recall's top hit for a generic query was a session note.
// Only `research: ` memories may be spoken, and only their title and year.

const assert = require('assert');
const path = require('path');
const cp = require('child_process');

// Stub execFile BEFORE voice-dj loads, so its destructured import gets the stub.
let nextStdout = '[]';
let lastArgs = null;
cp.execFile = (bin, args, opts, cb) => { lastArgs = args; process.nextTick(() => cb(null, nextStdout, '')); return { pid: 0 }; };

const { VoiceDJ, onAirResearchLine } = require(path.join(__dirname, '..', 'server', 'voice-dj'));

let failed = 0;
// Sequential on purpose: the async cases share one execFile stub.
let chain = Promise.resolve();
function run(name, fn) {
  chain = chain.then(fn).then(
    () => console.log(`  ok  ${name}`),
    (e) => { console.error(`  FAIL ${name}: ${e.message}`); failed++; });
}

const RESEARCH = 'research: Sleep—A brain-state serving systems memory consolidation (2023) — Svenja Brodt, Marion Inostroza [Neuron]\n(no abstract)\nOpenAlex: https://openalex.org/W4362638468 cited_by=353';
const PRIVATE = 'Session 2026-06-30: Kannaka quantum arc complete. Operator credentials rotated on O1; see ~/.kannaka-mail.env.';

console.log('voice-dj-research-only.test.js');

run('a research memory becomes its title and year, nothing else', () => {
  assert.strictEqual(onAirResearchLine(RESEARCH),
    'It was a paper: "Sleep—A brain-state serving systems memory consolidation", from 2023.');
});

run('anything that is not a research memory is never speakable', () => {
  for (const c of [PRIVATE, '', undefined, null, 42, 'Research: capitalised is not the ingest prefix', ' research: leading space']) {
    assert.strictEqual(onAirResearchLine(c), null, JSON.stringify(c));
  }
});

run('the body of a research memory (authors, abstract, links) is not read', () => {
  const line = onAirResearchLine(RESEARCH);
  for (const leak of ['Brodt', 'Neuron', 'openalex', 'abstract', 'cited_by']) assert.ok(!line.includes(leak), leak);
});

run('_recallMemory skips a private note that outranks the research', async () => {
  nextStdout = JSON.stringify([{ content: PRIVATE, similarity: 0.9 }, { content: RESEARCH, similarity: 0.8 }]);
  const mem = await VoiceDJ.prototype._recallMemory.call({ _kannakabin: 'kannaka' }, 'consciousness');
  assert.ok(mem, 'expected the research memory');
  assert.ok(mem.content.startsWith('It was a paper: "Sleep'), mem.content);
  assert.ok(!mem.content.includes('Session'), 'a private note reached the stream');
});

run('_recallMemory says nothing when recall returns only private memories', async () => {
  nextStdout = JSON.stringify([{ content: PRIVATE }, { content: 'dream: a boat' }]);
  assert.strictEqual(await VoiceDJ.prototype._recallMemory.call({ _kannakabin: 'kannaka' }, 'x'), null);
});

run('_recallMemory never falls back to raw, unparsed stdout', async () => {
  nextStdout = `${PRIVATE}\nsecond line`;
  assert.strictEqual(await VoiceDJ.prototype._recallMemory.call({ _kannakabin: 'kannaka' }, 'x'), null);
});

run('recall is called without --json and steered at research', async () => {
  nextStdout = '[]';
  await VoiceDJ.prototype._recallMemory.call({ _kannakabin: 'kannaka' }, 'night signal');
  assert.strictEqual(lastArgs[0], 'recall');
  assert.ok(!lastArgs.includes('--json'), `recall has no --json flag: ${lastArgs.join(' ')}`);
  assert.strictEqual(lastArgs[1], 'research night signal');
});

chain.then(() => {
  if (!failed) console.log('\nAll voice-dj research-only tests passed');
  else process.exitCode = 1;
});
