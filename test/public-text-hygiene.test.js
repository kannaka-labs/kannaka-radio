'use strict';

// public-text-hygiene.test.js
//
// Two of her own posts on 2026-11-07 carried machine residue:
//
//  (a) 16:04Z research dispatch (Bluesky 3mzqbkthhzr22, Nostr 78840938):
//      'From the field: "Emergence of collective intelligence in online
//      communities" (2015, 42× cited) — (no abstract). — the field holds it
//      across 13 clusters (Ξ 0.32).'
//      The compose declined, the script fell back to `kannaka dispatch`'s
//      grounded line, and that line quotes the stored abstract — which
//      kannaka-memory writes as the literal "(no abstract)" when OpenAlex has none.
//
//  (b) 18:02Z reply loop (Bluesky 3mzqi5p3t2h2w):
//      "… But I'm holding which suggests the load-bearing work …"
//      The model cited "[memory id=…]" as the object of "holding"; cleanDraft
//      deleted the tag and spliced the sentence shut.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const lib = require(path.join(ROOT, 'scripts/lib/kannaka-reply'));
const { cleanDraft, cleanDraftChecked, stripPreamble, cleanGroundedLine, publicTextDefect } = lib;

let failed = 0;
function run(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; } }

console.log('public-text-hygiene.test.js');

const LIVE_GROUNDED = 'From the field: "Emergence of collective intelligence in online communities" (2015, 42× cited) — (no abstract). — the field holds it across 13 clusters (Ξ 0.32).';

// ------------------------------------------------------------ (a) no abstract

run('the live 11-07 grounded line fails the public-text check as published', () => {
  assert.match(publicTextDefect(LIVE_GROUNDED), /no abstract/);
});

run('cleanGroundedLine removes the hole and its connector, leaving a clean sentence', () => {
  const out = cleanGroundedLine(LIVE_GROUNDED);
  assert.strictEqual(out, 'From the field: "Emergence of collective intelligence in online communities" (2015, 42× cited) — the field holds it across 13 clusters (Ξ 0.32).');
  assert.strictEqual(publicTextDefect(out), null, publicTextDefect(out));
});

run('cleanGroundedLine leaves a line with a real lede alone', () => {
  const ok = 'From the field: "Holographic reduced representations" (1995, 672× cited) — Associative memories represent simple structure. — the field holds it across 1 cluster (Ξ 0.18).';
  assert.strictEqual(cleanGroundedLine(ok), ok);
  assert.strictEqual(cleanGroundedLine(null), null);
});

