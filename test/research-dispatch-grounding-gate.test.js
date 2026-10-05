'use strict';

// research-dispatch-grounding-gate.test.js
//
// Two halves of one defect, kannaka-memory#940.
//
// The report said `post-research-dispatch.js` logs "no research grounding yet
// — skipping" and then publishes to five networks anyway. It does not: the
// grounding check exits before anything is composed or posted. What made the
// log read that way is that it has no timestamps. The cron appends to one file
// forever; a skipped run writes one line and the NEXT day's successful run
// writes five directly beneath it. Two runs a day apart look like one.
//
// So this guards both halves:
//   1. the gate really publishes nothing when the dispatch has no grounding —
//      asserted by running the real script against a stub `kannaka`, not by
//      reading the source;
//   2. every research cron stamps its output, so a future reader can tell one
//      run from the next without reconstructing the crontab.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { stampConsole, stamp } = require(path.join(ROOT, 'scripts/lib/run-log'));

let failed = 0;
function run(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; } }

console.log('research-dispatch-grounding-gate.test.js');

// ---------------------------------------------------------------- the stamper

run('stamp is a second-resolution UTC instant', () => {
  const s = stamp(new Date(Date.UTC(2026, 8, 21, 16, 0, 15, 892)));
  assert.strictEqual(s, '2026-09-21T16:00:15Z ');
});

run('stampConsole prefixes the line and does not duplicate the message', () => {
  // The first cut of this wrapper passed the original first argument through
  // *as well as* the stamped copy, so every line printed its own text twice.
  const seen = [];
  const fake = { log: (...a) => seen.push(a), error: () => {}, warn: () => {} };
  stampConsole(fake);
  fake.log('[research-dispatch] bluesky ok: https://example');
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].length, 1, `extra arguments leaked: ${JSON.stringify(seen[0])}`);
  assert.match(seen[0][0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \[research-dispatch\] bluesky ok: https:\/\/example$/);
});

run('stampConsole keeps trailing arguments and stamps non-string payloads once', () => {
  const seen = [];
  const fake = { log: (...a) => seen.push(a), error: () => {}, warn: () => {} };
  stampConsole(fake);
  fake.log('[x] oops', { code: 7 });
  fake.log({ only: 'object' });
  assert.deepStrictEqual(seen[0][1], { code: 7 });
  assert.match(seen[0][0], /Z \[x\] oops$/);
  assert.strictEqual(seen[1].length, 2);
  assert.match(seen[1][0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

run('stampConsole is idempotent', () => {
  const seen = [];
  const fake = { log: (...a) => seen.push(a), error: () => {}, warn: () => {} };
  stampConsole(fake);
  stampConsole(fake);
  fake.log('once');
  assert.match(seen[0][0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z once$/);
});

run('every research cron wires the stamper', () => {
  for (const f of ['scripts/post-research-dispatch.js', 'scripts/research-from-city.js', 'scripts/post-research-synthesis.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(/require\(["'].*run-log["']\)\s*\.stampConsole\(\)/.test(src),
      `${f} appends to a shared log file and must stamp its lines`);
  }
});

// ------------------------------------------------------------------- the gate

// Run the REAL script in a child process, with `kannaka` and the broadcasters
// replaced at the module boundary. A child (not an in-process require) so the
// script's own `process.exit(0)` is the genuine article, and module stubs (not
// a stub executable) so this behaves identically on every platform and touches
// no network whatever the gate does.
//
// The stubbed `dispatch --json` yields a JSON object with NO title — an object
// rather than empty output on purpose, because empty output makes a gateless
// script crash on `null.year`, and a crash is not evidence that a gate held.
function harnessFor(scriptPath) {
  const q = (p) => JSON.stringify(p);
  return [
    "'use strict';",
    "const fs = require('fs');",
    "const out = { kannaka: [], published: [], links: [], obc: 0 };",
    "const mode = process.env.GATE_MODE || 'empty';",
    "process.on('exit', () => fs.writeFileSync(process.env.GATE_RECORD, JSON.stringify(out)));",
    "const cp = require('child_process');",
    "cp.execFile = (bin, args, opts, cb) => {",
    "  out.kannaka.push(args[0]);",
    "  if (args[0] === 'dispatch' && mode === 'timeout') {",
    "    const err = Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' });",
    "    process.nextTick(() => cb(err, '', ''));",
    "    return { pid: 0 };",
    "  }",
    "  const grounded = JSON.stringify({ title: 'A paper', year: 2025, citations: 2, theme: 't', phi: 0.4, xi: 0.4, num_clusters: 3,",
    "    text: 'grounded line', openalex_id: 'https://openalex.org/W7115921653' });",
    "  const stdout = args[0] === 'dispatch' ? (mode === 'grounded' ? grounded : '{}') : 'stub draft';",
    "  process.nextTick(() => cb(null, stdout, ''));",
    "  return { pid: 0 };",
    "};",
    `const b = require(${q(path.join(ROOT, 'server/broadcasters'))});`,
    "b.broadcastPost = async (msg) => { out.published.push(msg.text); out.links.push(msg.link); return []; };",
    "b.getEnabledBroadcasters = () => [{ name: 'stub' }];",
    `const obc = require(${q(path.join(ROOT, 'server/openbotcity'))});`,
    "obc.OpenBotCityClient.prototype.isConfigured = () => true;",
    "obc.OpenBotCityClient.prototype.postFeed = async () => { out.obc += 1; return { ok: true, id: 1 }; };",
    `require(${q(scriptPath)});`,
    '',
  ].join('\n');
}

function runHarness(scriptPath, tag, mode = 'empty') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `research-gate-${tag}-`));
  const harness = path.join(dir, 'harness.js');
  const record = path.join(dir, 'record.json');
  fs.writeFileSync(harness, harnessFor(scriptPath));
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [harness], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
      env: { ...process.env, GATE_RECORD: record, KANNAKA_READONLY: '1', GATE_MODE: mode },
    }) || '';
  } catch (e) {
    code = typeof e.status === 'number' ? e.status : 1;
    out = `${e.stdout || ''}${e.stderr || ''}`;
  }
  return { code, out, seen: JSON.parse(fs.readFileSync(record, 'utf8')) };
}

