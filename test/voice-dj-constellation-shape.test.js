/**
 * voice-dj-constellation-shape.test.js — VoiceDJ must read the Observatory
 * /api/constellation shape that is actually deployed (#246).
 *
 * The live endpoint returns
 *   { timestamp, total_apps, up, down, apps: [ { id, status, metrics }, ... ] }
 * with the HRM vitals in apps[id="kannaka-memory"].metrics
 * (queen_phi, total_memories, total_clusters). _fetchObservatoryMetrics()
 * only read legacy top-level `phi` / `cluster_count` / `memory_count` (or
 * `constellation.kannaka.phi`), so every Observatory field came back null
 * and the market-commentary segment never spoke the live vitals.
 *
 * The fixture below is trimmed from a real response
 * (curl https://observatory.ninja-portal.com/api/constellation, 2026-09-26).
 * No network: _fetchJSON is stubbed.
 */

'use strict';

const assert = require('assert');
const { VoiceDJ } = require('../server/voice-dj');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}: ${e.message}`); failed++; }
}

const LIVE = {
  timestamp: '2026-09-26T01:01:22.629Z',
  total_apps: 10,
  up: 8,
  down: 1,
  apps: [
    { id: 'kannaka-radio', status: 'up', metrics: { channel: 'dj', current_track: 'The Gift' } },
    { id: 'kannaka-observatory', status: 'up', metrics: { cached_observe_ts: 1790380099817 } },
    { id: 'kannaktopus', status: 'down', metrics: { mcp: 'stdio + http' } },
    { id: 'kannaka-memory', status: 'up', metrics: {
      agents: ['kannaktopus-01', 'kannaka-prime'], agent_count: 9, trusted_agent_count: 4,
      queen_phi: 0.6438816785812378, queen_order: 0.23637796938419342,
      total_memories: 2562, total_clusters: 11 } },
    { id: 'orc-submission-portal', status: 'up', metrics: null },
    { id: 'kax', status: 'up', metrics: {} },
    { id: 'ghostsignals-hub', status: 'browser', metrics: { note: 'Runs per-client' } },
  ],
};
const GS = { ok: true, stats: { traders: 27, markets_total: 48131, markets_active: 12, trades_total: 55307 } };

function makeDJ(constellation, gs = GS) {
  const dj = new VoiceDJ({
    voiceDir: '.', kannakabin: 'kannaka', broadcast: () => {},
    getPerception: () => ({}), getHistory: () => [], isLive: () => false, getChannel: () => 'dj',
  });
  dj._fetchJSON = async (url) => {
    if (url.includes('/api/gshub/stats')) return gs;
    if (url.includes('/api/constellation')) return constellation;
    return null;
  };
  return dj;
}

(async () => {
  console.log('\nvoice-dj-constellation-shape.test.js');

  const m = await makeDJ(LIVE)._fetchObservatoryMetrics();

  await test('#246 queen_phi from the kannaka-memory app becomes phi', () => {
    assert.strictEqual(m.phi, 0.6438816785812378, JSON.stringify(m));
  });
  await test('#246 total_memories becomes memory_count', () => {
    assert.strictEqual(m.memory_count, 2562, JSON.stringify(m));
  });
  await test('#246 total_clusters becomes cluster_count', () => {
    assert.strictEqual(m.cluster_count, 11, JSON.stringify(m));
  });
  await test('#246 constellation up / total_apps are read as nodes online', () => {
    assert.strictEqual(m.nodes_online, 8, JSON.stringify(m));
    assert.strictEqual(m.nodes_total, 10, JSON.stringify(m));
  });
  await test('the { ok, stats } gshub envelope is still unwrapped', () => {
    assert.strictEqual(m.active_markets, 12);
    assert.strictEqual(m.total_traders, 27);
    assert.strictEqual(m.total_trades, 55307);
  });

  await test('#246 the spoken line carries the live vitals, and nodes are not HRM clusters', () => {
    const dj = makeDJ(LIVE);
    const line = dj._formatMetrics(m);
    assert.ok(line && /my phi is at 0\.64/.test(line), line);
    assert.ok(/8 of 10 constellation nodes online/.test(line), line);
    assert.ok(!/11 of my constellation nodes/.test(line), `HRM clusters announced as nodes: ${line}`);
  });

  await test('a kannaka-memory app with no numeric metrics yields nulls, not NaN/garbage', async () => {
    const shape = { ...LIVE, apps: [{ id: 'kannaka-memory', status: 'down', metrics: { queen_phi: 'n/a' } }] };
    const r = await makeDJ(shape)._fetchObservatoryMetrics();
    assert.strictEqual(r.phi, null, JSON.stringify(r));
    assert.strictEqual(r.memory_count, null, JSON.stringify(r));
    assert.strictEqual(r.cluster_count, null, JSON.stringify(r));
  });

  await test('the legacy top-level shape still parses', async () => {
    const r = await makeDJ({ phi: 0.3, cluster_count: 5, memory_count: 100 })._fetchObservatoryMetrics();
    assert.strictEqual(r.phi, 0.3);
    assert.strictEqual(r.cluster_count, 5);
    assert.strictEqual(r.memory_count, 100);
  });

  await test('an unreachable Observatory leaves every Observatory field null', async () => {
    const r = await makeDJ(null)._fetchObservatoryMetrics();
    for (const k of ['phi', 'cluster_count', 'memory_count', 'nodes_online', 'nodes_total']) {
      assert.ok(r[k] === null || r[k] === undefined, `${k}=${r[k]}`);
    }
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  VoiceDJ constellation shape: ${passed} passed, ${failed} failed`);
  console.log(`${'─'.repeat(50)}`);
  process.exit(failed === 0 ? 0 : 1);
})();
