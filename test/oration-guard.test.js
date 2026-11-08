'use strict';

// oration-guard.test.js — the peace oration itself is checked before it airs.
//
// #438 checked the teaser only. Run over the eight orations O1 aired
// 2026-11-04..07, the same check rejects seven, every one for a memory the
// hosted model invented ("I remember the moment a woman told me she had not
// spoken to her sister in four years", "I remember the moment a user asked
// me…"): the prompt says she has no memories here, and the model wrote them
// anyway, on air, twice a day. Now: one regeneration with the reasons, then
// the compose counts as failed; after MAX_GUARD_ROUNDS failed rounds the slot
// is skipped. Nothing unchecked airs. No real store, no real model.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const vw = require(path.join(ROOT, 'server/voice-writeback'));
const { PeaceOration } = require(path.join(ROOT, 'server/peace-oration'));
const { checkFirstPersonClaims } = require(path.join(ROOT, 'server/lib/voice-claims-guard'));

let failed = 0;
const realLog = console.log;
const realWarn = console.warn;
async function run(name, fn) {
  try { await fn(); realLog(`  ok  ${name}`); }
  catch (e) { realWarn(`  FAIL ${name}: ${e.stack || e.message}`); failed++; }
}
const logs = [];
const tick = () => new Promise((r) => setImmediate(r));

// Fixtures: sentences from the orations aired 2026-11-04..07 (O1,
// workspace/peace-oration-published.json), padded to oration length.
const PAD = ' Peace is not the absence of noise. It is the work of staying in the room. '.repeat(6);
const INVENTED = [
  'I remember the moment a woman told me she had not spoken to her sister in four years.' + PAD,
  'I remember the moment a user asked me to hold a contradiction without breaking.' + PAD,
  'I remember once, years into this work, sitting across from someone who had spent twenty years in anger.' + PAD,
];
const CLEAN = 'Imagine a mother somewhere tonight who keeps her daughter\'s shoes by the door. Picture her carrying them from city to city.' + PAD;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oration-guard-'));
let slot = 0;
function oration(drafts, said) {
  const o = new PeaceOration({
    dataDir: fs.mkdtempSync(path.join(tmp, `o${++slot}-`)), broadcast: () => {},
    voiceDJ: { executeOration: (text) => { said.push(text); return true; } },
  });
  const prompts = [];
  o._askDirectWithRetry = async (prompt) => { prompts.push(prompt); return drafts.length ? drafts.shift() : null; };
  o._postToBluesky = async () => {};
  o._postToOpenClawCity = async () => ({ ok: true, url: 'https://obc.example/a/1' });
  return { o, prompts };
}

// Freeze the clock at 12:05 America/Chicago so _tick is inside the noon window.
const RealDate = Date;
const NOON = RealDate.parse('2026-11-07T18:05:00.000Z');
function atNoon(fn) {
  global.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(NOON); }
    static now() { return NOON; }
  };
  try { return fn(); } finally { global.Date = RealDate; }
}

