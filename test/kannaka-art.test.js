'use strict';

// kannaka-art.test.js — runs the Python unit tests for scripts/kannaka-art/kannaka_art.py.
//
// every-test-runs.test.js only sees test/*.test.js, so a Python suite elsewhere would never
// run in CI. This wrapper is the registered entry point. It FAILS (never skips) when no
// Python 3 is found, and it refuses a run that executed fewer tests than the suite holds,
// so "Ran 0 tests" or a half-discovered suite cannot read as green.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TESTS = path.join(ROOT, 'scripts', 'kannaka-art', 'tests');

let failed = 0;
function run(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; } }

console.log('kannaka-art.test.js');

function findPython() {
  const candidates = [process.env.PYTHON, 'python3', 'python'].filter(Boolean);
  for (const exe of candidates) {
    const r = spawnSync(exe, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === '3') return exe;
  }
  return null;
}

// Count the test methods on disk, so the run must account for every one of them.
const declared = fs.readdirSync(TESTS)
  .filter((f) => /^test_.*\.py$/.test(f))
  .reduce((n, f) => n + (fs.readFileSync(path.join(TESTS, f), 'utf8').match(/^ {4}def test_\w+\(/gm) || []).length, 0);

const python = findPython();

run('a Python 3 interpreter is available', () => {
  assert.ok(python, 'no python3/python on PATH (set PYTHON=...) — the kannaka-art suite cannot run');
});

if (python) {
  const r = spawnSync(python, ['-m', 'unittest', 'discover', '-s', TESTS, '-v'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const ran = Number((out.match(/^Ran (\d+) tests? in/m) || [])[1] || 0);

  run(`python unittest exits 0 (${python})`, () => {
    assert.strictEqual(r.status, 0, `exit ${r.status}\n${out.split('\n').slice(-40).join('\n')}`);
  });

  run(`every declared test ran (${ran} of ${declared})`, () => {
    assert.ok(declared > 0, 'found no test_ methods on disk');
    assert.strictEqual(ran, declared, `unittest ran ${ran}, the files declare ${declared}`);
  });
}

if (!failed) console.log(`\nAll kannaka-art tests passed (${declared} python tests)`);
else process.exitCode = 1;
