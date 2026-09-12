'use strict';

// A market that reaches its TTL without a measurement is VOIDED and refunded,
// never awarded.
//
// The resolver used to pick the outcome with the highest price and call that a
// result. That is not a measurement: it hands the question to whichever side
// put the most money in. Worse, on an untraded market the prices are equal and
// `indexOf(max)` returns index 0, so markets that nobody ever traded resolved
// "Yes" by tie. And resolveMarket brier-scores every participant against the
// outcome, so each of those fabricated results wrote an accuracy score — which
// is how the top of the leaderboard reached a reputation of 0.999999999999999
// across tens of thousands of trades.

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
require('./lib/sqlite3-guard')('market-ttl-void');
const { GhostSignalsHub, unanswerableBy } = require('../server/ghostsignals-hub');

function tmpDbPath() {
  const dir = path.join(os.tmpdir(), 'gshub-void-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'ghostsignals.db');
}

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

async function main() {
  console.log('market-ttl-void');

  // ── an untraded market must not award outcome 0 by tie ────────────────
  await test('an untraded market is voided, not awarded to outcome zero', async () => {
    const hub = new GhostSignalsHub({ dbPath: tmpDbPath(), defaultLiquidity: 10 });
    await hub.init();
    const m = await hub.createMarket({ question: 'nobody traded this one', ttl_sec: -10, tag: 'custom', source: 'system' });
    await hub._resolveExpiredMarkets();
    const after = await hub.getMarket(m.id);
    assert.strictEqual(after.resolved, true, 'it is finished');
    assert.strictEqual(after.resolved_outcome, null,
      `an unmeasured market must name no winner; got ${after.resolved_outcome}`);
    assert.ok(String(after.resolution_method).startsWith('void:'),
      `method should record the void; got ${after.resolution_method}`);
    await hub.stop?.();
  });

  // ── price is not evidence ─────────────────────────────────────────────
  await test('the side that pumped the price does not win', async () => {
    const hub = new GhostSignalsHub({ dbPath: tmpDbPath(), defaultLiquidity: 10 });
    await hub.init();
    const m = await hub.createMarket({ question: 'a pumped market', ttl_sec: -10, tag: 'custom', source: 'system' });
    await hub.registerTrader({ id: 'pump', display_name: 'pump', kind: 'ai' });
    await hub.placeTrade({ market_id: m.id, trader_id: 'pump', outcome: 0, shares: 40 });
    await hub._resolveExpiredMarkets();
    const after = await hub.getMarket(m.id);
    assert.strictEqual(after.resolved_outcome, null, 'buying Yes must not make Yes true');
    await hub.stop?.();
  });

  // ── the money comes back ──────────────────────────────────────────────
  await test('a void refunds what the trader paid', async () => {
    const hub = new GhostSignalsHub({ dbPath: tmpDbPath(), defaultLiquidity: 10 });
    await hub.init();
    await hub.registerTrader({ id: 'alice', display_name: 'alice', kind: 'ai' });
    const before = (await hub.getTrader('alice')).capital;
    const m = await hub.createMarket({ question: 'refund me', ttl_sec: -10, tag: 'custom', source: 'system' });
    await hub.placeTrade({ market_id: m.id, trader_id: 'alice', outcome: 0, shares: 5 });
    const spent = before - (await hub.getTrader('alice')).capital;
    assert.ok(spent > 0, 'the trade must actually cost something');
    await hub._resolveExpiredMarkets();
    const after = (await hub.getTrader('alice')).capital;
    assert.ok(Math.abs(after - before) < 1e-6,
      `capital should return to ${before}, got ${after} (spent ${spent})`);
    await hub.stop?.();
  });

  // ── and nobody is scored on a question nobody answered ────────────────
  await test('a void scores nobody', async () => {
    const hub = new GhostSignalsHub({ dbPath: tmpDbPath(), defaultLiquidity: 10 });
    await hub.init();
    await hub.registerTrader({ id: 'bob', display_name: 'bob', kind: 'ai' });
    const repBefore = (await hub.getTrader('bob')).reputation;
    const m = await hub.createMarket({ question: 'unscored', ttl_sec: -10, tag: 'custom', source: 'system' });
    await hub.placeTrade({ market_id: m.id, trader_id: 'bob', outcome: 0, shares: 9 });
    await hub._resolveExpiredMarkets();
    const repAfter = (await hub.getTrader('bob')).reputation;
    assert.strictEqual(repAfter, repBefore,
      `reputation must not move on an unmeasured market: ${repBefore} -> ${repAfter}`);
    await hub.stop?.();
  });

  // ── the stake can only come back once ─────────────────────────────────
  await test('a second void cannot refund the same stake twice', async () => {
    const hub = new GhostSignalsHub({ dbPath: tmpDbPath(), defaultLiquidity: 10 });
    await hub.init();
    await hub.registerTrader({ id: 'carol', display_name: 'carol', kind: 'ai' });
    const before = (await hub.getTrader('carol')).capital;
    const m = await hub.createMarket({ question: 'once only', ttl_sec: -10, tag: 'custom', source: 'system' });
    await hub.placeTrade({ market_id: m.id, trader_id: 'carol', outcome: 1, shares: 6 });
    await hub.voidMarket({ market_id: m.id, reason: 'first' });
    await assert.rejects(() => hub.voidMarket({ market_id: m.id, reason: 'second' }), /already resolved/);
    await hub._resolveExpiredMarkets();
    const after = (await hub.getTrader('carol')).capital;
    assert.ok(Math.abs(after - before) < 1e-6, `capital must not be minted: ${before} -> ${after}`);
    await hub.stop?.();
  });

  // ── a voided position is not a loss ───────────────────────────────────
  await test('a refunded position does not read as a loss', async () => {
    const hub = new GhostSignalsHub({ dbPath: tmpDbPath(), defaultLiquidity: 10 });
    await hub.init();
    await hub.registerTrader({ id: 'dave', display_name: 'dave', kind: 'ai' });
    const m = await hub.createMarket({ question: 'not a loss', ttl_sec: -10, tag: 'custom', source: 'system' });
    await hub.placeTrade({ market_id: m.id, trader_id: 'dave', outcome: 0, shares: 4 });
    await hub._resolveExpiredMarkets();
    const pos = (await hub.getTraderPositions('dave')).find((p) => p.market_id === m.id);
    assert.ok(pos, 'the position is still listed');
    assert.strictEqual(pos.voided, true, 'it should say voided');
    assert.strictEqual(pos.won, null, 'a void is neither won nor lost');
    await hub.stop?.();
  });

  // ── the labs gate still holds ─────────────────────────────────────────
  await test('a labs market is still never touched by the TTL sweep', async () => {
    const hub = new GhostSignalsHub({ dbPath: tmpDbPath(), defaultLiquidity: 10 });
    await hub.init();
    const labs = await hub.createMarket({ question: 'oracle decides', ttl_sec: -10, tag: 'labs', source: 'kannaka-labs' });
    await hub._resolveExpiredMarkets();
    const after = await hub.getMarket(labs.id);
    assert.strictEqual(after.resolved, false, 'the oracle gate must still hold');
    await hub.stop?.();
  });

  // ── the unanswerable-market guard (pure, no db) ───────────────────────
  await test('a market may not ask about a field its own record leaves null', () => {
    const orc = { track_title: 'Polite Apocalypse', album: 'OPT OUT', orc_stem_id: null, orc_phase: null };
    assert.strictEqual(
      unanswerableBy('Will "Polite Apocalypse" stay on the canonical reference album for its phase?', orc),
      'orc_phase');
    assert.strictEqual(unanswerableBy('...for its phase?', { orc_phase: 'p1' }), null, 'present is fine');
    assert.strictEqual(unanswerableBy('Will zone 5 reach 12 plots?', { orc_phase: null }), null,
      'a null the question never mentions is not our business');
    assert.strictEqual(unanswerableBy('anything at all', null), null);
    assert.strictEqual(unanswerableBy('does orc matter', { orc_phase: null }), null,
      'the namespace prefix alone must not trigger');
  });

  await test('createMarket refuses an unanswerable market at the door', async () => {
    const hub = new GhostSignalsHub({ dbPath: tmpDbPath(), defaultLiquidity: 10 });
    await hub.init();
    await assert.rejects(() => hub.createMarket({
      question: 'Will "Polite Apocalypse" stay on the canonical reference album for its phase?',
      ttl_sec: 600, tag: 'orc-resonance', source: 'system',
      metadata: { track_title: 'Polite Apocalypse', orc_phase: null },
    }), /unanswerable/);
    // the same question with the field populated still opens
    const ok = await hub.createMarket({
      question: 'Will "Polite Apocalypse" stay on the canonical reference album for its phase?',
      ttl_sec: 600, tag: 'orc-resonance', source: 'system',
      metadata: { track_title: 'Polite Apocalypse', orc_phase: 'phase-2' },
    });
    assert.ok(ok && ok.id, 'an answerable market still opens');
    await hub.stop?.();
  });

  if (failures) { console.error(`market-ttl-void: ${failures} failed`); process.exit(1); }
  console.log('market-ttl-void: all passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
