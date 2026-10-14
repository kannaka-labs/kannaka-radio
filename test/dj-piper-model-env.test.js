'use strict';
/**
 * dj-piper-model-env.test.js — DJ_PIPER_MODEL puts a trained voice on the DJ.
 *
 * 2026-10-14: Kannaka's own Piper voice (kannaka-medium-e7009, 330 epochs over
 * amy-medium) is installed on O1 next to the stock voices. The DJ persona's
 * model lives in server/voice-personas.json; switching voices by editing a
 * tracked file means a deploy for every A/B and every revert. The env var is
 * the lever: honored when the file exists, ignored with one warning when it
 * does not, and never applied to any persona but the DJ.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failures++; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('dj-piper-model-env');

const voices = fs.mkdtempSync(path.join(os.tmpdir(), 'piper-voices-'));
fs.writeFileSync(path.join(voices, 'kannaka-medium-e7009.onnx'), 'not a real model');
const savedDir = process.env.PIPER_VOICES_DIR;
const savedModel = process.env.DJ_PIPER_MODEL;
process.env.PIPER_VOICES_DIR = voices;

const ve = require('../server/voice-engine');
const warnings = [];
const origWarn = console.warn;
console.warn = (m) => warnings.push(String(m));

try {
  const configured = ve.resolvePersona('dj').piper.model;

  test('without DJ_PIPER_MODEL the DJ keeps the configured model', () => {
    delete process.env.DJ_PIPER_MODEL;
    assert.strictEqual(ve.resolvePersona('dj').piper.model, configured);
    assert.strictEqual(warnings.length, 0);
  });

  test('DJ_PIPER_MODEL naming an installed voice is honored', () => {
    process.env.DJ_PIPER_MODEL = 'kannaka-medium-e7009';
    assert.strictEqual(ve.resolvePersona('dj').piper.model, 'kannaka-medium-e7009');
    assert.strictEqual(ve.resolvePersona().piper.model, 'kannaka-medium-e7009', 'the implicit dj fallback too');
  });

  test('the override never touches the other personas', () => {
    process.env.DJ_PIPER_MODEL = 'kannaka-medium-e7009';
    for (const name of ['oration', 'gossip', 'news']) {
      const p = ve.resolvePersona(name);
      if (p.piper) assert.notStrictEqual(p.piper.model, 'kannaka-medium-e7009', name);
    }
  });

  test('a model that is not installed keeps the configured voice and warns once', () => {
    process.env.DJ_PIPER_MODEL = 'kannaka-medium-e9999';
    assert.strictEqual(ve.resolvePersona('dj').piper.model, configured);
    assert.strictEqual(ve.resolvePersona('dj').piper.model, configured);
    const hits = warnings.filter((w) => w.includes('DJ_PIPER_MODEL=kannaka-medium-e9999'));
    assert.strictEqual(hits.length, 1, `warned ${hits.length} times`);
    assert.ok(hits[0].includes(configured), 'the warning names the model that stays');
  });

  test('the persona object is not mutated in place', () => {
    process.env.DJ_PIPER_MODEL = 'kannaka-medium-e7009';
    ve.resolvePersona('dj');
    delete process.env.DJ_PIPER_MODEL;
    assert.strictEqual(ve.resolvePersona('dj').piper.model, configured);
  });
} finally {
  console.warn = origWarn;
  if (savedDir === undefined) delete process.env.PIPER_VOICES_DIR; else process.env.PIPER_VOICES_DIR = savedDir;
  if (savedModel === undefined) delete process.env.DJ_PIPER_MODEL; else process.env.DJ_PIPER_MODEL = savedModel;
  fs.rmSync(voices, { recursive: true, force: true });
}

if (failures) { console.error(`dj-piper-model-env: ${failures} failed`); process.exit(1); }
console.log('dj-piper-model-env: all passed');
