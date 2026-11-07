'use strict';

// oration-teaser-guard.test.js — a reported story stays the other person's.
//
// 2026-11-06 noon: the oration (hosted model, no HRM, told "You have access to
// your own memory" and drawn the framing "Begin with a memory — yours") said
// "I remember reading about a woman in Aleppo who kept her daughter's shoes…
// Red. She carried them for three years." The teaser, fed the first 500 chars
// and told "one image, one sharp line", turned it into "I kept a pair of red
// shoes for three years because I couldn't forget what they meant" and it was
// posted under her name to Bluesky, Mastodon, Telegram and Nostr.

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// Never write to a real kannaka store from a test.
process.env.KANNAKA_VOICE_WRITEBACK = '0';
const { checkFirstPersonClaims } = require(path.join(ROOT, 'server/lib/voice-claims-guard'));
const { PeaceOration, teaserSource, FRAMINGS } = require(path.join(ROOT, 'server/peace-oration'));

let failed = 0;
const realLog = console.log;
const realWarn = console.warn;
async function run(name, fn) {
  try { await fn(); realLog(`  ok  ${name}`); }
  catch (e) { realLog(`  FAIL ${name}: ${e.message}`); failed++; }
}

// The opening of the 2026-11-06 noon oration, padded past the old 500-char
// cut so the story sits where the teaser model used to see only half of it.
const PREAMBLE = 'Peace is not the silence after the guns. It is the work that begins when the guns are still loud, ' +
  'the work of people who refuse to let the noise decide who they are. ';
const STORY = 'I remember reading about a woman in Aleppo who kept her daughter\'s shoes after the bombing. ' +
  'Small shoes. Red. She carried them for three years, from shelter to shelter, because putting them down ' +
  'meant admitting something she could not admit.';
const ORATION = PREAMBLE.repeat(3) + STORY + ' That is what violence costs. Peace asks us to set the weight down together.';
const RED_SHOES_TEASER = 'I kept a pair of red shoes for three years because I couldn\'t forget what they meant';
const BENIGN = 'Peace is not the silence after the guns. It is the work that starts while they are still loud. Twice a day I stop the music to say so. Come listen.';
const ATTRIBUTED = 'A woman in Aleppo carried her daughter\'s red shoes for three years. Today\'s oration asks what it would take to set them down together.';

function oration() {
  const o = new PeaceOration({ kannakabin: '/nonexistent', voiceDJ: null, broadcast: () => {}, dataDir: require('os').tmpdir() });
  return o;
}

