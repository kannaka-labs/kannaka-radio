'use strict';

// The news desk reports what shipped inside the Kannaka Constellation, not only
// the world's data streams (Nick, 2026-10-06). Source: merged pull requests in
// the org's PUBLIC repositories since the previous bulletin. Private repos must
// never reach the air, an unreadable GitHub must not be reported as "quiet",
// and Gene is told to report only what the dispatch lists.

const assert = require('assert');
const helpersPath = require.resolve('../server/lib/scheduler-helpers');
const real = require(helpersPath);

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

async function main() {
  console.log('news-constellation-dispatch');

  await test('a PR body becomes one plain sentence, without attribution lines', () => {
    const body = 'The probe and tangle **live-recall** fallbacks passed `--json` to [kannaka recall](https://x), which exits 2. So the fallback never ran.\n\nSecond paragraph.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)';
    const s = real.summarizePrBody(body);
    assert.ok(s.startsWith('The probe and tangle live-recall fallbacks passed --json to kannaka recall'), s);
    assert.ok(!/Second paragraph|Generated with|\*\*|`|\]\(/.test(s), s);
    assert.strictEqual(real.summarizePrBody(''), '');
    assert.ok(real.summarizePrBody('x '.repeat(400)).length <= 245, 'long bodies are cut');
  });

  await test('the search asks for merged PRs in PUBLIC repos since the window opened', async () => {
    let asked = null;
    const items = [
      { repository_url: 'https://api.github.com/repos/kannaka-labs/kannaka-radio', title: 'older', body: 'a', pull_request: { merged_at: '2026-10-05T10:00:00Z' } },
      { repository_url: 'https://api.github.com/repos/kannaka-labs/kannaka-memory', title: 'newer', body: 'b', pull_request: { merged_at: '2026-10-05T20:00:00Z' } },
    ];
    const out = await real.fetchConstellationDispatch({ sinceIso: '2026-10-05T08:00:00Z', getJson: async (url) => { asked = decodeURIComponent(url); return { items }; } });
    assert.ok(/is:public/.test(asked), `private repos must be excluded by the query: ${asked}`);
    assert.ok(/is:merged/.test(asked) && /merged:>=2026-10-05T08:00:00Z/.test(asked), asked);
    assert.deepStrictEqual(out.map((x) => x.title), ['newer', 'older'], 'newest first');
    assert.strictEqual(out[0].repo, 'kannaka-memory');
  });

  await test('unreadable GitHub is null (unknown), an empty result is [] (quiet)', async () => {
    assert.strictEqual(await real.fetchConstellationDispatch({ sinceIso: 'x', getJson: async () => null }), null);
    assert.deepStrictEqual(await real.fetchConstellationDispatch({ sinceIso: 'x', getJson: async () => ({ items: [] }) }), []);
  });

  // ── the segment Gene composes ──
  let dispatch = null;
  let uploads = null, markets = null, health = null;
  const calls = [];
  require.cache[helpersPath].exports = {
    ...real,
    fetchUsgsEarthquakes: async () => null, fetchNasaEonet: async () => null, fetchNoaaSpaceWeather: async () => null,
    fetchSmithsonianVolcanoes: async () => null, fetchNdbcBuoys: async () => null, fetchUsgsWater: async () => null,
    fetchArxiv: async () => null,
    fetchConstellationDispatch: async () => dispatch,
    fetchChannelUploads: async () => uploads,
    fetchPredictionActivity: async () => markets,
    probeConstellationHealth: async () => health,
    composeResilient: async (_bin, p, opts) => {
      calls.push({ label: opts.label, slot: opts.slot, prompt: p });
      return opts.label === 'news' ? 'The world report.' : 'Closer to home, the news desk changed how its markets open. It now opens them early';
    },
  };
  delete require.cache[require.resolve('../server/news-broadcast')];
  const { NewsBroadcast, completeSentences } = require('../server/news-broadcast');
  const nb = new NewsBroadcast({ kannakabin: 'x', voiceDJ: null, broadcast: () => {}, dataDir: require('os').tmpdir() });
  const interp = { text: 'flux says', themes: ['Alpha'] };

  await test('shipped work becomes its own short segment after the world report', async () => {
    dispatch = [{ repo: 'kannaka-radio', title: 'news desk: open the world-state market from the Flux themes', summary: 'An LLM outage no longer stops the market loop.' }];
    calls.length = 0;
    const text = await nb._compose(interp, 'news:2026-10-06T07');
    assert.deepStrictEqual(calls.map((c) => c.label), ['news', 'news-constellation'], 'world first, then the constellation');
    const cp = calls[1].prompt;
    assert.ok(cp.includes('[kannaka-radio] news desk: open the world-state market'), 'item listed');
    assert.ok(/Report ONLY what the source lists/.test(cp), 'grounding rule');
    assert.ok(/Never read pull-request numbers/.test(cp), 'no PR numbers on air');
    assert.ok(/110 to 150 spoken words/.test(cp), 'short enough to fit the 512-token cap');
    assert.strictEqual(calls[1].slot, 'news:2026-10-06T07:constellation', 'its own retry budget');
    assert.ok(!/CONSTELLATION|pull request/i.test(calls[0].prompt), 'the world prompt is unchanged');
    assert.strictEqual(text, 'The world report.\n\nCloser to home, the news desk changed how its markets open.', 'a cut-off sentence is trimmed');
  });

  await test('a quiet window is one fixed sentence, with no compose call', async () => {
    dispatch = [];
    calls.length = 0;
    const text = await nb._compose(interp, 'news:2026-10-06T17');
    assert.deepStrictEqual(calls.map((c) => c.label), ['news']);
    assert.ok(/quiet stretch since the last bulletin/.test(text), text);
  });

  await test('an unreadable record adds no constellation segment at all', async () => {
    dispatch = null;
    calls.length = 0;
    const text = await nb._compose(interp, 'news:2026-10-06T07');
    assert.strictEqual(text, 'The world report.', 'an unknown is never reported as quiet');
  });


  await test('episodes, market settlements and an outage all reach the segment', async () => {
    dispatch = [];
    uploads = [{ title: 'TSOF E11 — The Finished Instruments | The Story of Flaukowski', published: '2026-10-04T23:56:01+00:00' }];
    markets = { settled: [{ number: 120, statement: 'Tiramisu will create more than 4 artifacts today', outcome: 'TRUE' }], opened: [] };
    health = [{ name: 'Kannaka TV', ok: true }, { name: 'the observatory', ok: false }];
    calls.length = 0;
    await nb._compose(interp, 'news:2026-10-06T17');
    const cp = calls.find((c) => c.label === 'news-constellation').prompt;
    assert.ok(cp.includes('NEW ON THE STATION\'S CHANNEL') && cp.includes('The Finished Instruments'), 'the episode is in the source');
    assert.ok(/settled TRUE: "Tiramisu will create more than 4 artifacts today"/.test(cp), 'the settlement is in the source');
    assert.ok(/the observatory: did NOT answer/.test(cp), 'the outage is in the source');
    assert.ok(/nothing merged/.test(cp), 'an empty-but-readable source says so');
    uploads = markets = health = null;
  });

  const { buildConstellationDispatch } = require('../server/news-broadcast');

  await test('nothing readable is null; readable but quiet is the quiet line', () => {
    assert.strictEqual(buildConstellationDispatch({ items: null, uploads: null, markets: null, health: null }), null);
    const q = buildConstellationDispatch({ items: [], uploads: [], markets: { settled: [], opened: [] }, health: [{ name: 'x', ok: true }] });
    assert.strictEqual(q.quiet, true);
    assert.ok(/every service we checked is answering/.test(q.quietLine), q.quietLine);
    const down = buildConstellationDispatch({ items: [], uploads: [], markets: { settled: [], opened: [] }, health: [{ name: 'x', ok: false }] });
    assert.strictEqual(down.quiet, false, 'an outage is news even when nothing shipped');
  });

  await test('an unreadable source is left out, never described as empty', () => {
    const d = buildConstellationDispatch({ items: [{ repo: 'r', title: 't' }], uploads: null, markets: null, health: null });
    assert.ok(!/CHANNEL|PREDICTION|HEALTH/.test(d.text), d.text);
  });

  await test('the RSS parser keeps uploads inside the window, newest first, entities decoded', async () => {
    const feed = '<feed><title>Ghost Signals with Kannaka</title>'
      + '<entry><title>GSP-046 — AI for the People &amp; more</title><published>2026-10-04T04:49:01+00:00</published></entry>'
      + '<entry><title>Old one</title><published>2026-09-01T00:00:00+00:00</published></entry>'
      + '<entry><title>TSOF E11 — The Finished Instruments</title><published>2026-10-04T23:56:01+00:00</published></entry></feed>';
    const out = await real.fetchChannelUploads({ sinceIso: '2026-10-03T00:00:00Z', getText: async () => ({ status: 200, body: feed }) });
    assert.deepStrictEqual(out.map((v) => v.title), ['TSOF E11 — The Finished Instruments', 'GSP-046 — AI for the People & more']);
    assert.strictEqual(await real.fetchChannelUploads({ sinceIso: 'x', getText: async () => null }), null, 'unreachable is null');
  });

  await test('prediction activity keeps settlements and openings inside the window', async () => {
    const body = JSON.stringify({ predictions: [
      { number: 1, status: 'settled', statement: 'old', outcome: true, settledAt: '2026-09-01T00:00:00Z' },
      { number: 2, status: 'settled', statement: 'new', outcome: false, settledAt: '2026-10-06T01:00:00Z' },
      { number: 3, status: 'open', statement: 'fresh', openedAt: '2026-10-06T02:00:00Z', settlesBy: '2026-10-07' },
      { number: 4, status: 'proposed', statement: 'not news', createdAt: '2026-10-06T02:00:00Z' },
    ] });
    const out = await real.fetchPredictionActivity({ sinceIso: '2026-10-05T12:00:00Z', getText: async () => ({ status: 200, body }) });
    assert.deepStrictEqual(out.settled.map((p) => [p.number, p.outcome]), [[2, 'FALSE']]);
    assert.deepStrictEqual(out.opened.map((p) => p.number), [3]);
    assert.strictEqual(await real.fetchPredictionActivity({ sinceIso: 'x', getText: async () => ({ status: 502, body: '' }) }), null);
  });

  await test('health: a service that errors, refuses or is off air does not answer', async () => {
    const checks = [
      { name: 'up', url: 'u1', ok: (r) => r.status === 200 },
      { name: 'refused', url: 'u2', ok: (r) => r.status === 200 },
      { name: 'unreachable', url: 'u3', ok: (r) => r.status === 200 },
    ];
    const res = { u1: { status: 200, body: '' }, u2: { status: 503, body: '' }, u3: null };
    const out = await real.probeConstellationHealth({ checks, getText: async (u) => res[u] });
    assert.deepStrictEqual(out, [{ name: 'up', ok: true }, { name: 'refused', ok: false }, { name: 'unreachable', ok: false }]);
  });

  await test('a sentence with a number the source does not contain is removed', () => {
    const { dropUngroundedNumbers } = require('../server/news-broadcast');
    const source = '  - [kannaka-radio] leaderboard — 40 of 55 accounts had never traded. It won 117 of 121 measured markets.';
    const text = 'Forty-five became 45 of 55 accounts on the board. The curator won 117 of 121 measured markets. The board now lists real traders only.';
    const out = dropUngroundedNumbers(text, source);
    assert.ok(!/45/.test(out), `an inflated count must not reach the air: ${out}`);
    assert.ok(/117 of 121/.test(out), 'a grounded number stays');
    assert.ok(/real traders only/.test(out), 'sentences without numbers stay');
    assert.strictEqual(dropUngroundedNumbers('Only 99 bad numbers here, nothing else.', source), null, 'nothing grounded left means no segment');
    assert.ok(/1,000/.test(dropUngroundedNumbers('The cap is 1,000 messages per stream today.', 'cap 1000 messages') || ''), 'thousands separators are normalised for the comparison');
  });

  await test('numbers written as words are checked too', () => {
    const { dropUngroundedNumbers, wordNumbers } = require('../server/news-broadcast');
    assert.deepStrictEqual(wordNumbers('forty-five of fifty-five; one hundred and seventeen of one hundred twenty-one; the twenty-first'), [45, 55, 117, 121, 21]);
    const source = '  - [kannaka-radio] 40 of 55 accounts had never traded; won 117 of 121 (09-21..09-29).';
    const text = 'Forty-five of fifty-five accounts had never traded. It won one hundred seventeen of one hundred twenty-one markets. That ran from the twenty-first. A small but stubborn one got fixed too.';
    const out = dropUngroundedNumbers(text, source);
    assert.ok(!/Forty-five/.test(out), `inflated word count must go: ${out}`);
    assert.ok(/one hundred seventeen of one hundred twenty-one/.test(out), 'grounded word numbers stay');
    assert.ok(/twenty-first/.test(out), 'a grounded ordinal date stays');
    assert.ok(/stubborn one/.test(out), 'small numbers are phrasing, not claims');
  });

  await test('a small number attached to a span of time is checked', () => {
    const { dropUngroundedNumbers } = require('../server/news-broadcast');
    const source = 'Every weekly research synthesis since at least 09-23 skipped. It failed 83 times.';
    const text = 'The digest is back after six weeks of silence. It had failed 83 times. A small but stubborn one is fixed.';
    const out = dropUngroundedNumbers(text, source);
    assert.ok(!/six weeks/.test(out), `an invented duration must go: ${out}`);
    assert.ok(/83 times/.test(out) && /stubborn one/.test(out), out);
  });

  await test('completeSentences keeps whole sentences and drops emphasis marks', () => {
    assert.strictEqual(completeSentences('One thing happened. Then **another** thing happened.'), 'One thing happened. Then another thing happened.');
    assert.strictEqual(completeSentences('A full first sentence that is long enough to keep. And then it was cut'), 'A full first sentence that is long enough to keep.');
    assert.strictEqual(completeSentences('cut'), null);
    assert.strictEqual(completeSentences(null), null);
  });

  if (failures) { console.error(`news-constellation-dispatch: ${failures} failed`); process.exit(1); }
  console.log('news-constellation-dispatch: all passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
