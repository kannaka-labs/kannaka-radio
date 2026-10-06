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
  const calls = [];
  require.cache[helpersPath].exports = {
    ...real,
    fetchUsgsEarthquakes: async () => null, fetchNasaEonet: async () => null, fetchNoaaSpaceWeather: async () => null,
    fetchSmithsonianVolcanoes: async () => null, fetchNdbcBuoys: async () => null, fetchUsgsWater: async () => null,
    fetchArxiv: async () => null,
    fetchConstellationDispatch: async () => dispatch,
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
    assert.ok(/public repositories were quiet since the last bulletin/.test(text), text);
  });

  await test('an unreadable record adds no constellation segment at all', async () => {
    dispatch = null;
    calls.length = 0;
    const text = await nb._compose(interp, 'news:2026-10-06T07');
    assert.strictEqual(text, 'The world report.', 'an unknown is never reported as quiet');
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
