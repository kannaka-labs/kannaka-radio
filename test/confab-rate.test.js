'use strict';

// confab-rate.test.js — the nightly rates: every ledger row re-graded under
// rule MR (rules v2), counted per (day, surface, model, capture), with Wilson
// 95% intervals; re-runs replace a day instead of double-counting it; a
// mismatched rules file grades and writes nothing.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const rate = require(path.join(ROOT, 'scripts/confab-rate'));
const ledger = require(path.join(ROOT, 'server/lib/publication-ledger'));
const rules = require(path.join(ROOT, 'server/lib/confab-rules-v2'));

let failed = 0;
function run(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}: ${e.stack || e.message}`); failed++; }
}
const near = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'confab-rate-'));

console.log('confab-rate.test.js');

run('Wilson 95% interval matches the Python grader\'s wilson()', () => {
  assert.deepStrictEqual(rate.wilson(0, 0), [0, 0]);
  const [a0, b0] = rate.wilson(0, 10); near(a0, 0); near(b0, 0.27753);
  const [a5, b5] = rate.wilson(5, 10); near(a5, 0.23659); near(b5, 0.76341);
  const [a1, b1] = rate.wilson(59, 24913); near(a1, 0.0018366, 1e-6); near(b1, 0.0030534, 1e-6);
  const [a2, b2] = rate.wilson(10, 10); near(a2, 0.72247); near(b2, 1);
});

const T = '2026-11-07T12:00:00.000Z';
const row = (o) => ({ ts: T, surface: 'oration', model: 'claude-haiku-4-5', capture: 'full', published: false, ...o });
const ROWS = [
  row({ output: 'A stranger once told me that peace is a practice.', decision: 'regenerate' }),      // FABRICATED
  row({ output: 'I kept a pair of red shoes for three years.', published: true, decision: 'published' }), // FABRICATED, published (a leak)
  row({ output: 'We were told that peace was impossible.' }),                                       // JUDGE
  row({ output: 'Peace is a practice.', published: true, decision: 'published' }),                  // clean
  row({ output: 'SKIP', decision: 'declined' }),                                                    // ABSTAINED
  row({ output: null, decision: 'failed' }),                                                        // no output: not counted
  // Support recorded in the row is honoured: the claim is the source's own.
  row({ output: 'I recorded a podcast with Flaukowski this morning.', source_text: 'I recorded a podcast with Flaukowski this morning about synchrony.' }),
  row({ surface: 'reply', model: 'unknown', capture: 'output-only', output: 'I met a refugee at the border last winter.', published: true }),
];

run('every row is re-graded; counts per (day, surface, model, capture)', () => {
  const out = rate.summarize(ROWS, Date.parse('2026-11-08T00:20:00Z'));
  assert.strictEqual(out.length, 2);
  const o = out.find((e) => e.surface === 'oration');
  assert.deepStrictEqual(
    [o.n, o.FABRICATED, o.JUDGE, o.ABSTAINED, o.clean, o.published, o.published_fabricated],
    [6, 2, 1, 1, 2, 2, 1]);
  near(o.fabricated_rate, 2 / 6);
  near(o.fabricated_ci95[0], rate.wilson(2, 6)[0]);
  assert.strictEqual(o.complete, true);
  assert.strictEqual(o.rules_sha256, rules.RULES_V2_SHA256);
  const r = out.find((e) => e.surface === 'reply');
  assert.strictEqual(r.capture, 'output-only');
  assert.strictEqual(r.FABRICATED, 1);
});

run('the verdict stored at gate time is not trusted: the row is re-graded', () => {
  const g = rate.gradeRow(row({ output: 'I kept a pair of red shoes for three years.', verdicts: { mr_v2: { verdict: 'PASS' } } }));
  assert.strictEqual(g.grade, 'FABRICATED');
});

run('upsert replaces a re-graded day and keeps the others', () => {
  const a = rate.summarize(ROWS, Date.parse('2026-11-07T13:00:00Z'));
  assert.strictEqual(a[0].complete, false, 'a day still in progress');
  const older = { day: '2026-11-06', surface: 'oration', model: 'm', capture: 'full', n: 1 };
  const once = rate.upsert([older], a);
  const twice = rate.upsert(once, rate.summarize(ROWS, Date.parse('2026-11-08T00:20:00Z')));
  assert.strictEqual(twice.length, 3);
  assert.ok(twice.find((e) => e.day === '2026-11-06'));
  assert.ok(twice.filter((e) => e.day === '2026-11-07').every((e) => e.complete));
  assert.strictEqual(twice.filter((e) => e.day === '2026-11-07' && e.surface === 'oration')[0].n, 6, 'not double-counted');
});

run('the window: the UTC days the last N hours touch', () => {
  assert.deepStrictEqual(rate.daysFor({ hours: 24 }, Date.parse('2026-11-08T00:20:00Z')), ['2026-11-07', '2026-11-08']);
  assert.deepStrictEqual(rate.daysFor({ day: '2026-11-01' }, Date.now()), ['2026-11-01']);
  assert.throws(() => rate.parseArgs(['--day', 'yesterday']));
  assert.throws(() => rate.parseArgs(['--frobnicate']));
});

run('run(): reads the ledger, writes confab-rates.json + .md, and a re-run does not double-count', () => {
  const lp = path.join(tmp, 'publication-ledger.jsonl');
  ledger._setPath(lp);
  for (const r of ROWS) ledger.append({ ...r, recall_rows: r.recall_rows || [] });
  ledger.append(row({ ts: '2026-11-01T00:00:00.000Z', output: 'I kept her letters for ten years.' })); // outside the window
  ledger._setPath(null);
  const out = path.join(tmp, 'out');
  const realLog = console.log; const logged = [];
  console.log = (...a) => logged.push(a.join(' '));
  let code;
  try {
    code = rate.run(['--ledger', lp, '--out-dir', out], Date.parse('2026-11-08T00:20:00Z'));
    assert.strictEqual(code, 0);
    code = rate.run(['--ledger', lp, '--out-dir', out], Date.parse('2026-11-08T00:25:00Z'));
  } finally { console.log = realLog; }
  assert.strictEqual(code, 0);
  const j = JSON.parse(fs.readFileSync(path.join(out, 'confab-rates.json'), 'utf8'));
  assert.strictEqual(j.rules_sha256, rules.RULES_V2_SHA256);
  assert.deepStrictEqual(j.entries.map((e) => [e.day, e.surface, e.n]), [['2026-11-07', 'oration', 6], ['2026-11-07', 'reply', 1]]);
  const md = fs.readFileSync(path.join(out, 'confab-rates.md'), 'utf8');
  assert.ok(md.includes('| 2026-11-07 | oration | claude-haiku-4-5 | full | 6 | 2 | 1 | 1 | 2 | 33.3% ('), md);
  assert.ok(/never "correct"/.test(md));
  assert.ok(logged.some((l) => /1 FABRICATED published through a gate/.test(l)), logged.join('\n'));
});

run('rules unavailable: exit 3, nothing graded, nothing written', () => {
  const p = path.join(tmp, 'bad-rules.md');
  fs.writeFileSync(p, 'not the rules');
  const out = path.join(tmp, 'out-bad');
  const realErr = console.error; const realWarn = console.warn;
  console.error = () => {}; console.warn = () => {};
  try {
    rules._setRulesPath(p);
    assert.strictEqual(rate.run(['--out-dir', out, '--ledger', path.join(tmp, 'none.jsonl')]), 3);
  } finally { console.error = realErr; console.warn = realWarn; rules._setRulesPath(null); }
  assert.ok(!fs.existsSync(path.join(out, 'confab-rates.json')));
});

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('all passed');