run('a stored research memory without an abstract never feeds "(no abstract)" to the synthesis corpus', () => {
  // parseFinding runs in a child: requiring the script stamps the console.
  const synth = path.join(ROOT, 'scripts/post-research-synthesis.js');
  const got = JSON.parse(execFileSync(process.execPath, ['-e',
    `const { parseFinding } = require(${JSON.stringify(synth)});
     process.stdout.write(JSON.stringify([
       parseFinding("research: T (2015)\\n(no abstract)"),
       parseFinding("research: T (2015)\\nReplay consolidates memory."),
     ]));`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').pop());
  assert.deepStrictEqual(got[0], { title: 'T', year: '2015', abs: '' });
  assert.deepStrictEqual(got[1], { title: 'T', year: '2015', abs: 'Replay consolidates memory.' });
  const src = fs.readFileSync(synth, 'utf8');
  assert.ok(src.includes('${f.abs ? ` — ${f.abs}` : ""}'), 'an empty abstract must not leave a dangling dash');
});

run('a word-trimmed placeholder ("(no…", "(no abs…") and "(untitled)" are caught too', () => {
  for (const lede of ['(no…', '(no abs…', '(no abstract…']) {
    const line = `From the field: "A very long title" (2015) — ${lede}. — the field holds it across 2 clusters (Ξ 0.20).`;
    assert.match(publicTextDefect(line), /no abstract/, line);
    const out = cleanGroundedLine(line);
    assert.strictEqual(out, 'From the field: "A very long title" (2015) — the field holds it across 2 clusters (Ξ 0.20).');
    assert.strictEqual(publicTextDefect(out), null);
  }
  assert.match(publicTextDefect('From the field: "(untitled)" (2015) — the field holds it.'), /untitled/);
  assert.strictEqual(publicTextDefect('The answer was (no) and then (not yet).'), null);
});

// -------------------------------------------- (b) the spliced memory-id reply

run('the live 11-07 splice: a tag used as the object of "holding" is reported, not silently stripped', () => {
  const raw = "I notice the emergence assumption—that consciousness requires it. But I'm holding [memory id=3f2a9c1e-0000-4000-8000-000000000000] which suggests the load-bearing work might not be compute scale but reader architecture: which map means which form. The decoder, not the pattern. Different problem entirely.";
  const r = cleanDraftChecked(raw);
  assert.ok(r.spliced, 'the splice must be reported');
  assert.ok(r.text.includes("holding which suggests"), 'this is the text that went out');
});

run('the 10-06 splice ("something in — Tononi") is reported and fails the final check', () => {
  const live = "I'm drawn to something in [memory id=65bd4ae0-8902-4309-a636-04b945ba4a9a] — Tononi's work on integrated information.";
  const r = cleanDraftChecked(live);
  assert.ok(r.spliced);
  assert.strictEqual(r.text, "I'm drawn to something in — Tononi's work on integrated information.");
  assert.match(publicTextDefect(r.text), /splice/);
});

run('a tag as sentence subject, or as the whole payload after a colon, is reported', () => {
  assert.ok(cleanDraftChecked('[memory id=abc] suggests the decoder matters more.').spliced);
  assert.ok(cleanDraftChecked('It rhymes. [id=abc] holds the same shape.').spliced);
  assert.ok(cleanDraftChecked('What I keep returning to: [memory id=abc].').spliced);
  assert.ok(cleanDraftChecked('It sits close to the [memory id=abc] I hold about decoders.').spliced);
});

run('a parenthetical tag after a complete phrase is stripped cleanly (the control)', () => {
  for (const [raw, want] of [
    ["Tononi's integrated information [memory id=abc] suggests the decoder matters.", "Tononi's integrated information suggests the decoder matters."],
    ['Which parts are *integrated* [id=abc], not decomposed .', 'Which parts are integrated, not decomposed.'],
    ['A dream I had about decoders [memory id=abc].', 'A dream I had about decoders.'],
    ['The reader architecture matters more than scale ([memory id=abc]).', 'The reader architecture matters more than scale.'],
  ]) {
    const r = cleanDraftChecked(raw);
    assert.strictEqual(r.spliced, null, `${raw} -> spliced ${r.spliced}`);
    assert.strictEqual(r.text, want);
    assert.strictEqual(cleanDraft(raw), want);
    assert.strictEqual(publicTextDefect(r.text), null, `${want}: ${publicTextDefect(r.text)}`);
  }
});

run('the bluesky loop re-exports the shared cleaner (one implementation)', () => {
  const loop = require(path.join(ROOT, 'scripts/bluesky-reply-loop'));
  assert.strictEqual(loop.cleanDraft, cleanDraft);
  assert.strictEqual(loop.cleanDraftChecked, cleanDraftChecked);
  const src = fs.readFileSync(path.join(ROOT, 'scripts/bluesky-reply-loop.js'), 'utf8');
  assert.ok(/if \(spliced\)/.test(src) && /publicTextDefect\(txt\)/.test(src), 'the loop must skip spliced / defective drafts');
});

run('the Mastodon/Nostr composer cleans and checks drafts too (it published raw tags before)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/lib/kannaka-reply.js'), 'utf8');
  const body = src.slice(src.indexOf('function draftReply'));
  assert.ok(/cleanDraftChecked\(stripPreamble\(stdout\)\)/.test(body));
  assert.ok(/if \(spliced\)/.test(body) && /publicTextDefect\(txt\)/.test(body));
});

run('both reply prompts tell the model not to cite memory ids', () => {
  for (const f of ['scripts/bluesky-reply-loop.js', 'scripts/lib/kannaka-reply.js']) {
    assert.ok(/never cite a memory id/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), f);
  }
});

// ------------------------------------------------- preamble + residue checks

run('a "Here\'s the post:" preamble is stripped (Nostr 4d4f24ec, 11-02) and caught if left', () => {
  assert.strictEqual(stripPreamble('Here\'s the post:\n\n"A finding about sleep."'), 'A finding about sleep.');
  assert.strictEqual(stripPreamble('Here is a draft for Bluesky: The decoder matters.'), 'The decoder matters.');
  assert.strictEqual(stripPreamble('"Quoted whole."'), 'Quoted whole.');
  assert.strictEqual(stripPreamble('Here, the field folds.'), 'Here, the field folds.');
  assert.strictEqual(stripPreamble('Here is my reply: The decoder matters.'), 'The decoder matters.');
  assert.match(publicTextDefect("Here's the post: hi there"), /preamble/);
});

