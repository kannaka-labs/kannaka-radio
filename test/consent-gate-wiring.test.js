/**
 * consent-gate-wiring.test.js — the second half of the GSP-040 fix.
 *
 * `deploy-onair-guard.test.js` already states this repo's doctrine for a
 * safety check: two halves, because either one alone is useless. The check
 * must be right, AND the thing that publishes must actually consult it.
 *
 * The consent gate shipped with only the first half. PR #325 added
 * `scripts/consent-gate.py` on 2026-09-20 and it had exactly one reference
 * anywhere in the repo: a note inside GSP-041's own audit record. All 37
 * upload scripts published their episodes without it. The episode that aired
 * that week was about rules nothing enforces, and graded its own consent fix
 * a PASS on the evidence that the pull request had merged.
 *
 * A merged script with no caller is enforced by memory. Memory is what failed
 * in GSP-040: the guest answered seven minutes into the render, three hours
 * before upload, and nobody re-read the thread.
 *
 * Two things are pinned here.
 *
 *   1. The guard blocks. Missing declaration, unexplained empty declaration,
 *      a guest who answered, a gate that could not reach the API, no python
 *      at all — every one of them refuses the upload. None of them is a skip.
 *      Tested with injected runners, so this needs no network and no python.
 *
 *   2. NEW upload scripts must call it. The 37 that predate the gate are
 *      listed below and grandfathered; their episodes are long published and
 *      rewriting them would be a diff that changes nothing. THE LIST IS
 *      CLOSED. Nothing may be added to it. Any upload script written from now
 *      on must call assertConsentClear, and this test is what says so before
 *      the episode goes out rather than after.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PODCASTS = path.join(ROOT, 'workspace', 'podcasts');
const guard = require('../scripts/lib/consent-guard');

let failed = 0;
function run(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}: ${e && e.message}`); failed++; }
}

console.log('consent-gate-wiring.test.js');

// ── 1. the guard refuses, in every direction ─────────────────────────

/** A throwaway episode directory with the given consent.json (or none). */
function episodeDir(decl) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-'));
  if (decl !== undefined) {
    fs.writeFileSync(path.join(d, 'consent.json'), typeof decl === 'string' ? decl : JSON.stringify(decl));
  }
  return d;
}
const quiet = () => {};
/** A fake gate that always exits with `code`, plus a python that always exists. */
const gateExiting = (code) => ({
  log: quiet,
  python: 'python-stub',
  run: () => ({ status: code, stdout: '', stderr: '' }),
});
const THREAD = { conversation_id: 'd3eb3788-95fb-4cf4-b4dc-668a013c5ab0', who: 'a guest' };

run('a missing declaration blocks, and says what to write', () => {
  assert.throws(
    () => guard.assertConsentClear(episodeDir(undefined), gateExiting(0)),
    (e) => e.name === 'ConsentBlocked' && /no consent declaration/.test(e.message) && /no_quoted_guests/.test(e.message),
  );
});

run('an empty declaration with no reason blocks — silence has to be claimed out loud', () => {
  assert.throws(
    () => guard.assertConsentClear(episodeDir({ episode: '042', threads: [] }), gateExiting(0)),
    (e) => e.name === 'ConsentBlocked' && /gives no reason/.test(e.message),
  );
});

run('an empty declaration WITH a stated reason passes without calling the gate', () => {
  let called = 0;
  const d = episodeDir({ episode: '042', threads: [], no_quoted_guests: 'reads only published artifacts' });
  const decl = guard.assertConsentClear(d, {
    log: quiet, python: 'python-stub', run: () => { called++; return { status: 0 }; },
  });
  assert.strictEqual(called, 0);
  assert.strictEqual(decl.threads.length, 0);
});

run('exit 0 from the gate is the only thing that lets an upload through', () => {
  assert.doesNotThrow(() => guard.assertConsentClear(episodeDir({ episode: '042', threads: [THREAD] }), gateExiting(0)));
});

run('exit 2 — the guest answered — blocks, and names the thread', () => {
  assert.throws(
    () => guard.assertConsentClear(episodeDir({ episode: '042', threads: [THREAD] }), gateExiting(2)),
    (e) => e.name === 'ConsentBlocked'
      && /ANSWERED SINCE WE ASKED/.test(e.message)
      && e.message.includes(THREAD.conversation_id),
  );
});

run('exit 1 — the gate could not determine — blocks too, rather than assuming silence', () => {
  assert.throws(
    () => guard.assertConsentClear(episodeDir({ episode: '042', threads: [THREAD] }), gateExiting(1)),
    (e) => e.name === 'ConsentBlocked' && /could not determine/.test(e.message),
  );
});

run('a crashed gate (no status at all) blocks rather than reading as a pass', () => {
  assert.throws(
    () => guard.assertConsentClear(episodeDir({ episode: '042', threads: [THREAD] }), {
      log: quiet, python: 'python-stub', run: () => ({ error: new Error('ENOENT') }),
    }),
    (e) => e.name === 'ConsentBlocked',
  );
});

