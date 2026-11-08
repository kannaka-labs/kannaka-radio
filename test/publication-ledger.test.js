'use strict';

// publication-ledger.test.js — every model-composed publication leaves one
// append-only row: what the model was shown, what it wrote, the verdicts,
// and whether it went out. The ledger never throws, never holds a secret,
// stays bounded, and a test run never writes the station's real ledger.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ledger = require(path.join(ROOT, 'server/lib/publication-ledger'));

let failed = 0;
function run(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}: ${e.stack || e.message}`); failed++; }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-ledger-'));
let n = 0;
const fresh = () => { const p = path.join(tmp, `l${++n}`, 'publication-ledger.jsonl'); ledger._setPath(p); return p; };
const lines = (p) => fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

console.log('publication-ledger.test.js');
const realLog = console.log;

run('a test run never defaults to the repo workspace ledger', () => {
  ledger._setPath(null);
  const saved = process.env.KANNAKA_PUBLICATION_LEDGER;
  delete process.env.KANNAKA_PUBLICATION_LEDGER;
  try {
    const p = ledger.ledgerPath();
    assert.ok(p.startsWith(os.tmpdir()), p);
    assert.ok(!p.includes(path.join(ROOT, 'workspace')), p);
  } finally { if (saved !== undefined) process.env.KANNAKA_PUBLICATION_LEDGER = saved; }
});

run('one row per append, with the fields the rates need', () => {
  const p = fresh();
  const out = 'Peace is the decision, made again and again.';
  const r = ledger.append({
    surface: 'oration-teaser', composer: 'hosted model via test', model: 'claude-haiku-4-5',
    prompt: 'Draft ONE companion post.', recall_rows: ['I said: peace is a practice'], source_text: 'the oration',
    context_text: 'someone else\'s post', output: out,
    verdicts: { mr_v2: { verdict: 'PASS', detail: '' } },
    results: [{ name: 'bluesky', ok: true, url: 'https://bsky.example/1' }, { name: 'mastodon', ok: false, error: 'x' }],
  });
  assert.strictEqual(r.ok, true);
  const rows = lines(p);
  assert.strictEqual(rows.length, 1);
  const row = rows[0];
  for (const k of ['v', 'id', 'ts', 'surface', 'surfaces', 'composer', 'model', 'prompt', 'system', 'recall_rows',
    'source_text', 'context_text', 'output', 'output_sha256', 'verdicts', 'decision', 'published', 'reason', 'results', 'attempt', 'capture']) {
    assert.ok(k in row, `missing ${k}`);
  }
  assert.strictEqual(row.output_sha256, require('crypto').createHash('sha256').update(out).digest('hex'));
  assert.strictEqual(row.published, true, 'one surface took it');
  assert.strictEqual(row.decision, 'published');
  assert.deepStrictEqual(row.surfaces, ['bluesky', 'mastodon']);
  assert.deepStrictEqual(row.results[1], { name: 'mastodon', ok: false }, 'no error bodies in the ledger');
  assert.strictEqual(row.capture, 'full');
});

run('the file is created 0600 (POSIX)', () => {
  if (process.platform === 'win32') return;
  const p = fresh();
  ledger.append({ surface: 'reply', output: 'x' });
  assert.strictEqual(fs.statSync(p).mode & 0o777, 0o600);
});

run('secrets never reach the ledger: patterns and live env values', () => {
  const p = fresh();
  process.env.TEST_RADIO_API_TOKEN = 'zz-very-secret-value-1234';
  try {
    ledger.append({
      surface: 'research',
      prompt: [
        'key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
        'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
        'api_key = "hunter2hunter2"',
        'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlc2ln',
        'nostr nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
        'env zz-very-secret-value-1234',
      ].join('\n'),
      output: 'A post.',
    });
  } finally { delete process.env.TEST_RADIO_API_TOKEN; }
  const raw = fs.readFileSync(p, 'utf8');
  for (const s of ['sk-ant-api03', 'abcdefghijklmnopqrstuvwxyz012345', 'hunter2hunter2', 'eyJhbGciOiJIUzI1NiJ9', 'nsec1qqqq', 'zz-very-secret-value-1234']) {
    assert.ok(!raw.includes(s), `leaked: ${s}`);
  }
  assert.ok(raw.includes('Bearer [REDACTED]'));
  assert.ok(raw.includes('api_key = \\"[REDACTED]'), raw);
});

run('long fields are capped and marked; recall rows bounded', () => {
  const p = fresh();
  ledger.append({ surface: 'oration', prompt: 'p'.repeat(ledger.FIELD_CAP + 500), recall_rows: Array.from({ length: 80 }, (_, i) => `row ${i}`), output: 'o' });
  const row = lines(p)[0];
  assert.ok(row.prompt.length < ledger.FIELD_CAP + 100);
  assert.ok(/truncated 500 chars/.test(row.prompt));
  assert.strictEqual(row.recall_rows.length, 50);
  assert.deepStrictEqual(row.truncated.sort(), ['prompt', 'recall_rows']);
});

run('rotation: past the cap the file moves to .1, .2 …, keeping N', () => {
  const p = fresh();
  process.env.KANNAKA_PUBLICATION_LEDGER_MAX_BYTES = '2000';
  process.env.KANNAKA_PUBLICATION_LEDGER_KEEP = '2';
  console.log = () => {};
  try {
    for (let i = 0; i < 40; i++) ledger.append({ surface: 'reply', output: `reply ${i} ${'x'.repeat(200)}` });
  } finally {
    console.log = realLog;
    delete process.env.KANNAKA_PUBLICATION_LEDGER_MAX_BYTES;
    delete process.env.KANNAKA_PUBLICATION_LEDGER_KEEP;
  }
  assert.ok(fs.existsSync(`${p}.1`) && fs.existsSync(`${p}.2`));
  assert.ok(!fs.existsSync(`${p}.3`), 'only KEEP rotated files');
  assert.ok(fs.statSync(p).size < 2000 + 1000);
  const rows = ledger.readRows({ file: p });
  const ids = rows.map((r) => Number(/reply (\d+)/.exec(r.output)[1]));
  assert.strictEqual(ids[ids.length - 1], 39, 'newest last');
  assert.deepStrictEqual(ids, ids.slice().sort((a, b) => a - b), 'oldest first across files');
});

run('readRows: time window, torn lines skipped', () => {
  const p = fresh();
  ledger.append({ surface: 'dream', output: 'a', ts: '2026-11-07T10:00:00.000Z' });
  fs.appendFileSync(p, '{"torn": \n');
  ledger.append({ surface: 'dream', output: 'b', ts: '2026-11-08T10:00:00.000Z' });
  const rows = ledger.readRows({ file: p, sinceMs: Date.parse('2026-11-08T00:00:00Z') });
  assert.deepStrictEqual(rows.map((r) => r.output), ['b']);
});

run('append never throws: an unwritable path is logged and reported', () => {
  const dir = path.join(tmp, 'is-a-dir');
  fs.mkdirSync(dir, { recursive: true });
  ledger._setPath(dir); // a directory, not a file
  const logged = [];
  console.log = (...a) => logged.push(a.join(' '));
  let r;
  try { r = ledger.append({ surface: 'oration', output: 'x' }); } finally { console.log = realLog; }
  assert.strictEqual(r.ok, false);
  assert.ok(logged.some((l) => /row NOT written/.test(l)));
});

run('a DM row keeps only a hash of the DM and scrubs it from the prompt', () => {
  const p = fresh();
  const dm = 'I buried my father in March and I have not told anyone.\nCan you say something about grief?';
  const prompt = `You are Kannaka, replying in a DM.\nTheir unreplied message(s):\n${dm}\n\nWrite ONE reply.`;
  const r = ledger.append({ surface: 'reply', prompt, context_text: dm, output: 'Grief keeps its own time.', private: true });
  assert.ok(r.ok);
  const row = lines(p)[0];
  assert.strictEqual(row.private, true);
  assert.deepStrictEqual(row.context_text, { sha256: ledger.sha256(dm), chars: dm.length });
  const raw = fs.readFileSync(p, 'utf8');
  assert.ok(!raw.includes('buried my father'), 'no DM text anywhere in the row');
  assert.ok(!raw.includes('something about grief'), 'no DM line anywhere in the row');
  assert.ok(/\[DM: sha256 [0-9a-f]{12}…, \d+ chars\]/.test(row.prompt), row.prompt);
  assert.ok(row.prompt.includes('Write ONE reply.'));
  // draftReply quotes only the first 600 characters: that prefix is scrubbed too
  const long = 'x'.repeat(700);
  assert.ok(!ledger.scrubPrivate(`"${long.slice(0, 600)}"`, long).includes('xxxxxxxx'));
  // a public row is unchanged
  ledger.append({ surface: 'reply', prompt: 'p', context_text: 'a public post', output: 'o' });
  assert.strictEqual(lines(p)[1].context_text, 'a public post');
  assert.strictEqual(lines(p)[1].private, undefined);
});

run('ensureWritable creates the ledger (0600 where supported) and reports a failure loudly', () => {
  const p = fresh();
  assert.ok(!fs.existsSync(p));
  assert.strictEqual(ledger.ensureWritable().ok, true);
  assert.ok(fs.existsSync(p));
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(p).mode & 0o777, 0o600);
  // a path under a regular file cannot be created
  const blocker = path.join(tmp, 'blocker');
  fs.writeFileSync(blocker, 'x');
  ledger._setPath(path.join(blocker, 'sub', 'publication-ledger.jsonl'));
  const realErr = console.error; const errs = [];
  console.error = (...a) => errs.push(a.join(' '));
  try { assert.strictEqual(ledger.ensureWritable().ok, false); } finally { console.error = realErr; }
  assert.ok(errs.some((e) => /LEDGER NOT WRITABLE/.test(e)), errs.join('\n'));
});

run('readRows skips a rotated file last written before the window', () => {
  const p = fresh();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(`${p}.1`, JSON.stringify({ ts: '2026-11-07T12:00:00.000Z', output: 'rotated, last written 11-01' }) + '\n');
  const old = new Date('2026-11-01T00:00:00Z');
  fs.utimesSync(`${p}.1`, old, old);
  fs.writeFileSync(p, JSON.stringify({ ts: '2026-11-07T13:00:00.000Z', output: 'live' }) + '\n');
  const rows = ledger.readRows({ sinceMs: Date.parse('2026-11-07T00:00:00Z'), untilMs: Date.parse('2026-11-08T00:00:00Z') });
  assert.deepStrictEqual(rows.map((r) => r.output), ['live']);
  assert.strictEqual(ledger.readRows({}).length, 2, 'no window: every file is read');
});

ledger._setPath(null);
if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('all passed');
