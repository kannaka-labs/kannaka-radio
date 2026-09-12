'use strict';

// ADR-0041 regression: oracle-authoritative (labs-tier) markets must NEVER be
// price-resolved by the TTL auto-resolver. Their outcome belongs to the Labs
// oracle, not to whichever side traders pumped the price to before expiry.
// A play-tier market with the same expiry must still be FINISHED by the
// sweep, so the test also proves we did not simply disable the resolver.
// What finishing means changed: the sweep now VOIDS and refunds rather than
// awarding the highest-priced outcome, because expiry is not evidence. See
// market-ttl-void.test.js.

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
// Skip locally without sqlite3, FAIL under CI (#277): see test/lib/sqlite3-guard.js.
require('./lib/sqlite3-guard')('ghostsignals-ttl-authority');
const { GhostSignalsHub } = require('../server/ghostsignals-hub');

function tmpDbPath() {
  const dir = path.join(os.tmpdir(), 'gshub-test-' + process.pid + '-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'ghostsignals.db');
}

async function main() {
  const hub = new GhostSignalsHub({ dbPath: tmpDbPath(), defaultLiquidity: 10 });
  await hub.init();

  // Both markets expire immediately (ttl 1s, then we backdate via a past ttl).
  // createMarket computes expires_at = now + ttl_sec*1000, so a negative ttl
  // makes them already-expired without waiting.
  const labs = await hub.createMarket({
    question: 'labs market — oracle resolves this',
    ttl_sec: -10, tag: 'labs', source: 'kannaka-labs',
  });
  const play = await hub.createMarket({
    question: 'play market — TTL may resolve this',
    ttl_sec: -10, tag: 'custom', source: 'system',
  });

  // Push the labs market's price toward 'No' so that IF the TTL resolver
  // wrongly fired, it would resolve to the manipulated side (index 1).
  await hub.registerTrader({ id: 'sybil', display_name: 'sybil', kind: 'ai' });
  await hub.placeTrade({ market_id: labs.id, trader_id: 'sybil', outcome: 1, shares: 5 });

  // Run the auto-resolver once.
  await hub._resolveExpiredMarkets();

  const labsAfter = await hub.getMarket(labs.id);
  const playAfter = await hub.getMarket(play.id);

  assert.strictEqual(labsAfter.resolved, false,
    'BLOCKER: labs-tier market was price-resolved by the TTL sweep (oracle gate bypassed)');
  assert.strictEqual(playAfter.resolved, true,
    'play-tier market should still be finished by the TTL sweep — resolver must not be disabled wholesale');
  assert.strictEqual(playAfter.resolved_outcome, null,
    'and finished by VOID, not by awarding a winner the sweep never measured');

  // And the oracle path still works on the labs market.
  await hub.resolveMarket({ market_id: labs.id, winning_outcome: 0, method: 'manual' });
  const labsFinal = await hub.getMarket(labs.id);
  assert.strictEqual(labsFinal.resolved, true, 'oracle resolve must still settle the labs market');
  assert.strictEqual(labsFinal.resolved_outcome, 0, 'oracle outcome must win, not the pumped price');

  await hub.stop?.();
  console.log('ghostsignals-ttl-authority.test.js: OK (labs market survives TTL; play market voids; oracle wins)');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