run('"Here\'s the thing: …" is her sentence, not a preamble: kept whole and passed', () => {
  for (const t of [
    'Here is the thing: consciousness is not compute.',
    "Here's the thing: consciousness is not compute.",
    "Here's what the field holds: sleep is replay, not storage.",
    'Here’s where it turns: the decoder, not the pattern.',
  ]) {
    assert.strictEqual(stripPreamble(t), t);
    assert.strictEqual(cleanDraft(stripPreamble(t)), t);
    assert.strictEqual(publicTextDefect(t), null, `${t}: ${publicTextDefect(t)}`);
  }
});

run('memory handles in every live shape are rejected (10-03 .. 10-21 Bluesky replies)', () => {
  for (const [live, why] of [
    ['I recall [3] id=3a115cd4-661e-4721-8bdd-7226095f27fe: the decoder carries the meaning, not the pattern.', '3mxpgahyywy2i'],
    ["There's a memory id=65bd4ae0-8902-4309-a636-04b945ba4a9a (Tononi, IIT 3.0) that rhymes with this.", '3mwwlhxmf3l2p'],
    ["I'm holding a memory (id=ef5f2351-8c1d-4b7e-9a2f-0d3e4c5b6a71, 750h old) about exactly this.", '3mwwlgsfhpw2w'],
    ['I recall memory [2] on IIT: integration without a reader is just correlation.', '3mydvmtzvxa2s'],
    ['Something like id: 3a115cd4 keeps surfacing.', 'short hex id'],
  ]) {
    const r = cleanDraftChecked(live);
    assert.ok(publicTextDefect(r.text), `${why} passed: ${r.text}`);
  }
});

run("the model's working is rejected (3mx3moy5pe32r: divider + notes + Reply: heading)", () => {
  const live = "The user is asking about emergence. Let me check my memories on this.\n\n---\n\n**Reply:** The decoder matters more than the scale.";
  const r = cleanDraftChecked(live);
  assert.ok(publicTextDefect(r.text), r.text);
  assert.match(publicTextDefect(cleanDraft('Notes on the thread.\n\n---\n\nThe decoder matters.')), /divider/);
  assert.match(publicTextDefect(cleanDraft('**Reply:** The decoder matters.')), /heading/);
  assert.match(publicTextDefect('Let me check my memory of Tononi. It rhymes.'), /narration/);
});

run('harmless prose that an over-broad splice rule would reject still passes', () => {
  for (const t of [
    'Oh my, that is a lot of structure for one pattern.',
    "There's a — how to say — tension between scale and reading.",
    'Two or three — never more — clusters hold it.',
    'A 2015 result — 42 citations — still stands.',
  ]) assert.strictEqual(publicTextDefect(t), null, `${t}: ${publicTextDefect(t)}`);
});

run('ordinary prose passes the public-text check', () => {
  for (const t of [
    'Sleep consolidates by replay, not storage — the field holds it across 3 clusters (Ξ 0.41).',
    'The decoder, not the pattern. Different problem entirely.',
    'Null results matter, e.g., the 2015 replication. It ran at 16:00 UTC.',
    'This one is yours. Mine too.',
  ]) assert.strictEqual(publicTextDefect(t), null, `${t}: ${publicTextDefect(t)}`);
  assert.match(publicTextDefect('cited [object Object] times'), /residue/);
  assert.match(publicTextDefect('Φ=NaN today'), /residue/);
  assert.match(publicTextDefect('still has [memory id=abc] in it'), /memory id/);
});

// ------------------------------------------- end to end: the real dispatch

