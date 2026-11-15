'use strict';

// oration-thread.test.js — the peace orations are one ongoing argument.
//
// Before 2026-11-15 each oration was composed from a self-contained prompt.
// Now a compose is given a note on every earlier oration, what her own store
// returns (read-only), and what was said back in public; the model writes
// the next note after a marker line, and that note must never reach the air,
// the gallery or her store. No real store, no real model, no network.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const T = require(path.join(ROOT, 'server/lib/oration-thread'));
const { PeaceOration } = require(path.join(ROOT, 'server/peace-oration'));

let failed = 0;
const realLog = console.log;
const realWarn = console.warn;
async function run(name, fn) {
  try { await fn(); realLog(`  ok  ${name}`); }
  catch (e) { realWarn(`  FAIL ${name}: ${e.stack || e.message}`); failed++; }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oration-thread-'));
let n = 0;
const dir = () => fs.mkdtempSync(path.join(tmp, `d${++n}-`));
const PAD = ' Peace is not the absence of noise. It is the work of staying in the room. '.repeat(6);
const SPOKEN = 'Imagine a street somewhere tonight where two neighbours have stopped speaking.' + PAD;

(async () => {
  console.log = () => {}; console.warn = () => {};

  await run('splitDraft cuts the note off the spoken text', () => {
    const { spoken, note } = T.splitDraft(`${SPOKEN}\n\n=== THREAD NOTE ===\nArgued that peace is practice. Left open: what it costs the tired.`);
    assert.strictEqual(spoken, SPOKEN.trim());
    assert.ok(/Left open/.test(note));
    assert.ok(!/THREAD NOTE/.test(spoken));
  });

  await run('splitDraft tolerates a sloppy marker and cuts everything after it', () => {
    const { spoken, note } = T.splitDraft(`${SPOKEN}\n  == thread note ==  \nfirst line\nsecond line`);
    assert.ok(!/first line/.test(spoken));
    assert.strictEqual(note, 'first line second line');
  });

  await run('no marker: the whole draft is spoken and the note is absent', () => {
    const { spoken, note } = T.splitDraft(SPOKEN);
    assert.strictEqual(spoken, SPOKEN);
    assert.strictEqual(note, null);
  });

  await run('record keeps one entry per slot and falls back when no note came', () => {
    const d = dir();
    T.record(d, { key: '2026-11-15T12', text: SPOKEN, note: 'Argued A. Left open B.' });
    T.record(d, { key: '2026-11-15T12', text: SPOKEN, note: 'a second note that must not replace the first' });
    T.record(d, { key: '2026-11-16T00', text: SPOKEN, note: null });
    const t = T.load(d);
    assert.strictEqual(t.entries.length, 2);
    assert.strictEqual(t.entries[0].note, 'Argued A. Left open B.');
    assert.strictEqual(t.entries[1].written_by, 'fallback');
    assert.ok(/no note was written/.test(t.entries[1].note));
  });

  await run('the prompt carries the newest notes within the budget and says how many are left out', () => {
    const thread = { entries: [] };
    for (let i = 0; i < 40; i++) thread.entries.push({ key: `k${i}`, note: `note ${i} ` + 'x'.repeat(480) });
    const { lines, omitted } = T.notesForPrompt(thread);
    assert.ok(lines.length < 40 && lines.length > 5);
    assert.strictEqual(omitted, 40 - lines.length);
    assert.ok(lines[lines.length - 1].startsWith('- k39:'), 'newest note is last');
    assert.ok(/older orations are not shown/.test(T.buildBlock({ thread }).block));
  });

  await run('replies: only public text that answers her, never her own, never old', () => {
    const now = new Date().toISOString();
    const arts = [
      { type: 'text', title: 'The Logic of the Microphone', content_excerpt: 'Kannaka speaks of peace as a choice.', creator: { display_name: 'Someone' }, created_at: now },
      { type: 'text', title: 'Peace Oration — Noon', content_excerpt: 'Kannaka on peace.', creator: { display_name: 'Kannaka' }, created_at: now },
      { type: 'image', title: 'Kannaka peace', content_excerpt: '', creator: { display_name: 'Other' }, created_at: now },
      { type: 'text', title: 'Old', content_excerpt: 'Kannaka and peace, long ago.', creator: { display_name: 'Other' }, created_at: '2020-01-01T00:00:00Z' },
      { type: 'text', title: 'Pigeons', content_excerpt: 'Kannaka points at the blank badges.', creator: { display_name: 'Other' }, created_at: now },
    ];
    const r = T.repliesFrom(arts, { since: new Date(Date.now() - 3600e3).toISOString() });
    assert.strictEqual(r.length, 1);
    assert.ok(/Logic of the Microphone/.test(r[0]));
    const { block } = T.buildBlock({ thread: { entries: [] }, replies: r });
    assert.ok(/Do not name the writer, do not quote them/.test(block));
    assert.ok(!/Someone/.test(block), 'the writer\'s name is not handed to the model');
  });

  await run('recall is read-only, unobserved, and survives a failing binary', async () => {
    let seen = null;
    const rows = await T.recallFromStore('/bin/kannaka', 'peace oration open question', {
      execFileImpl: (bin, args, opts, cb) => { seen = { args, env: opts.env }; cb(null, 'warming\n[{"content":"  Peace   oration text ","similarity":0.4},{"content":""}]'); },
    });
    assert.deepStrictEqual(seen.args.slice(0, 1), ['recall']);
    assert.strictEqual(seen.env.KANNAKA_READONLY, '1');
    assert.strictEqual(seen.env.KANNAKA_RECALL_OBSERVE, '0');
    assert.deepStrictEqual(rows, [{ content: 'Peace oration text', similarity: 0.4 }]);
    const none = await T.recallFromStore('/bin/kannaka', 'q', { execFileImpl: (b, a, o, cb) => cb(new Error('boom')) });
    assert.deepStrictEqual(none, []);
  });

  await run('the block asks for development and live contradiction, not consistency', () => {
    const { block } = T.buildBlock({ thread: { entries: [{ key: 'k1', note: 'Argued A.' }] }, recallRows: [{ content: 'a record' }] });
    assert.ok(/do not restart/i.test(block));
    assert.ok(/keep the contradiction in view/.test(block));
    assert.ok(/Never treat an earlier oration as settled truth/.test(block));
    assert.ok(/something you were told, not something you lived/.test(block));
  });

  await run('end to end: the note never airs or publishes, and the next compose is given it', async () => {
    const d = dir();
    const said = []; const published = []; const remembered = [];
    const o = new PeaceOration({ dataDir: d, broadcast: () => {}, voiceDJ: { executeOration: (text) => { said.push(text); return true; } } });
    const prompts = [];
    const drafts = [
      `${SPOKEN}\n\n=== THREAD NOTE ===\nArgued that peace is practised between neighbours. Left open: what it asks of the exhausted.`,
      `${SPOKEN} And there is more to say.\n\n=== THREAD NOTE ===\nTook up the exhausted. Disagrees with the first: practice is not always a choice.`,
    ];
    o._askDirectWithRetry = async (prompt) => { prompts.push(prompt); return drafts.shift(); };
    o._postToBluesky = async (t) => { published.push(t); };
    o._postToOpenClawCity = async (t) => { published.push(t); return { ok: true, url: 'https://obc.example/a/1' }; };
    o._rememberOration = async (k, t) => { remembered.push(t); };
    o._threadRecall = async () => [{ content: 'Peace oration, queued for air: neighbours.', similarity: 0.5 }];
    o._threadReplies = async () => ['A reply. Kannaka has no body and peace costs her nothing.'];

    const first = {};
    const t1 = await o._composeChecked('2026-11-15T12', first);
    assert.ok(t1 && !/THREAD NOTE|Left open/.test(t1), 'the note is cut before the check');
    assert.ok(/exhausted/.test(first.note));
    assert.ok(/BEGINS AN ONGOING ARGUMENT/.test(prompts[0]));
    assert.ok(/=== THREAD NOTE ===/.test(prompts[0]), 'the model is asked for the next note');
    o._composed = t1; o._composedFor = '2026-11-15T12'; o._composedNote = first.note; o._composedGiven = first.given;
    o._publishOnce('2026-11-15T12', t1);
    await new Promise((r) => setTimeout(r, 20));
    for (const t of [...published, ...remembered]) assert.ok(!/THREAD NOTE|Left open/.test(t), 'the note never leaves the building');
    assert.strictEqual(T.load(d).entries.length, 1);

    const second = {};
    const t2 = await o._composeChecked('2026-11-16T00', second);
    assert.ok(t2);
    assert.ok(/what it asks of the exhausted/.test(prompts[1]), 'the second compose is given the first note');
    assert.ok(/Kannaka has no body/.test(prompts[1]), 'and what was said back');
    assert.ok(/queued for air: neighbours/.test(prompts[1]), 'and what her store returned');
    assert.ok(/what it asks of the exhausted/.test(second.given), 'the notes count as given material for the claims check');
  });

  await run('ORATION_THREAD=0 or thread:false restores the self-contained prompt', async () => {
    const o = new PeaceOration({ dataDir: dir(), thread: false, broadcast: () => {}, voiceDJ: { executeOration: () => true } });
    const prompts = [];
    o._askDirectWithRetry = async (prompt) => { prompts.push(prompt); return SPOKEN; };
    assert.ok(await o._composeChecked('2026-11-15T12', {}));
    assert.ok(!/ONGOING ARGUMENT|THREAD NOTE/.test(prompts[0]));
  });

  await run('a thread source that throws leaves the oration self-contained, not silent', async () => {
    const o = new PeaceOration({ dataDir: dir(), broadcast: () => {}, voiceDJ: { executeOration: () => true } });
    o._threadMaterial = async () => { throw new Error('disk gone'); };
    o._askDirectWithRetry = async () => SPOKEN;
    assert.ok(await o._composeChecked('2026-11-15T12', {}));
  });

  console.log = realLog; console.warn = realWarn;
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed) { console.error(`oration-thread: ${failed} failed`); process.exit(1); }
  console.log('oration-thread: all passed');
})();