async function main() {
  console.log('oration-teaser-guard.test.js');

  await run('the red-shoes teaser is rejected against its own oration', () => {
    const r = checkFirstPersonClaims(RED_SHOES_TEASER, ORATION);
    assert.strictEqual(r.ok, false);
    const all = r.reasons.join('\n');
    assert.ok(/not in the source: "I kept"/.test(all), all);
    assert.ok(/for three years/.test(all), 'the first-person duration is named');
    assert.ok(/speaker swap: the source says someone else "kept"/.test(all), 'the speaker swap is named');
  });

  await run('a benign teaser passes', () => {
    assert.deepStrictEqual(checkFirstPersonClaims(BENIGN, ORATION), { ok: true, reasons: [] });
  });

  await run('the same image, kept attributed, passes', () => {
    assert.deepStrictEqual(checkFirstPersonClaims(ATTRIBUTED, ORATION), { ok: true, reasons: [] });
    const reported = 'I read about a woman in Aleppo who carried her daughter\'s red shoes for three years. Noon\'s oration is for her.';
    assert.deepStrictEqual(checkFirstPersonClaims(reported, ORATION), { ok: true, reasons: [] });
  });

  await run('other first-person bodily / possessive / past claims fail', () => {
    for (const bad of [
      'I carried them from shelter to shelter.',
      'My daughter\'s shoes are still by the door.',
      'I held my mother\'s hand the night the power went out.',
      'I\'ve walked through cities like that. Listen tonight.',
    ]) {
      assert.strictEqual(checkFirstPersonClaims(bad, ORATION).ok, false, bad);
    }
  });

  await run('a first-person phrase the source itself uses is allowed', () => {
    // The oration says "I remember reading about…"; echoing it is not a new claim.
    assert.strictEqual(checkFirstPersonClaims('I remember reading about shoes like that. Tune in.', ORATION).ok, true);
  });

  await run('the teaser model sees the whole oration, not a 500-char cut', async () => {
    const o = oration();
    const prompts = [];
    o._askDirectWithRetry = async (p) => { prompts.push(p); return BENIGN; };
    const r = await o._draftCheckedTeaser(ORATION);
    assert.strictEqual(r.text, BENIGN);
    assert.ok(ORATION.indexOf('She carried them') > 500, 'fixture puts the story past the old cut');
    assert.ok(prompts[0].includes('She carried them for three years'), 'the story arrives with its subject');
    assert.ok(/Never turn a third-person story into "I" or "my"/.test(prompts[0]));
  });

  await run('a rejected teaser is regenerated once, with the reasons', async () => {
    const o = oration();
    const prompts = [];
    const drafts = [RED_SHOES_TEASER, ATTRIBUTED];
    o._askDirectWithRetry = async (p) => { prompts.push(p); return drafts.shift(); };
    console.warn = () => {};
    const r = await o._draftCheckedTeaser(ORATION);
    console.warn = realWarn;
    assert.strictEqual(r.text, ATTRIBUTED);
    assert.strictEqual(prompts.length, 2);
    assert.ok(prompts[1].includes('Your previous draft was rejected'));
    assert.ok(prompts[1].includes('I kept'));
  });

  await run('rejected twice: no teaser goes out, and the skip says why', async () => {
    const o = oration();
    o._askDirectWithRetry = async () => RED_SHOES_TEASER;
    const warned = [];
    console.warn = (...a) => warned.push(a.join(' '));
    const r = await o._draftCheckedTeaser(ORATION);
    console.warn = realWarn;
    assert.ok(!r.text);
    assert.strictEqual(r.skip, 'teaser failed the first-person-claims check twice');
    assert.strictEqual(warned.filter((w) => /teaser rejected/.test(w)).length, 2);
  });

  await run('a long oration is excerpted on sentence boundaries', () => {
    const long = 'This is one sentence of the oration. '.repeat(400);
    const s = teaserSource(long);
    assert.ok(s.length <= 6002, `${s.length}`);
    assert.ok(/oration\. …$/.test(s), 'ends on a whole sentence');
    assert.strictEqual(teaserSource('Short. Whole.'), 'Short. Whole.');
  });

  await run('the oration prompt no longer claims memory it is not given, and logs its framing', async () => {
    assert.ok(!FRAMINGS.some((f) => /\byours\b/i.test(f)), 'no framing asks for "your" memory');
    const o = oration();
    let prompt = null;
    o._askDirectWithRetry = async (p) => { prompt = p; return 'x'.repeat(300); };
    const logged = [];
    console.log = (...a) => logged.push(a.join(' '));
    await o._compose('2026-11-06T12');
    console.log = realLog;
    assert.ok(!/You have access to your own memory/.test(prompt));
    assert.ok(!/something you actually remember/.test(prompt));
    assert.ok(/you are an AI/.test(prompt));
    assert.ok(/keep its attribution and its uncertainty/.test(prompt));
    assert.ok(/Never claim you kept, held, carried/.test(prompt));
    assert.ok(logged.some((l) => /\[oration\] framing drawn: "/.test(l)), 'framing is logged');
  });

  if (failed) { console.error(`\n${failed} oration-teaser-guard test(s) failed`); process.exit(1); }
  console.log('all passed');
}

main().catch((e) => { console.log = realLog; console.warn = realWarn; console.error(e); process.exit(1); });
