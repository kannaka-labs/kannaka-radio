'use strict';
/**
 * oration-label-by-persona.test.js — a long-form segment airs under its own name.
 *
 * executeOration carries the peace oration, the news bulletin and the gossip
 * column. Its inject call hardcoded the label "Kannaka — Peace Oration", so
 * the 16:20 gossip column (2026-10-14) and every news bulletin showed up in
 * now-playing, the icecast title and the [sound] bed log as a Peace Oration.
 * The label now follows the persona.
 */

const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { VoiceDJ, orationLabel } = require('../server/voice-dj');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

function airAs(persona) {
  const metas = [];
  const dj = Object.create(VoiceDJ.prototype);
  Object.assign(dj, {
    _enabled: true, _isLive: () => false, _inTalkSegment: false, _speaking: false,
    _broadcast: () => {}, _rememberMonologue: () => {},
    _kannakabin: path.join(os.tmpdir(), 'no-such-kannaka-binary'),
    _generateTTS: (text, cb) => cb(null, path.join(os.tmpdir(), 'oration-label.wav'), text),
    _getIcecastSource: () => ({ injectAudio: (p, meta, cb) => { metas.push(meta); cb(); } }),
  });
  const opts = persona ? { persona } : undefined;
  const ok = dj.executeOration('a few words for the segment', () => {}, opts);
  assert.strictEqual(ok !== false, true, 'executeOration must accept the segment');
  assert.strictEqual(metas.length, 1, 'the segment must be injected once');
  return metas[0];
}

console.log('oration-label-by-persona');

check('the gossip column airs as the gossip column', () => {
  const m = airAs('gossip');
  assert.strictEqual(m.label, 'Kannaka — Gossip Column');
  assert.strictEqual(m.kind, 'gossip');
});
check('a news bulletin airs as news', () => {
  assert.strictEqual(airAs('news').label, 'Gene — News Desk');
});
check('the peace oration keeps its label', () => {
  assert.strictEqual(airAs('oration').label, 'Kannaka — Peace Oration');
});
check('no persona defaults to the oration, as the voice does', () => {
  assert.strictEqual(airAs(undefined).label, 'Kannaka — Peace Oration');
});
check('an unknown persona falls back to the oration label, not undefined', () => {
  assert.strictEqual(orationLabel('mystery'), 'Kannaka — Peace Oration');
});
check('every long-form persona in voice-personas.json except dj has its own label', () => {
  const personas = Object.keys(require('../server/voice-personas.json')).filter((k) => k !== 'dj' && !k.startsWith('_'));
  const labels = personas.map(orationLabel);
  assert.strictEqual(new Set(labels).size, personas.length, `labels collide: ${JSON.stringify(labels)}`);
});

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("all passed");
// executeOration arms a 720 s ceiling timer after the inject; exit rather than wait it out.
process.exit(0);
