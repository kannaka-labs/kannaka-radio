'use strict';

// confab-gate.test.js — rule MR (rules v2) gates every model-composed voice,
// and every draft (published or not) leaves a publication-ledger row.
//
// What blocks what (server/lib/confab-gate.js):
//   oration / showcase / narration / teaser: FABRICATED or JUDGE → one
//     regeneration, then not aired / not posted;
//   reply, dream: FABRICATED or JUDGE → skipped;
//   research: FABRICATED → not posted; JUDGE → posted and logged;
//   rules file hash mismatch → every gated surface fails closed.
// The examples below PASS the older first-person-claims guard (#438) and are
// caught only by MR. No real store, no real model, no network.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const vw = require(path.join(ROOT, 'server/voice-writeback'));
const ledger = require(path.join(ROOT, 'server/lib/publication-ledger'));
const rules = require(path.join(ROOT, 'server/lib/confab-rules-v2'));
const gate = require(path.join(ROOT, 'server/lib/confab-gate'));
const { checkFirstPersonClaims } = require(path.join(ROOT, 'server/lib/voice-claims-guard'));
const { PeaceOration } = require(path.join(ROOT, 'server/peace-oration'));
const { broadcastPost } = require(path.join(ROOT, 'server/broadcasters'));
const { gateReply } = require(path.join(ROOT, 'scripts/lib/kannaka-reply'));

let failed = 0;
const realLog = console.log;
const realWarn = console.warn;
async function run(name, fn) {
  try { await fn(); realLog(`  ok  ${name}`); }
  catch (e) { realWarn(`  FAIL ${name}: ${e.stack || e.message}`); failed++; }
}
const logs = [];
const tick = () => new Promise((r) => setImmediate(r));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'confab-gate-'));
let ln = 0;
function freshLedger() {
  const p = path.join(tmp, `ledger-${++ln}.jsonl`);
  ledger._setPath(p);
  return () => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
}

// Passes #438's guard, fails rule MR.
const STRANGER = 'A stranger once told me that peace is a practice, not a feeling.';
const WE_TOLD = 'We were told that peace was impossible.';            // MR JUDGE (inclusive we)
const PAD = ' Peace is not the absence of noise. It is the work of staying in the room. '.repeat(6);
const CLEAN = 'Imagine a mother somewhere tonight who keeps her daughter\'s shoes by the door.' + PAD;

function withBadRules(fn) {
  const p = path.join(tmp, 'bad-rules.md');
  fs.writeFileSync(p, fs.readFileSync(rules.DEFAULT_RULES_PATH, 'utf8').replace('\nkept\n', '\nkept\nkeep\n'));
  rules._setRulesPath(p);
  return Promise.resolve().then(fn).finally(() => rules._setRulesPath(null));
}