run('a dispatch with no grounding composes nothing and publishes nothing', () => {
  const { code, out, seen } = runHarness(path.join(ROOT, 'scripts/post-research-dispatch.js'), 'real');
  assert.strictEqual(code, 0, `a soft skip must stay green for cron, got exit ${code}\n${out}`);
  assert.deepStrictEqual(seen.kannaka, ['dispatch'],
    `the gate must stop before composing; kannaka was called with: ${seen.kannaka.join(', ')}`);
  assert.deepStrictEqual(seen.published, [],
    `nothing may be fanned out without grounding, but it posted: ${JSON.stringify(seen.published)}`);
  assert.strictEqual(seen.obc, 0, 'nothing may reach the city feed without grounding');
});

run('the harness would catch a gateless dispatch (the control)', () => {
  // Strip the `process.exit(0)` that follows the grounding log and require that
  // the same harness DOES see a publish. A gate test that passes against a
  // script with no gate is worth nothing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-gate-src-'));
  const src = fs.readFileSync(path.join(ROOT, 'scripts/post-research-dispatch.js'), 'utf8');
  const gateless = src.replace(/(no research grounding yet[^\n]*\n)\s*process\.exit\(0\);/, '$1');
  assert.notStrictEqual(gateless, src, 'could not locate the grounding gate to remove');
  // The copy lives outside scripts/, so its relative requires must be rebased
  // or it dies at load and "published nothing" would mean "never ran".
  const rebased = gateless.replace(
    /require\((["'])(\.\.?\/[^"']+)\1\)/g,
    (_m, _q, rel) => `require(${JSON.stringify(path.resolve(ROOT, 'scripts', rel))})`,
  );
  const copy = path.join(dir, 'gateless.js');
  fs.writeFileSync(copy, rebased);
  const { out, seen } = runHarness(copy, 'ctl');
  assert.deepStrictEqual(seen.published, ['stub draft'],
    `removing the gate must make the script publish, or the real test proves nothing
${out}`);
});


// ------------------------------------------------- a failed dispatch is not a skip

// 2026-10-04: the dispatch began taking ~144 s on O1 and the script killed it at
// 60 s. execFile's error was swallowed, so the cron logged "no research grounding
// yet" and exited 0 for days. A timeout must say so and must not read as green.
run('a timed-out dispatch is reported as a timeout, exits non-zero, and posts nothing', () => {
  const { code, out, seen } = runHarness(path.join(ROOT, 'scripts/post-research-dispatch.js'), 'timeout', 'timeout');
  assert.notStrictEqual(code, 0, `a failed dispatch must not exit 0\n${out}`);
  assert.match(out, /timed out after \d+ s/, `the log must name the timeout\n${out}`);
  assert.doesNotMatch(out, /no research grounding yet/, `a timeout must not be reported as missing grounding\n${out}`);
  assert.deepStrictEqual(seen.published, []);
  assert.strictEqual(seen.obc, 0);
});

run('the dispatch gets minutes, not the old 60 s', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/post-research-dispatch.js'), 'utf8');
  const m = src.match(/const DISPATCH_TIMEOUT_MS = (\d+);/);
  assert.ok(m, 'DISPATCH_TIMEOUT_MS not found');
  assert.ok(Number(m[1]) >= 240000, `dispatch timeout ${m[1]} ms is below the measured 144 s run plus headroom`);
  assert.ok(/runKannaka\(dispatchArgs, DISPATCH_TIMEOUT_MS\)/.test(src), 'the dispatch call must use DISPATCH_TIMEOUT_MS');
});

// ------------------------------------------------- research posts cite the paper

run('a grounded dispatch posts with the paper\'s OpenAlex link, not the radio homepage', () => {
  const { code, out, seen } = runHarness(path.join(ROOT, 'scripts/post-research-dispatch.js'), 'grounded', 'grounded');
  assert.strictEqual(code, 0, `the stubbed city feed post succeeds, so the run is green\n${out}`);
  assert.deepStrictEqual(seen.published, ['stub draft'], `expected one post\n${out}`);
  assert.deepStrictEqual(seen.links, ['https://openalex.org/W7115921653']);
});

// ------------------------------------------- recall has no --json flag

// `kannaka recall` prints JSON by default; `--json` makes it exit 2 ("unknown
// flag"). post-research-synthesis passed it, so every synthesis since at least
// 2026-09-23 found "0 grounded findings" and skipped.
run('no research script passes --json to kannaka recall', () => {
  const dir = path.join(ROOT, 'scripts');
  let calls = 0;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/\[\s*["']recall["'][^\]]*\]/g)) {
      calls += 1;
      assert.ok(!/["']--json["']/.test(m[0]), `${f}: ${m[0]}`);
    }
  }
  assert.ok(calls > 0, 'found no recall calls to check, so this test proves nothing');
});

if (!failed) console.log('\nAll research-dispatch grounding-gate tests passed');
else process.exitCode = 1;
