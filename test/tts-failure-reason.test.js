'use strict';
/**
 * tts-failure-reason.test.js — a failed engine says what went wrong (#308).
 *
 * execFile builds `err.message` as `Command failed: <cmd> <args>\n<stderr>`,
 * and edge-tts takes the utterance as an argument, so for a peace oration the
 * command line is three thousand words long and the child's stderr sits at the
 * very end of the message.
 *
 * The old log line cut that message to sixty characters, which is shorter than
 * the command, so every oration failure on 2026-09-12 recorded
 *
 *   edge(Command failed: /home/opc/.local/bin/edge-tts --voice en-GB-)
 *
 * and nothing else. The cause was unrecoverable from the journal, which is why
 * the duplicate-publication bug (#307) went four days without a diagnosis.
 */

const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

let failures = 0;
const pending = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      // An async case whose result nobody awaits is a case that cannot fail.
      pending.push(r.then(
        () => console.log("  ok   " + name),
        (e) => { failures++; console.error("  FAIL " + name + "\n       " + e.message); },
      ));
    } else {
      console.log("  ok   " + name);
    }
  } catch (e) { failures++; console.error("  FAIL " + name + "\n       " + e.message); }
}

// ── The shape of a real execFile failure ─────────────────────────────────
const ORATION = 'peace is not the absence of war '.repeat(120); // ~3,600 chars
const STDERR = [
  'Traceback (most recent call last):',
  '  File "edge_tts/communicate.py", line 1, in <module>',
  'edge_tts.exceptions.NoAudioReceived: No audio was received from the service',
].join('\n');

function execFileError({ cmd = '/home/opc/.local/bin/edge-tts', args = ['--voice', 'en-GB-SoniaNeural', '--text', ORATION], code = 1, killed = false, signal = null } = {}) {
  const e = new Error(`Command failed: ${cmd} ${args.join(' ')}\n${STDERR}`);
  e.code = code;
  e.killed = killed;
  e.signal = signal;
  return e;
}

const { execReason, failureReason, synthesize } = require('../server/voice-engine');

console.log('tts-failure-reason');

test('the reason is the stderr, not the command we already know', () => {
  const r = execReason(execFileError(), STDERR);
  assert.ok(r.includes('NoAudioReceived'), `expected the real error, got: ${r}`);
  assert.ok(r.includes('exit 1'), 'and the exit status');
});

test('the utterance never reaches the log', () => {
  const r = failureReason(execFileError());
  assert.ok(!r.includes('peace is not the absence of war'),
    'a three-thousand-word oration must not be echoed into a log line');
  assert.ok(!r.includes('--voice'), 'nor the command line');
  assert.ok(r.length <= 320, `bounded, got ${r.length}`);
});

test('an engine-supplied reason survives even without stderr in hand', () => {
  const err = execFileError();
  err.reason = 'edge exit 1: NoAudioReceived';
  assert.strictEqual(failureReason(err), 'edge exit 1: NoAudioReceived');
});

test('a raw command echo is stripped down to its stderr tail', () => {
  const r = failureReason(execFileError());
  assert.ok(r.includes('NoAudioReceived'), `expected the stderr tail, got: ${r}`);
});

test('a killed child says it timed out, not exit 1', () => {
  const r = execReason(execFileError({ killed: true, signal: 'SIGTERM' }), '');
  assert.ok(/timed out/.test(r), r);
});

test('a missing binary says so, with the path', () => {
  const e = new Error('spawn edge-tts ENOENT');
  e.code = 'ENOENT';
  e.path = 'edge-tts';
  const r = execReason(e, '');
  assert.ok(r.includes('not installed'), r);
  assert.ok(r.includes('edge-tts'), r);
});

test('only the last few stderr lines are kept', () => {
  const noisy = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
  const r = execReason(execFileError(), noisy);
  assert.ok(r.includes('line 49'), 'the end is where the error is');
  assert.ok(!r.includes('line 0'), 'the start is preamble');
});

test('a plain message is not chopped at sixty characters', () => {
  const msg = 'piper not available because the model file for the oration persona is missing from disk';
  assert.strictEqual(failureReason(new Error(msg)), msg);
});

test('no stderr at all still names the exit status', () => {
  assert.strictEqual(execReason(execFileError({ code: 127 }), ''), 'exit 127');
});

// ── End to end: the line that was actually wrong ─────────────────────────
// Patch execFile BEFORE voice-engine captures it, so synthesize's own
// failure path is what gets measured rather than a helper in isolation.
test('all engines failed carries the cause, not the command', () => {
  const realExecFile = cp.execFile;
  cp.execFile = (cmd, args, opts, done) => {
    const fn = typeof opts === 'function' ? opts : done;
    process.nextTick(() => fn(execFileError({ cmd, args }), '', STDERR));
    return { stdin: { on() {}, write() {}, end() {} } };
  };
  delete require.cache[require.resolve('../server/voice-engine')];
  try {
    const fresh = require('../server/voice-engine');
    let seen = null;
    fresh.synthesize(
      { text: ORATION, persona: 'oration', outPath: path.join(os.tmpdir(), 'tts-reason-test.mp3') },
      (err) => { seen = err; },
    );
    return new Promise((resolve) => setTimeout(resolve, 150)).then(() => {
      assert.ok(seen, 'it should fail');
      assert.ok(seen.message.includes('NoAudioReceived'),
        `the journal line must carry the cause; got: ${seen.message.slice(0, 200)}`);
      assert.ok(!seen.message.includes('peace is not the absence of war'),
        'and must not carry the utterance');
    });
  } finally {
    cp.execFile = realExecFile;
    delete require.cache[require.resolve('../server/voice-engine')];
  }
});

Promise.all(pending).then(() => {
  if (failures) { console.error(`tts-failure-reason: ${failures} failed`); process.exit(1); }
  console.log('tts-failure-reason: all passed');
});
