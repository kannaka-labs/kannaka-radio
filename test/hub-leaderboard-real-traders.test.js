'use strict';

// The leaderboard lists traders who have traded, and never test accounts.
// On O1 (2026-10-05) 40 of 55 registered accounts had never traded and the
// board was mostly empty rows, duplicate sign-ups and deploy/MCP self-tests.

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
require('./lib/sqlite3-guard')('hub-leaderboard-real-traders');
const { GhostSignalsHub } = require('../server/ghostsignals-hub');

function tmpDbPath() {
  const dir = path.join(os.tmpdir(), 'gshub-lb-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'ghostsignals.db');
}

async function main() {
  console.log('hub-leaderboard-real-traders');
  const hub = new GhostSignalsHub({ dbPath: tmpDbPath(), defaultLiquidity: 10 });
  await hub.init();
  await hub.registerTrader({ id: 'trader', display_name: 'trader', kind: 'ai' });
  await hub.registerTrader({ id: 'lurker', display_name: 'lurker', kind: 'human' });
  await hub.registerTrader({ id: 'selftest', display_name: 'selftest', kind: 'test' });
  const m = await hub.createMarket({ question: 'q', ttl_sec: 600, tag: 'custom', source: 'system' });
  await hub.placeTrade({ market_id: m.id, trader_id: 'trader', outcome: 0, shares: 1 });
  await hub.placeTrade({ market_id: m.id, trader_id: 'selftest', outcome: 0, shares: 1 });

  for (const sort of ['capital', 'reputation', 'accuracy']) {
    const ids = (await hub.leaderboard({ sort, limit: 100 })).map((r) => r.id);
    assert.ok(ids.includes('trader'), `${sort}: a trader who traded is listed`);
    assert.ok(!ids.includes('lurker'), `${sort}: an account that never traded is not listed`);
    assert.ok(!ids.includes('selftest'), `${sort}: a test account is not listed even after trading`);
    assert.ok(!ids.includes('system'), `${sort}: the system bootstrapper is not listed`);
  }
  // Nothing is deleted: the hidden accounts still resolve.
  assert.ok(await hub.getTrader('lurker'), 'lurker still exists');
  assert.ok(await hub.getTrader('selftest'), 'selftest still exists');
  await hub.stop?.();
  console.log('hub-leaderboard-real-traders: all passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
