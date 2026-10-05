'use strict';

// The news desk's world-state market opens from the Flux themes whether or not
// the bulletin airs. It used to open only after a successful delivery, so the
// Anthropic account cap of 2026-09-21..29 (every compose 400) also stopped the
// market loop for nine days. The market never used the bulletin text: it is
// built from the themes and resolved against the next slot's themes.

const assert = require('assert');
const path = require('path');

// Stub the helpers BEFORE news-broadcast loads (it destructures them).
const helpersPath = require.resolve('../server/lib/scheduler-helpers');
const real = require(helpersPath);
let composeResult = null;
const fakeInterp = { text: 'flux', themes: ['Alpha', 'Beta', 'Gamma'], confidence: 0.7, tickRef: 't1' };
require.cache[helpersPath].exports = {
  ...real,
  chicagoNow: () => { const d = new Date('2026-10-06T07:05:00'); return d; },
  keyForChicago: () => '2026-10-06T07',
  loadState: () => ({}),
  saveState: () => {},
  fetchKnowledgeGeneInterpretation: async () => fakeInterp,
  slotExhausted: () => false,
};
const { NewsBroadcast } = require('../server/news-broadcast');

function fakeHub() {
  const markets = [];
  return {
    markets,
    async listMarkets({ tag }) { return markets.filter((m) => !m.resolved && m.tag === tag); },
    async createMarket(m) { const x = { id: 'm_' + markets.length, resolved: false, ...m }; markets.push(x); return x; },
    async placeTrade() {},
    async resolveMarket() {},
  };
}

async function tickAndSettle(nb) {
  nb._tick();
  // fire() is async inside _tick; wait for _preparingKey to clear.
  for (let i = 0; i < 100 && nb._preparingKey; i++) await new Promise((r) => setTimeout(r, 5));
}

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

async function main() {
  console.log('news-world-state-decoupled');

  await test('the market opens even when the bulletin cannot be composed', async () => {
    const hub = fakeHub();
    const nb = new NewsBroadcast({ kannakabin: 'x', voiceDJ: { executeOration: () => true }, broadcast: () => {}, gsHub: hub });
    nb._compose = async () => null; // the LLM is capped: every compose fails
    await tickAndSettle(nb);
    assert.strictEqual(hub.markets.length, 1, `expected one world-state market, got ${hub.markets.length}`);
    assert.strictEqual(hub.markets[0].tag, 'world-state');
    assert.strictEqual(hub.markets[0].metadata.slot_key, '2026-10-06T07');
  });

  await test('retries within a slot do not open a second market', async () => {
    const hub = fakeHub();
    const nb = new NewsBroadcast({ kannakabin: 'x', voiceDJ: { executeOration: () => true }, broadcast: () => {}, gsHub: hub });
    nb._compose = async () => null;
    for (let i = 0; i < 4; i++) await tickAndSettle(nb);
    assert.strictEqual(hub.markets.length, 1, `retries opened ${hub.markets.length} markets`);
  });

  await test('a restarted desk does not reopen a slot the hub already has', async () => {
    const hub = fakeHub();
    const first = new NewsBroadcast({ kannakabin: 'x', voiceDJ: { executeOration: () => true }, broadcast: () => {}, gsHub: hub });
    first._compose = async () => null;
    await tickAndSettle(first);
    const second = new NewsBroadcast({ kannakabin: 'x', voiceDJ: { executeOration: () => true }, broadcast: () => {}, gsHub: hub });
    second._compose = async () => null;
    await tickAndSettle(second);
    assert.strictEqual(hub.markets.length, 1, `a restart opened ${hub.markets.length} markets for one slot`);
  });

  await test('a delivered bulletin still opens exactly one market', async () => {
    const hub = fakeHub();
    const nb = new NewsBroadcast({ kannakabin: 'x', voiceDJ: { executeOration: () => true }, broadcast: () => {}, gsHub: hub });
    nb._compose = async () => 'the bulletin';
    await tickAndSettle(nb);
    assert.strictEqual(hub.markets.length, 1);
  });

  if (failures) { console.error(`news-world-state-decoupled: ${failures} failed`); process.exit(1); }
  console.log('news-world-state-decoupled: all passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