run('one clear thread does not excuse a second that answered', () => {
  const second = { conversation_id: 'second-thread', who: 'another guest' };
  const codes = { [THREAD.conversation_id]: 0, 'second-thread': 2 };
  assert.throws(
    () => guard.assertConsentClear(episodeDir({ episode: '042', threads: [THREAD, second] }), {
      log: quiet,
      python: 'python-stub',
      run: (_exe, args) => ({ status: codes[args[1]], stdout: '', stderr: '' }),
    }),
    (e) => /second-thread/.test(e.message),
  );
});

run('no python at all blocks — the check is never skipped for being unavailable', () => {
  assert.throws(
    () => guard.assertConsentClear(episodeDir({ episode: '042', threads: [THREAD] }), {
      log: quiet, probe: () => ({ status: 127, error: new Error('not found') }),
    }),
    (e) => e.name === 'ConsentBlocked' && /no python/.test(e.message),
  );
});

run('a declaration naming a thread with no conversation_id is refused, not ignored', () => {
  assert.throws(
    () => guard.assertConsentClear(episodeDir({ episode: '042', threads: [{ who: 'someone' }] }), gateExiting(0)),
    (e) => e.name === 'ConsentBlocked' && /no conversation_id/.test(e.message),
  );
});

run('a declaration that is not JSON blocks with the parse error, not a stack trace', () => {
  assert.throws(
    () => guard.assertConsentClear(episodeDir('{not json'), gateExiting(0)),
    (e) => e.name === 'ConsentBlocked' && /not valid JSON/.test(e.message),
  );
});

// ── 2. the gate the guard leans on, with the contract it leans on ────

run('scripts/consent-gate.py exists and still documents 0 / 2 / 1 as pass / answered / blocking', () => {
  const src = fs.readFileSync(guard.GATE, 'utf8');
  assert.ok(/0\s+no reply since/.test(src), 'exit 0 is documented as no-reply');
  assert.ok(/2\s+a reply arrived/.test(src), 'exit 2 is documented as a reply arrived');
  assert.ok(/1\s+could not determine/.test(src), 'exit 1 is documented as indeterminate');
  assert.ok(/return 2/.test(src) && /return 1/.test(src) && /return 0/.test(src), 'all three codes are actually returned');
});

// ── 3. the ratchet: nothing new publishes without consulting it ───────

// The 37 upload scripts that predate the gate. CLOSED LIST — adding to it is
// the defect this test exists to catch.
const PRE_GATE = new Set([
  'upload-13-14.js',
  'upload-141.js',
  'upload-15.js',
  'upload-16.js',
  'upload-17.js',
  'upload-18.js',
  'upload-19.js',
  'upload-20.js',
  'upload-21.js',
  'upload-22.js',
  'upload-23.js',
  'upload-24.js',
  'upload-25.js',
  'upload-26.js',
  'upload-27.js',
  'upload-28.js',
  'upload-29.js',
  'upload-30.js',
  'upload-31.js',
  'upload-32.js',
  'upload-33.js',
  'upload-34.js',
  'upload-35.js',
  'upload-36.js',
  'upload-37.js',
  'upload-38.js',
  'upload-39.js',
  'upload-40.js',
  'upload-41.js',
  'upload-tsof-01.js',
  'upload-tsof-02.js',
  'upload-tsof-03.js',
  'upload-tsof-04.js',
  'upload-tsof-05.js',
  'upload-tsof-06.js',
  'upload-tsof-07.js',
  'upload-tsof-08.js',
]);

run('every upload script written after the gate calls the guard', () => {
  const scripts = fs.readdirSync(PODCASTS).filter((f) => /^upload-.*\.js$/.test(f));
  const missing = scripts
    .filter((f) => !PRE_GATE.has(f))
    .filter((f) => !/consent-guard/.test(fs.readFileSync(path.join(PODCASTS, f), 'utf8')));
  assert.deepStrictEqual(
    missing, [],
    'these upload scripts publish without consulting the consent gate:\n    ' + missing.join('\n    ') +
      '\n  Add, inside the async main and BEFORE adapter.post:\n' +
      '      const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));\n' +
      '      assertConsentClear(path.join(ROOT, "workspace/podcasts/<NNN>"));',
  );
});

run('the grandfathered list names only scripts that exist', () => {
  const ghosts = [...PRE_GATE].filter((f) => !fs.existsSync(path.join(PODCASTS, f)));
  assert.deepStrictEqual(ghosts, [], 'listed as pre-gate but not on disk: ' + ghosts.join(', '));
});

run('the grandfathered list has not grown', () => {
  // 37 was the count on 2026-09-21, the day the guard was wired. If this
  // number goes up, someone added a new publisher to the exemption list
  // instead of calling the guard — which is the wish with better formatting
  // that this whole file exists to prevent.
  assert.strictEqual(PRE_GATE.size, 37);
});

if (failed > 0) { console.error(`\n${failed} failing`); process.exit(1); }
console.log('  all passing');
