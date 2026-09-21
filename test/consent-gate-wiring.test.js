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

// WHAT COUNTS AS A PUBLISHER. Not a glob over one directory — the first draft
// of this test scanned `workspace/podcasts/upload-*.js` only, and three
// scripts that put video on YouTube live in `scripts/` and sailed straight
// through a net advertised as general. A narrower net than the claim above it
// is the same defect as a gate with no caller, one level up, so the detector
// is the capability itself: anything that drives the YouTube adapter with
// media attached can publish, wherever it sits.
const PUBLISHER_DIRS = ['scripts', path.join('workspace', 'podcasts')];

function isPublisher(src) {
  return /YouTubeAdapter/.test(src) && /adapter\.post\(/.test(src) && /media/.test(src);
}

function publishers() {
  const out = [];
  for (const dir of PUBLISHER_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (!f.endsWith('.js')) continue;
      const rel = path.join(dir, f).split(path.sep).join('/');
      const src = fs.readFileSync(path.join(abs, f), 'utf8');
      if (isPublisher(src)) out.push({ rel, src });
    }
  }
  return out;
}

// Publishers that do NOT call the guard, each with the reason it is allowed
// not to. CLOSED MAP — adding an entry is the defect this test exists to
// catch. A reason is required because an exemption nobody has to justify is
// how the list grows.
const UNGUARDED = {
  'scripts/podcast-upload-batch.js':
    'Backfill of episodes 1-12 from metadata.json, all published long before the gate. ' +
    'RESIDUAL RISK, stated rather than hidden: if anyone ever adds a NEW episode to ' +
    'metadata.json and runs this, it uploads without a consent check. Guarding it means ' +
    'a consent.json for each of the twelve, which is work nobody has a reason to do until ' +
    'the tool is used again.',
  'scripts/release-album-upload-youtube.js':
    'Publishes an album render, not an episode. It quotes no one and asks no permission, ' +
    'so there is no thread for a gate to read.',
  'scripts/youtube-upload-test.js':
    'A harness that uploads its own generated fixture to prove the adapter works. No guest, ' +
    'no quotation, and it should stay runnable with no episode directory in existence.',
};

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

/** Every exemption this file grants, from either list. */
function exempt(rel) {
  return Object.hasOwn(UNGUARDED, rel) || (rel.startsWith('workspace/podcasts/') && PRE_GATE.has(path.basename(rel)));
}

run('every publisher written after the gate calls the guard', () => {
  const missing = publishers()
    .filter((p) => !exempt(p.rel))
    .filter((p) => !/consent-guard/.test(p.src))
    .map((p) => p.rel);
  assert.deepStrictEqual(
    missing, [],
    'these publish video without consulting the consent gate:\n    ' + missing.join('\n    ') +
      '\n  Add, inside the async main and BEFORE adapter.post:\n' +
      '      const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));\n' +
      '      assertConsentClear(path.join(ROOT, "workspace/podcasts/<NNN>"));',
  );
});

run('the detector actually recognises the publishers we know about', () => {
  // A net that catches nothing passes the test above for the wrong reason.
  const found = new Set(publishers().map((p) => p.rel));
  for (const known of [
    'workspace/podcasts/upload-41.js',
    'scripts/podcast-upload-batch.js',
    'scripts/release-album-upload-youtube.js',
  ]) {
    assert.ok(found.has(known), `the publisher detector missed ${known}`);
  }
  assert.ok(found.size >= 40, `only ${found.size} publishers detected; the net has narrowed`);
});

run('both exemption lists name only files that exist', () => {
  const ghosts = [
    ...[...PRE_GATE].filter((f) => !fs.existsSync(path.join(PODCASTS, f))).map((f) => `workspace/podcasts/${f}`),
    ...Object.keys(UNGUARDED).filter((f) => !fs.existsSync(path.join(ROOT, f))),
  ];
  assert.deepStrictEqual(ghosts, [], 'exempted but not on disk: ' + ghosts.join(', '));
});

run('every unguarded publisher carries a stated reason', () => {
  const unreasoned = Object.entries(UNGUARDED).filter(([, why]) => !why || why.trim().length < 40);
  assert.deepStrictEqual(unreasoned.map(([f]) => f), [], 'exempted with no real reason given');
});

run('neither exemption list has grown', () => {
  // The counts on 2026-09-21, the day the guard was wired. If either goes up,
  // someone added a publisher to an exemption list instead of calling the
  // guard — which is the wish with better formatting that this whole file
  // exists to prevent.
  assert.strictEqual(PRE_GATE.size, 37, 'the pre-gate list grew');
  assert.strictEqual(Object.keys(UNGUARDED).length, 3, 'the unguarded-publisher list grew');
});

if (failed > 0) { console.error(`\n${failed} failing`); process.exit(1); }
console.log('  all passing');