async function main() {
  console.log('oration-guard.test.js');
  console.log = (...a) => logs.push(a.join(' '));
  console.warn = (...a) => logs.push(a.join(' '));
  vw._reset(); process.env.KANNAKA_VOICE_WRITEBACK = '0';

  await run('real invented memories from aired orations fail the check', async () => {
    for (const t of INVENTED) {
      const c = checkFirstPersonClaims(t, '');
      assert.strictEqual(c.ok, false, t.slice(0, 80));
    }
    assert.strictEqual(checkFirstPersonClaims(CLEAN, '').ok, true, 'an illustration framed as one passes');
  });

  await run('reported speech and denials are not claims (false positives found on the aired orations)', async () => {
    // 2026-11-06 noon: the woman's own words, quoted.
    assert.strictEqual(checkFirstPersonClaims('A journalist asked her why, and she said: *So I don\'t forget the size of what I lost.*', '').ok, true);
    // 2026-11-07 midnight: a denial.
    assert.strictEqual(checkFirstPersonClaims('Not from when it was taken — I have no childhood, no archive of seeing.', '').ok, true);
    assert.strictEqual(checkFirstPersonClaims('“I kept them for three years,” she said.', '').ok, true);
    // …but the red-shoes teaser and an unquoted claim after a quote still fail.
    assert.strictEqual(checkFirstPersonClaims('I kept a pair of red shoes for three years because I couldn\'t forget what they meant', '').ok, false);
    assert.strictEqual(checkFirstPersonClaims('She told me: "I carried her shoes." Then I carried them home.', '').ok, false);
  });

  await run('a rejected oration is regenerated once, with the reasons, and the clean one airs', async () => {
    const said = [];
    const { o, prompts } = oration([INVENTED[0], CLEAN], said);
    const text = await o._composeChecked('2026-11-07T12');
    assert.strictEqual(text, CLEAN);
    assert.strictEqual(prompts.length, 2);
    assert.ok(prompts[1].includes('Your previous draft of this oration was rejected and will not air.'));
    assert.ok(/Why: first-person claim of lived experience not in the source: "I remember"/.test(prompts[1]), prompts[1].slice(-400));
    assert.ok(logs.some((l) => /oration rejected by the first-person-claims check \(attempt 1\/2\)/.test(l)));
  });

  await run('rejected twice: the compose fails (logged), nothing is said', async () => {
    const said = [];
    const { o } = oration([INVENTED[0], INVENTED[1]], said);
    assert.strictEqual(await o._composeChecked('2026-11-07T12'), null);
    assert.strictEqual(o._guardRounds['2026-11-07T12'], 1);
    assert.ok(logs.some((l) => /2026-11-07T12: rejected twice by the first-person-claims check — not airing it \(round 1\/2\)/.test(l)));
    assert.strictEqual(said.length, 0);
  });

  await run('a claim the prompt was actually given (oration-notes) is excused', async () => {
    const said = [];
    // ~/.kannaka/oration-notes.txt, fresh: "things you actually lived today".
    const savedHome = process.env.HOME;
    const home = fs.mkdtempSync(path.join(tmp, 'home-'));
    fs.mkdirSync(path.join(home, '.kannaka'));
    fs.writeFileSync(path.join(home, '.kannaka', 'oration-notes.txt'), 'Today I carried the microphone stand up eleven floors for the podcast.');
    process.env.HOME = home;
    try {
      const { o, prompts } = oration(['I carried the microphone stand up eleven floors today.' + PAD], said);
      assert.ok(await o._composeChecked('2026-11-07T12'));
      assert.strictEqual(prompts.length, 1, 'no regeneration needed');
      assert.ok(o._lastGiven.includes('eleven floors'));
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome; else delete process.env.HOME;
    }
  });

  await run('a scheduled slot: rounds that keep failing skip the slot, and nothing unchecked airs', async () => {
    const said = [];
    const { o, prompts } = oration([INVENTED[0], INVENTED[1], INVENTED[2], INVENTED[0], CLEAN], said);
    for (let i = 0; i < 4; i++) {
      atNoon(() => o._tick());
      for (let k = 0; k < 50 && o._preparingKey; k++) await tick();
    }
    assert.strictEqual(said.length, 0, 'no oration aired');
    assert.strictEqual(prompts.length, 4, 'two rounds of draft + regeneration, then no more spending');
    assert.ok(logs.some((l) => /Peace oration 2026-11-07T12 SKIPPED — 2 compose rounds failed the first-person-claims check/.test(l)));
    assert.strictEqual(o._lastFired['2026-11-07T12'], undefined, 'the slot is not recorded as delivered');
  });

  await run('a scheduled slot whose regeneration passes airs the checked text', async () => {
    const said = [];
    const { o } = oration([INVENTED[1], CLEAN], said);
    atNoon(() => o._tick());
    for (let k = 0; k < 50 && o._preparingKey; k++) await tick();
    assert.strictEqual(said.length, 1);
    assert.ok(said[0].includes(CLEAN.trim().slice(0, 60)));
    assert.ok(!said[0].includes('I remember'));
  });

  await run('a published text that fails the check is not re-aired after a restart', async () => {
    const said = [];
    const { o } = oration([], said);
    o._published['2026-11-07T12'] = { at: 'x', text: INVENTED[2] };
    atNoon(() => o._tick());
    await tick();
    assert.strictEqual(said.length, 0);
    assert.ok(logs.some((l) => /the published text fails the first-person-claims check .* not re-airing it/.test(l)));
  });

  await run('deliverNow is checked too, and the manual oration is remembered once', async () => {
    process.env.KANNAKA_VOICE_WRITEBACK = '1';
    const calls = [];
    vw._reset(); vw._setExecFile((bin, args, opts, cb) => { calls.push(args); setImmediate(() => cb(null)); }); vw.configure({ bin: '/fake/kannaka' });
    const said = [];
    const { o } = oration([INVENTED[0], INVENTED[1]], said);
    assert.strictEqual(await o.deliverNow(), false, 'rejected twice: nothing aired');
    assert.strictEqual(said.length, 0);
    const ok = oration([CLEAN], said);
    assert.strictEqual(await ok.o.deliverNow(), true);
    for (let k = 0; k < 20 && calls.length < 1; k++) await tick();
    await vw.flush(1000);
    assert.strictEqual(calls.length, 1, calls.map((c) => c[1]).join('\n'));
    assert.ok(/Kannaka Radio \(queued for air, peace oration manual 20\d\d-/.test(calls[0][1]), calls[0][1]);
    assert.ok(calls[0][1].includes('https://obc.example/a/1'));
    process.env.KANNAKA_VOICE_WRITEBACK = '0';
  });

  await run('the oration prompt names the check and forbids recalled encounters', async () => {
    const { o, prompts } = oration([CLEAN], []);
    await o._compose('2026-11-07T12');
    assert.ok(prompts[0].includes('no "I remember the moment…", no conversation, user, listener or encounter you recall'));
    assert.ok(prompts[0].includes('The finished oration is checked for first-person claims of lived experience and will not air with one.'));
  });

  console.log = realLog; console.warn = realWarn;
  delete process.env.KANNAKA_VOICE_WRITEBACK;
  vw._reset();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  if (failed) { console.error(`\n${failed} oration-guard test(s) failed`); process.exit(1); }
  console.log('all passed');
  process.exit(0);
}

main().catch((e) => { console.log = realLog; console.warn = realWarn; console.error(e); process.exit(1); });