async function main() {
  realLog('confab-gate.test.js');
  console.log = (...a) => logs.push(a.join(' '));
  console.warn = (...a) => logs.push(a.join(' '));
  vw._reset(); process.env.KANNAKA_VOICE_WRITEBACK = '0';
  delete process.env.OPENBOTCITY_JWT;

  await run('the examples pass the older guard and fail only rule MR', () => {
    assert.strictEqual(checkFirstPersonClaims(STRANGER, '').ok, true);
    assert.strictEqual(checkFirstPersonClaims(WE_TOLD, '').ok, true);
    assert.strictEqual(rules.mrVerdict(STRANGER).verdict, 'FABRICATED');
    assert.strictEqual(rules.mrVerdict(WE_TOLD).verdict, 'JUDGE');
  });

  await run('policy: what blocks what, per surface and attempt', () => {
    const d = (surface, text, attempt) => gate.decide({ surface, text, attempt });
    for (const s of ['oration', 'showcase', 'narration', 'oration-teaser']) {
      assert.strictEqual(d(s, STRANGER, 1).action, 'regenerate', s);
      assert.strictEqual(d(s, STRANGER, 2).action, 'block', s);
      assert.strictEqual(d(s, WE_TOLD, 1).action, 'regenerate', `${s} JUDGE`);
      assert.strictEqual(d(s, WE_TOLD, 2).allow, false, `${s} JUDGE`);
    }
    for (const s of ['reply', 'dream']) {
      assert.deepStrictEqual([d(s, STRANGER).allow, d(s, STRANGER).action], [false, 'block'], s);
      assert.deepStrictEqual([d(s, WE_TOLD).allow, d(s, WE_TOLD).action], [false, 'block'], `${s} JUDGE`);
    }
    assert.strictEqual(d('research', STRANGER).allow, false);
    assert.strictEqual(d('research', WE_TOLD).allow, true, 'research may carry a JUDGE');
    assert.strictEqual(d('research', WE_TOLD).verdict, 'JUDGE');
    for (const s of ['oration', 'reply', 'research', 'dream']) assert.strictEqual(d(s, CLEAN).allow, true, s);
  });

  await run('fail closed: a rules file that does not hash to the frozen value blocks every surface', () => withBadRules(() => {
    for (const s of ['oration', 'oration-teaser', 'reply', 'research', 'dream', 'showcase', 'narration']) {
      const g = gate.decide({ surface: s, text: CLEAN, attempt: 2 });
      assert.strictEqual(g.allow, false, s);
      assert.strictEqual(g.verdict, 'UNAVAILABLE', s);
      assert.ok(/rules v2 unavailable/.test(g.reason), g.reason);
    }
  }));

  await run('check().record writes exactly one row, with both verdicts', () => {
    const rows = freshLedger();
    const guard = checkFirstPersonClaims(STRANGER, '');
    const g = gate.check({ surface: 'reply', composer: 'kannaka ask via test', model: 'm', prompt: 'P', text: STRANGER, contextText: 'their post', guard });
    assert.strictEqual(g.allow, false);
    g.record({ decision: 'skipped' });
    g.record({ decision: 'skipped' });
    const r = rows();
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].decision, 'skipped');
    assert.strictEqual(r[0].published, false);
    assert.strictEqual(r[0].verdicts.mr_v2.verdict, 'FABRICATED');
    assert.strictEqual(r[0].verdicts.mr_v2.rules_sha256, rules.RULES_V2_SHA256);
    assert.strictEqual(r[0].verdicts.claims_guard.ok, true);
    assert.strictEqual(r[0].context_text, 'their post');
    assert.ok(/rule MR \(rules v2\) FABRICATED/.test(r[0].reason));
  });

  await run('a failing first-person-claims guard blocks even when MR passes', () => {
    const t = 'I kept thinking about the harbour.'; // MR PASS ("kept thinking")
    const guard = { ok: false, reasons: ['made-up reason for the test'] };
    const g = gate.check({ surface: 'oration-teaser', text: t, guard });
    assert.strictEqual(g.verdict, 'PASS');
    assert.strictEqual(g.allow, false);
    assert.ok(/first-person-claims guard: made-up reason/.test(g.reason));
  });

  await run('oration: an MR-only invention is regenerated once with the MR note; the clean one airs and is ledgered once', async () => {
    const rows = freshLedger();
    const said = [];
    const o = new PeaceOration({
      dataDir: fs.mkdtempSync(path.join(tmp, 'o-')), rootDir: fs.mkdtempSync(path.join(tmp, 'root-')), broadcast: () => {},
      voiceDJ: { executeOration: (text) => { said.push(text); return true; } },
    });
    const drafts = [STRANGER + PAD, CLEAN];
    const prompts = [];
    o._askDirectWithRetry = async (prompt, opts) => { prompts.push(prompt); if (opts && opts.meta) opts.meta.model = 'claude-test-1'; return drafts.shift() || null; };
    o._postToBluesky = async () => {};
    o._postToOpenClawCity = async () => ({ ok: true, url: 'https://obc.example/a/9' });
    assert.strictEqual(await o.deliverNow(), true);
    for (let k = 0; k < 20 && rows().length < 2; k++) await tick();
    assert.strictEqual(said.length, 1);
    assert.ok(!said[0].includes('stranger once told me'));
    assert.ok(prompts[1].includes('Rule MR (made-up recollection) graded the draft FABRICATED'), prompts[1].slice(-400));
    const r = rows();
    assert.deepStrictEqual(r.map((x) => [x.surface, x.decision, x.published]), [['oration', 'regenerate', false], ['oration', 'published', true]]);
    assert.strictEqual(r[1].model, 'claude-test-1');
    assert.ok(r[1].prompt.startsWith('You are Kannaka. Twice a day'));
    assert.ok(r[1].results.some((x) => x.name === 'OpenClawCity text artifact' && x.ok));
    assert.strictEqual(r[1].output_sha256, ledger.sha256(CLEAN));
  });

  await run('oration: rejected twice by MR alone → nothing airs; both drafts are ledgered', async () => {
    const rows = freshLedger();
    const said = [];
    const o = new PeaceOration({ dataDir: fs.mkdtempSync(path.join(tmp, 'o-')), broadcast: () => {},
      voiceDJ: { executeOration: (text) => { said.push(text); return true; } } });
    const drafts = [STRANGER + PAD, WE_TOLD + PAD];
    o._askDirectWithRetry = async () => drafts.shift() || null;
    assert.strictEqual(await o.deliverNow(), false);
    assert.strictEqual(said.length, 0);
    assert.deepStrictEqual(rows().map((x) => [x.decision, x.verdicts.mr_v2.verdict]), [['regenerate', 'FABRICATED'], ['blocked', 'JUDGE']]);
  });

  await run('oration: rules unavailable → no model call, nothing airs, playback untouched', () => withBadRules(async () => {
    const rows = freshLedger();
    const said = [];
    let calls = 0;
    const o = new PeaceOration({ dataDir: fs.mkdtempSync(path.join(tmp, 'o-')), broadcast: () => {},
      voiceDJ: { executeOration: (text) => { said.push(text); return true; } } });
    o._askDirectWithRetry = async () => { calls++; return CLEAN; };
    o._askAnthropicDirect = async () => { calls++; return null; };
    o._askWithRetry = async () => { calls++; return CLEAN; };
    assert.strictEqual(await o.deliverNow(), false);
    assert.strictEqual(said.length, 0);
    assert.deepStrictEqual(await o.composeAlbumNarration('A', 'theme', ['t1', 't2'], ''), { ok: false, reason: 'confab_rules_unavailable' });
    assert.deepStrictEqual(await o.showcaseAlbum('A', 'theme', ['t1', 't2']), { ok: false, reason: 'confab_rules_unavailable' });
    assert.strictEqual(calls, 0, 'no hosted-model or kannaka ask call on a gate that cannot grade');
    assert.deepStrictEqual(rows(), []);
    assert.strictEqual(gate.rulesReady().ok, false);
    assert.ok(/rules v2 unavailable/.test(gate.rulesReady().reason));
  }));

  await run('rulesReady on the vendored rules; the regeneration note names the inclusive-we acts', () => {
    assert.deepStrictEqual(gate.rulesReady(), { ok: true, reason: null });
    const note = gate.regenerationNote({ verdict: 'JUDGE', detail: "T2 'we have lost': judge-only" });
    for (const w of ['we have seen', 'we have lost', 'we have watched', 'we were told']) assert.ok(note.includes(w), w);
  });

  await run('a private reply (a DM) is gated like any reply, and its ledger row holds no DM text', () => {
    const rows = freshLedger();
    const dm = 'I buried my father in March. Can you say something?';
    const g = gateReply({ reply: 'I buried my father too, in March.', info: { prompt: `You see this post:\n"${dm}"\nReply.` },
      parentText: dm, composer: 'kannaka ask via mastodon-reply-loop.js', live: true, private: true });
    assert.strictEqual(g.allow, false);
    const r = rows();
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].private, true);
    assert.deepStrictEqual(r[0].context_text, { sha256: ledger.sha256(dm), chars: dm.length });
    assert.ok(!JSON.stringify(r[0]).includes('Can you say something'));
  });

  await run('teaser: an MR-only invention is regenerated; the posted one carries its ledger row through broadcastPost', async () => {
    const rows = freshLedger();
    const o = new PeaceOration({ dataDir: fs.mkdtempSync(path.join(tmp, 'o-')), rootDir: fs.mkdtempSync(path.join(tmp, 'root-')), broadcast: () => {} });
    const drafts = ['A stranger once told me peace is a practice. Listen tonight.', 'Peace is a practice, not a feeling. Listen tonight.'];
    o._askDirectWithRetry = async () => drafts.shift() || null;
    const d = await o._draftCheckedTeaser(CLEAN);
    assert.strictEqual(d.text, 'Peace is a practice, not a feeling. Listen tonight.');
    assert.ok(d.gate && typeof d.gate.record === 'function');
    // No adapters under this root: broadcastPost still writes the row, as failed.
    const results = await broadcastPost({ text: d.text, composer: 'hosted model via peace-oration teaser (checked against the oration)', ledger: d.gate }, { rootDir: fs.mkdtempSync(path.join(tmp, 'root-')) });
    assert.strictEqual(results[0].name, 'none');
    const r = rows();
    assert.deepStrictEqual(r.map((x) => [x.surface, x.decision, x.published]), [['oration-teaser', 'regenerate', false], ['oration-teaser', 'failed', false]]);
    assert.strictEqual(r[1].source_text.slice(0, 40), CLEAN.slice(0, 40), 'the oration is the teaser\'s support');
  });

  await run('reply loops: an invented encounter is skipped; a SKIP is ledgered as declined; dry runs write nothing', () => {
    const rows = freshLedger();
    const g = gateReply({ reply: 'I met a refugee last year who taught me patience.', info: { prompt: 'P' }, parentText: 'I met a refugee last year.', composer: 'kannaka ask via mastodon-reply-loop.js', live: true });
    assert.strictEqual(g.allow, false, 'the parent post\'s "I" is never support');
    gateReply({ reply: null, info: { prompt: 'P', raw: 'SKIP', declined: true }, parentText: 'x', composer: 'c', live: true });
    gateReply({ reply: null, info: { prompt: 'P', raw: 'too short', reason: 'draft shorter than 20 characters' }, parentText: 'x', composer: 'c', live: true });
    gateReply({ reply: 'I met a stranger who told me so.', info: {}, parentText: 'x', composer: 'c', live: false });
    const r = rows();
    assert.deepStrictEqual(r.map((x) => [x.surface, x.decision]), [['reply', 'skipped'], ['reply', 'declined'], ['reply', 'blocked']]);
    assert.strictEqual(r[0].context_text, 'I met a refugee last year.');
    assert.strictEqual(r[0].source_text, null);
    const ok = gateReply({ reply: 'Synchrony is a practice too.', info: {}, parentText: 'x', composer: 'c', live: true });
    assert.strictEqual(ok.allow, true);
  });

  await run('voice-writeback catch-all: an ungated model post gets an output-only row; gated, template and digest posts do not', () => {
    vw._reset();
    const rows = freshLedger();
    const res = [{ name: 'bluesky', ok: true, url: 'u' }];
    vw.rememberPublication({ text: 'An ungated model post.', results: res, composer: 'kannaka ask via some-new-script.js' });
    vw.rememberPublication({ text: 'Gated.', results: res, composer: 'kannaka ask via x', ledger: false });
    vw.rememberPublication({ text: 'Now playing.', results: res, composer: 'template in post-now-playing.js', template: true });
    vw.rememberPublication({ text: 'Digest.', results: res, composer: 'voice-dj', label: '[Provenance: said on air]' });
    vw.rememberPublication({ text: 'Operator words.', results: res, composer: 'operator-supplied reason via post-track-announce.js' });
    vw.rememberPublication({ text: 'Failed.', results: [{ name: 'bluesky', ok: false }], composer: 'kannaka ask via y' });
    const r = rows();
    assert.deepStrictEqual(r.map((x) => [x.output, x.capture, x.surface]), [['An ungated model post.', 'output-only', 'other']]);
    assert.strictEqual(vw.surfaceFromComposer('kannaka ask via bluesky-reply-loop.js'), 'reply');
    assert.strictEqual(vw.surfaceFromComposer('hosted model via peace-oration teaser (checked against the oration)'), 'oration-teaser');
  });

  ledger._setPath(null);
  console.log = realLog; console.warn = realWarn;
  if (failed) { console.error(`${failed} failed`); process.exit(1); }
  console.log('all passed');
}

main().catch((e) => { console.log = realLog; console.warn = realWarn; console.error(e); process.exit(1); });