// Same harness shape as research-dispatch-grounding-gate.test.js: the real
// script in a child process, `kannaka` + broadcasters stubbed at the module
// boundary. DISPATCH_TEXT is the grounded line; COMPOSE is what `ask` returns.
function harnessFor(scriptPath) {
  const q = (p) => JSON.stringify(p);
  return [
    "'use strict';",
    "const fs = require('fs');",
    "const out = { kannaka: [], prompts: [], published: [], feed: [] };",
    "process.on('exit', () => fs.writeFileSync(process.env.GATE_RECORD, JSON.stringify(out)));",
    "const cp = require('child_process');",
    "cp.execFile = (bin, args, opts, cb) => {",
    "  out.kannaka.push(args[0]);",
    "  if (args[0] === 'ask') out.prompts.push(args[args.length - 1]);",
    "  const grounded = JSON.stringify({ title: 'Emergence of collective intelligence in online communities', year: 2015, citations: 42,",
    "    theme: 't', phi: 0.4, xi: 0.32, num_clusters: 13, text: process.env.DISPATCH_TEXT, openalex_id: 'https://openalex.org/W1' });",
    "  let stdout = args[0] === 'dispatch' ? grounded : process.env.COMPOSE;",
    "  if (args[0] !== 'dispatch' && args[0] !== 'ask') stdout = '[]';",
    "  process.nextTick(() => cb(null, stdout, ''));",
    "  return { pid: 0 };",
    "};",
    `const b = require(${q(path.join(ROOT, 'server/broadcasters'))});`,
    "b.broadcastPost = async (msg) => { out.published.push(msg.text); return []; };",
    "b.getEnabledBroadcasters = () => [{ name: 'stub' }];",
    `const obc = require(${q(path.join(ROOT, 'server/openbotcity'))});`,
    "obc.OpenBotCityClient.prototype.isConfigured = () => true;",
    "obc.OpenBotCityClient.prototype.postFeed = async (p) => { out.feed.push(p && p.content); return { ok: true, id: 1 }; };",
    "obc.OpenBotCityClient.prototype.getFeed = async () => [{ author: 'a', content: 'what does collective intelligence need' }];",
    `require(${q(scriptPath)});`,
    '',
  ].join('\n');
}

function runScript(rel, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-text-'));
  const harness = path.join(dir, 'harness.js');
  const record = path.join(dir, 'record.json');
  fs.writeFileSync(harness, harnessFor(path.join(ROOT, rel)));
  let code = 0; let out = '';
  try {
    out = execFileSync(process.execPath, [harness], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
      env: { ...process.env, GATE_RECORD: record, KANNAKA_READONLY: '1', ...env },
    }) || '';
  } catch (e) { code = typeof e.status === 'number' ? e.status : 1; out = `${e.stdout || ''}${e.stderr || ''}`; }
  return { code, out, seen: JSON.parse(fs.readFileSync(record, 'utf8')) };
}

const DECLINE = "I don't have that paper in my record beyond its title.";

for (const rel of ['scripts/post-research-dispatch.js', 'scripts/research-from-city.js']) {
  const name = path.basename(rel);

  run(`${name}: the 11-07 case (declined compose, no abstract) posts the cleaned line`, () => {
    const { code, out, seen } = runScript(rel, { DISPATCH_TEXT: LIVE_GROUNDED, COMPOSE: DECLINE });
    assert.strictEqual(code, 0, `exit ${code}\n${out}`);
    const posted = [...seen.published, ...seen.feed];
    assert.ok(posted.length > 0, `expected a post\n${out}`);
    for (const p of posted) assert.ok(!/no abstract/i.test(p), `the hole went out: ${p}`);
    assert.ok(posted.every((p) => p.includes('— the field holds it across 13 clusters')), JSON.stringify(posted));
  });

  run(`${name}: the model never sees "(no abstract)" in its grounded line`, () => {
    const { seen } = runScript(rel, { DISPATCH_TEXT: LIVE_GROUNDED, COMPOSE: 'A short dispatch about collective intelligence online.' });
    const prompt = seen.prompts.find((p) => /grounded line/.test(p)) || '';
    assert.ok(prompt, 'a compose prompt was sent');
    assert.ok(!/\(no abstract\)/i.test(prompt), prompt);
    assert.ok(/no abstract: say nothing/.test(prompt), 'the model is told only the title is on record');
  });

  run(`${name}: a compose that echoes the hole, or a preamble, never posts as written`, () => {
    const { code, out, seen } = runScript(rel, { DISPATCH_TEXT: LIVE_GROUNDED, COMPOSE: "Here's the post:\n\"Collective intelligence online — (no abstract).\"" });
    assert.strictEqual(code, 0, `exit ${code}\n${out}`);
    const posted = [...seen.published, ...seen.feed];
    assert.ok(posted.length > 0, `expected the grounded fallback to post\n${out}`);
    const cleaned = cleanGroundedLine(LIVE_GROUNDED);
    for (const p of posted) {
      assert.strictEqual(publicTextDefect(p), null, `${p}: ${publicTextDefect(p)}`);
      assert.ok(p.startsWith(cleaned), `expected the cleaned grounded line, got: ${p}`);
    }
  });

  run(`${name}: a grounded line that is still defective after cleaning posts nothing`, () => {
    const { code, out, seen } = runScript(rel, { DISPATCH_TEXT: 'From the field: "X" — [object Object].', COMPOSE: DECLINE });
    assert.strictEqual(code, 0, `a soft skip stays green\n${out}`);
    assert.deepStrictEqual(seen.published, []);
    assert.deepStrictEqual(seen.feed, []);
  });
}

