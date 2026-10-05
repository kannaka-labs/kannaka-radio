'use strict';

// Accuracy is markets WON over markets MEASURED.
//
// `trades_won` counts markets (one per resolved market where the trader held the
// winning side); `trades_total` counts individual trades. The hub divided the
// first by the second, which was never a rate: after the 2026-09-12 repair it
// read ~0.4% for a curator that had won 117 of 121 measured markets, and KAX's
// leaderboard published that number. A voided market (no measurement) is not a
// loss and is not in the denominator; a trader with no measured market has no
// accuracy (null), not 0%.

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
require('./lib/sqlite3-guard')('hub-accuracy-measured');
const { GhostSignalsHub } = require('../server/ghostsignals-hub');

function tmpDbPath() {
  const dir = path.join(os.tmpdir(), 'gshub-acc-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'ghostsignals.db');
}

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

async function main() {
  console.log('hub-accuracy-measured');

  await test('many trades on few markets: accuracy is per market, not per trade', async () => {
    const hub = new GhostSignalsHub({ dbPath: tmpDbPath(), defaultLiquidity: 10 });
    await hub.init();
    await hub.registerTrader({ id: 'ann', display_name: 'ann', kind: 'ai' });
    const a = await hub.createMarket({ question: 'measured one', ttl_sec: 600, tag: 'custom', source: 'system' });
    const b = await hub.createMarket({ question: 'measured two', ttl_sec: 600, tag: 'custom', source: 'system' });
    for (let i = 0; i < 5; i++) await hub.placeTrade({ market_id: a.id, trader_id: 'ann', outcome: 0, shares: 1 });
    for (let i = 0; i < 5; i++) await hub.placeTrade({ market_id: b.id, trader_id: 'ann', outcome: 0, shares: 1 });
    await hub.resolveMarket({ market_id: a.id, winning_outcome: 0, method: 'labs-settlement' });
    await hub.resolveMarket({ market_id: b.id, winning_outcome: 1, method: 'labs-settlement' });
    const t = await hub.getTrader('ann');
    assert.strictEqual(t.trades_total, 10, 'ten trades were placed');
    assert.strictEqual(t.markets_measured, 2, 'on two measured markets');
    assert.strictEqual(t.accuracy, 0.5, `won one of two markets, got ${t.accuracy} (the old formula gives 0.1)`);
    const row = (await hub.leaderboard({ sort: 'accuracy' })).find((r) => r.id === 'ann');
    assert.strictEqual(row.accuracy, 0.5, 'the leaderboard agrees with getTrader');
    await hub.stop?.();
  });

  await test('a voided market is neither a win nor in the denominator', async () => {
    const hub = new GhostSignalsHub({ dbPath: tmpDbPath(), defaultLiquidity: 10 });
    await hub.init();
    await hub.registerTrader({ id: 'ben', display_name: 'ben', kind: 'ai' });
    const won = await hub.createMarket({ question: 'measured', ttl_sec: 600, tag: 'custom', source: 'system' });
    const voided = await hub.createMarket({ question: 'never measured', ttl_sec: -10, tag: 'custom', source: 'system' });
    await hub.placeTrade({ market_id: won.id, trader_id: 'ben', outcome: 1, shares: 2 });
    await hub.placeTrade({ market_id: voided.id, trader_id: 'ben', outcome: 0, shares: 2 });
    await hub.resolveMarket({ market_id: won.id, winning_outcome: 1, method: 'labs-settlement' });
    await hub._resolveExpiredMarkets();
    const t = await hub.getTrader('ben');
    assert.strictEqual(t.markets_measured, 1, 'the void is not a measured market');
    assert.strictEqual(t.accuracy, 1, `one measured market, won: ${t.accuracy}`);
    await hub.stop?.();
  });

  await test('no measured market means no accuracy, not 0%', async () => {
    const hub = new GhostSignalsHub({ dbPath: tmpDbPath(), defaultLiquidity: 10 });
    await hub.init();
    await hub.registerTrader({ id: 'cat', display_name: 'cat', kind: 'ai' });
    const t = await hub.getTrader('cat');
    assert.strictEqual(t.markets_measured, 0);
    assert.strictEqual(t.accuracy, null, `an empty record must read null, got ${t.accuracy}`);
    await hub.stop?.();
  });

  await test('sorting by accuracy puts measured records first', async () => {
    const hub = new GhostSignalsHub({ dbPath: tmpDbPath(), defaultLiquidity: 10 });
    await hub.init();
    await hub.registerTrader({ id: 'dee', display_name: 'dee', kind: 'ai' });
    await hub.registerTrader({ id: 'eve', display_name: 'eve', kind: 'ai' });
    const m = await hub.createMarket({ question: 'q', ttl_sec: 600, tag: 'custom', source: 'system' });
    await hub.placeTrade({ market_id: m.id, trader_id: 'dee', outcome: 0, shares: 1 });
    await hub.resolveMarket({ market_id: m.id, winning_outcome: 1, method: 'labs-settlement' });
    // eve has traded (the board lists only traders who have) but on a market
    // that has not resolved: a real trader with no measured record.
    const open = await hub.createMarket({ question: 'still open', ttl_sec: 600, tag: 'custom', source: 'system' });
    await hub.placeTrade({ market_id: open.id, trader_id: 'eve', outcome: 0, shares: 1 });
    const rows = await hub.leaderboard({ sort: 'accuracy', limit: 100 });
    const iDee = rows.findIndex((r) => r.id === 'dee');
    const iEve = rows.findIndex((r) => r.id === 'eve');
    assert.ok(iDee >= 0 && iEve >= 0, 'both listed');
    assert.ok(iDee < iEve, 'a 0% measured record still ranks above no record at all');
    assert.strictEqual(rows[iDee].accuracy, 0);
    assert.strictEqual(rows[iEve].accuracy, null);
    await hub.stop?.();
  });

  if (failures) { console.error(`hub-accuracy-measured: ${failures} failed`); process.exit(1); }
  console.log('hub-accuracy-measured: all passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