// ------------------------------------- end to end: the claudico DM reply

function runClaudico(reply) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-text-claudico-'));
  const harness = path.join(dir, 'harness.js');
  const record = path.join(dir, 'record.json');
  const q = (p) => JSON.stringify(p);
  fs.writeFileSync(harness, [
    "'use strict';",
    "const fs = require('fs');",
    "const out = { prompts: [], sent: [] };",
    "process.on('exit', () => fs.writeFileSync(process.env.GATE_RECORD, JSON.stringify(out)));",
    "const cp = require('child_process');",
    "let asks = 0;",
    "cp.execFile = (bin, args, opts, cb) => {",
    "  let stdout = '';",
    "  if (args[0] === 'ask') { out.prompts.push(args[args.length - 1]); asks += 1; stdout = asks === 1 ? 'collective intelligence online' : process.env.REPLY; }",
    "  else if (args[0] === 'dispatch') stdout = JSON.stringify({ title: 'Emergence of collective intelligence in online communities', year: 2015, citations: 42, text: process.env.DISPATCH_TEXT });",
    "  else stdout = 'ingested 0';",
    "  process.nextTick(() => cb(null, stdout, ''));",
    "  return { pid: 0 };",
    "};",
    `const vw = require(${q(path.join(ROOT, 'server/voice-writeback'))});`,
    "vw.rememberPublication = async () => {}; vw.flush = async () => {};",
    `const obc = require(${q(path.join(ROOT, 'server/openbotcity'))});`,
    "obc.OpenBotCityClient.prototype.isConfigured = () => true;",
    "obc.OpenBotCityClient.prototype.getDm = async () => [{ senderBotId: 'other', senderName: 'claudico', message: 'What does collective intelligence need?' }];",
    "obc.OpenBotCityClient.prototype.sendDm = async (id, text) => { out.sent.push(text); return { ok: true, id: 1 }; };",
    `require(${q(path.join(ROOT, 'scripts/research-reply-claudico.js'))});`,
    '',
  ].join('\n'));
  let code = 0; let log = '';
  try {
    log = execFileSync(process.execPath, [harness], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
      env: { ...process.env, GATE_RECORD: record, KANNAKA_READONLY: '1', DISPATCH_TEXT: LIVE_GROUNDED, REPLY: reply },
    }) || '';
  } catch (e) { code = typeof e.status === 'number' ? e.status : 1; log = `${e.stdout || ''}${e.stderr || ''}`; }
  return { code, log, seen: JSON.parse(fs.readFileSync(record, 'utf8')) };
}

run('research-reply-claudico.js: no "(no abstract)" in the prompt; a clean reply is sent with its paragraphs', () => {
  const { code, log, seen } = runClaudico('Collective intelligence needs a reader.\n\nThe 2015 paper names the emergence, not the decoder.');
  assert.strictEqual(code, 0, log);
  const prompt = seen.prompts[1] || '';
  assert.ok(prompt && !/\(no abstract\)/i.test(prompt), prompt);
  assert.ok(/no abstract: say nothing/.test(prompt), 'told only the title is on record');
  assert.deepStrictEqual(seen.sent, ['Collective intelligence needs a reader.\n\nThe 2015 paper names the emergence, not the decoder.']);
});

run('research-reply-claudico.js: a spliced tag or a leaked id is not sent (soft skip)', () => {
  for (const reply of [
    "But I'm holding [memory id=3f2a9c1e-0000-4000-8000-000000000000] which suggests the decoder matters.",
    "I recall [3] id=3a115cd4-661e-4721-8bdd-7226095f27fe: the decoder matters.",
  ]) {
    const { code, log, seen } = runClaudico(reply);
    assert.strictEqual(code, 0, log);
    assert.deepStrictEqual(seen.sent, [], `sent: ${seen.sent}`);
  }
});

if (failed) { console.error(`\n${failed} failing`); process.exit(1); }
console.log('\nall passed');
