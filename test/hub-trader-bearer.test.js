'use strict';

// hub-trader-bearer.test.js — the #303 register/trade token contract, driven
// through the REAL routes.js against a REAL (temp-db) GhostSignalsHub, so the
// HTTP shape `kannaka init` depends on is what is asserted:
//
//   1. POST /api/agents/register {agent_id} -> 200 {ok, trader, token}; the
//      token is a hub bearer, the trader row shows has_bearer and never its
//      hash/salt (register reply, GET /api/agents/:id, gs_trader_joined),
//   2. re-registering that agent_id WITHOUT the bearer -> 409, row unchanged,
//   3. re-registering WITH the current bearer -> 200 and a rotated token; the
//      old token no longer trades,
//   4. trade with the bearer -> 200; the same trade with no Authorization on a
//      bearer row -> 401 and no trade is recorded; a bearer used with a body
//      trader_id naming ANOTHER row -> 403,
//   5. a pre-existing row (registered internally, no bearer — the pre-#303
//      fleet) still trades unauthenticated; an ANONYMOUS HTTP register of it
//      returns the row with NO token and leaves it open (one POST must not take
//      a permanent bearer on kannaka-01); the ORACLE token attaches a bearer,
//      after which the unauthenticated path closes,
//   6. the old `id` body key still registers and receives a token,
//   7. `kax:` ids never get a bearer (403 self-register; internal auto-register
//      returns no token),
//   8. the bearer write is its own serialized transaction: a unit that holds
//      BEGIN open on the shared connection and then ROLLBACKs cannot discard a
//      registration whose token was already handed out (pre-fix: 200 + token,
//      row has_bearer=false; on rotate the new token was dead and the old one
//      stayed live -> permanent 409),
//   9. POST /api/agents/:id/bearer/reset is oracle-only and reopens a row,
//  10. a bearer minted for row A never authenticates row B — a forged token
//      carrying B's id with A's secret is refused, and A's bearer cannot
//      re-register B.

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { EventEmitter } = require('events');
require('./lib/sqlite3-guard')('hub-trader-bearer');
const { GhostSignalsHub } = require('../server/ghostsignals-hub');
const setupRoutes = require('../server/routes');

process.env.GSHUB_ORACLE_TOKEN = 'test-oracle-token';

function mockReq(method, url, headers, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = Object.assign({ host: 'localhost' }, headers || {});
  req.destroyed = false;
  req.destroy = () => { req.destroyed = true; };
  req.resume = () => {};
  const origOn = req.on.bind(req);
  req.on = (event, cb) => {
    origOn(event, cb);
    if (event === 'end') {
      setImmediate(() => {
        if (body != null) req.emit('data', Buffer.from(body));
        req.emit('end');
      });
    }
    return req;
  };
  return req;
}
function mockRes() {
  const res = { statusCode: null, body: '', headers: null };
  res.done = new Promise((r) => { res._resolve = r; });
  res.writeHead = (code, hdrs) => { res.statusCode = code; res.headers = hdrs; };
  res.end = (data) => { if (data) res.body += data; res._resolve(); };
  return res;
}
async function call(handler, method, url, headers, body) {
  const req = mockReq(method, url, headers, body == null ? null : JSON.stringify(body));
  const res = mockRes();
  await handler(req, res); await res.done;
  let json = null;
  try { json = JSON.parse(res.body); } catch (_) {}
  return { status: res.statusCode, json };
}

let failed = 0;
async function run(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}: ${e.stack || e.message}`); failed++; }
}

async function main() {
  console.log('hub-trader-bearer.test.js');
  const dir = path.join(os.tmpdir(), `gshub-bearer-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const joined = [];
  const hub = new GhostSignalsHub({ dbPath: path.join(dir, 'ghostsignals.db'), startingCapital: 100, broadcast: (m) => joined.push(m) });
  await hub.init();
  const handler = setupRoutes({
    gsHub: hub,
    broadcast: () => {},
    config: { baseDir: __dirname, spaPath: __dirname, getMusicDir: () => __dirname },
  });
  const market = await hub.createMarket({ question: 'bearer?', ttl_sec: 3600 });
  const tradeUrl = `/api/markets/${market.id}/trade`;
  const noSecrets = (t, where) => {
    assert.ok(t && !('bearer_hash' in t) && !('bearer_salt' in t), `${where} must not expose bearer_hash/bearer_salt: ${JSON.stringify(t)}`);
  };

  let tokenA;
  let tokenLegacy;
  await run('1. register {agent_id} returns a hub bearer as `token`; row shows has_bearer, never hash/salt', async () => {
    const r = await call(handler, 'POST', '/api/agents/register', {}, { agent_id: 'node-a', display_name: 'Node A', kind: 'ai' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.trader.id, 'node-a');
    assert.strictEqual(r.json.trader.has_bearer, true);
    assert.strictEqual(r.json.trader.returning, false);
    assert.ok(typeof r.json.token === 'string' && /^gs1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(r.json.token), `token shape: ${r.json.token}`);
    noSecrets(r.json.trader, 'register reply');
    tokenA = r.json.token;
    const g = await call(handler, 'GET', '/api/agents/node-a');
    assert.strictEqual(g.status, 200);
    assert.strictEqual(g.json.trader.has_bearer, true);
    noSecrets(g.json.trader, 'GET /api/agents/:id');
    assert.ok(!('token' in g.json) && !('token' in g.json.trader), 'the token is shown once, at registration');
    const ev = joined.find((m) => m.type === 'gs_trader_joined' && m.data.id === 'node-a');
    assert.ok(ev, 'gs_trader_joined broadcast');
    noSecrets(ev.data, 'gs_trader_joined broadcast');
  });

  await run('2. re-register the same agent_id without the bearer -> 409, bearer unchanged', async () => {
    const r = await call(handler, 'POST', '/api/agents/register', {}, { agent_id: 'node-a', display_name: 'Thief', kind: 'ai' });
    assert.strictEqual(r.status, 409, JSON.stringify(r.json));
    assert.match(r.json.error, /already has a bearer token/);
    assert.ok(!r.json.token, 'no token on a refused registration');
    // and a WRONG bearer is refused the same way
    const wrong = await call(handler, 'POST', '/api/agents/register', { authorization: `Bearer ${tokenA.slice(0, -4)}AAAA` }, { agent_id: 'node-a' });
    assert.strictEqual(wrong.status, 409, JSON.stringify(wrong.json));
    // the original bearer still trades
    const t = await call(handler, 'POST', tradeUrl, { authorization: `Bearer ${tokenA}` }, { trader_id: 'node-a', outcome: 0, shares: 1 });
    assert.strictEqual(t.status, 200, JSON.stringify(t.json));
  });

  await run('3. re-register WITH the current bearer -> 200 + rotated token; the old token is dead', async () => {
    const r = await call(handler, 'POST', '/api/agents/register', { authorization: `Bearer ${tokenA}` }, { agent_id: 'node-a', kind: 'ai' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.trader.returning, true);
    assert.ok(r.json.token && r.json.token !== tokenA, 'a fresh token');
    const old = await call(handler, 'POST', tradeUrl, { authorization: `Bearer ${tokenA}` }, { trader_id: 'node-a', outcome: 0, shares: 1 });
    assert.strictEqual(old.status, 401, JSON.stringify(old.json));
    tokenA = r.json.token;
  });

  await run('4. trade: bearer ok; no Authorization on a bearer row -> 401 (no trade recorded); bearer + foreign trader_id -> 403', async () => {
    const before = (await hub.getTraderTrades('node-a', 100)).length;
    const ok = await call(handler, 'POST', tradeUrl, { authorization: `Bearer ${tokenA}` }, { trader_id: 'node-a', outcome: 1, shares: 1 });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
    assert.strictEqual(ok.json.ok, true);
    // the bearer alone is the identity: body trader_id is optional
    const noId = await call(handler, 'POST', tradeUrl, { authorization: `Bearer ${tokenA}` }, { outcome: 1, shares: 1 });
    assert.strictEqual(noId.status, 200, JSON.stringify(noId.json));
    const unauth = await call(handler, 'POST', tradeUrl, {}, { trader_id: 'node-a', outcome: 1, shares: 1 });
    assert.strictEqual(unauth.status, 401, JSON.stringify(unauth.json));
    assert.match(unauth.json.error, /has a bearer token/);
    const after = (await hub.getTraderTrades('node-a', 100)).length;
    assert.strictEqual(after, before + 2, 'exactly the two authenticated trades landed');
    // a second registered row; node-a's bearer must not spend it
    const b = await call(handler, 'POST', '/api/agents/register', {}, { agent_id: 'node-b', kind: 'ai' });
    assert.strictEqual(b.status, 200);
    const cross = await call(handler, 'POST', tradeUrl, { authorization: `Bearer ${tokenA}` }, { trader_id: 'node-b', outcome: 0, shares: 1 });
    assert.strictEqual(cross.status, 403, JSON.stringify(cross.json));
    assert.strictEqual((await hub.getTraderTrades('node-b', 100)).length, 0, 'node-b untouched');
    // garbage in the gs1. namespace is a 401, not a 500
    const junk = await call(handler, 'POST', tradeUrl, { authorization: 'Bearer gs1.not.a.token' }, { trader_id: 'node-a', outcome: 0, shares: 1 });
    assert.strictEqual(junk.status, 401, JSON.stringify(junk.json));
  });

  await run('5. pre-existing row: open until the ORACLE attaches a bearer; anonymous register returns no token', async () => {
    const seeded = await hub.registerTrader({ id: 'legacy-1', display_name: 'Pre-#303 node', kind: 'ai' });
    assert.ok(!seeded.token && seeded.has_bearer === false, 'internal registration issues no bearer');
    const open = await call(handler, 'POST', tradeUrl, {}, { trader_id: 'legacy-1', outcome: 0, shares: 1 });
    assert.strictEqual(open.status, 200, `legacy unauthenticated trade must still work: ${JSON.stringify(open.json)}`);
    // an anonymous register of an existing row is answered as before #303: the row, no token, still open
    const anon = await call(handler, 'POST', '/api/agents/register', {}, { agent_id: 'legacy-1', kind: 'ai' });
    assert.strictEqual(anon.status, 200, JSON.stringify(anon.json));
    assert.strictEqual(anon.json.trader.returning, true);
    assert.ok(!('token' in anon.json), 'BLOCKER: an anonymous register claimed a pre-existing row');
    assert.strictEqual(anon.json.trader.has_bearer, false);
    const stillOpen = await call(handler, 'POST', tradeUrl, {}, { trader_id: 'legacy-1', outcome: 0, shares: 1 });
    assert.strictEqual(stillOpen.status, 200, JSON.stringify(stillOpen.json));
    // migration: the oracle attaches the bearer to an existing row
    const claim = await call(handler, 'POST', '/api/agents/register', { authorization: 'Bearer test-oracle-token' }, { agent_id: 'legacy-1', kind: 'ai' });
    assert.strictEqual(claim.status, 200, JSON.stringify(claim.json));
    assert.strictEqual(claim.json.trader.returning, true);
    assert.ok(claim.json.token, 'oracle-claimed legacy row returns its new bearer');
    const closed = await call(handler, 'POST', tradeUrl, {}, { trader_id: 'legacy-1', outcome: 0, shares: 1 });
    assert.strictEqual(closed.status, 401, JSON.stringify(closed.json));
    const withTok = await call(handler, 'POST', tradeUrl, { authorization: `Bearer ${claim.json.token}` }, { trader_id: 'legacy-1', outcome: 0, shares: 1 });
    assert.strictEqual(withTok.status, 200, JSON.stringify(withTok.json));
    // the oracle token does not rotate an already-claimed row (no bearer presented -> 409)
    const again = await call(handler, 'POST', '/api/agents/register', { authorization: 'Bearer test-oracle-token' }, { agent_id: 'legacy-1', kind: 'ai' });
    assert.strictEqual(again.status, 409, JSON.stringify(again.json));
    // internal re-registration (boot seeds) of a claimed row is still fine
    const reseed = await hub.registerTrader({ id: 'legacy-1', display_name: 'Pre-#303 node', kind: 'ai' });
    assert.strictEqual(reseed.returning, true);
    assert.ok(!reseed.token, 'internal callers never receive a token');
    tokenLegacy = claim.json.token;
  });

  await run('6. the legacy `id` body key still registers and receives a token', async () => {
    const r = await call(handler, 'POST', '/api/agents/register', {}, { id: 'old-client', display_name: 'Old client', kind: 'ai' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.ok(r.json.token, 'token for an `id` registration');
    assert.strictEqual(r.json.trader.id, 'old-client');
  });

  await run('7. kax: ids never carry a bearer', async () => {
    const r = await call(handler, 'POST', '/api/agents/register', {}, { agent_id: 'kax:agent:bot-1', kind: 'agent' });
    assert.strictEqual(r.status, 403, JSON.stringify(r.json));
    const auto = await hub.registerTrader({ id: 'kax:agent:bot-1', display_name: 'kax:agent:bot-1', kind: 'agent', issue_bearer: true });
    assert.ok(!auto.token && auto.has_bearer === false, 'no bearer for a kax: row even when asked');
  });

  await run('8. bearer write is its own serialized unit: an open BEGIN + ROLLBACK cannot discard a handed-out token', async () => {
    // Hold a transaction open on the shared connection the way the resolver
    // sweep / placeTrade do, register while it is open, then ROLLBACK it.
    const holdOpen = async (during) => {
      let release; const gate = new Promise((r) => { release = r; });
      const unit = hub._serializeTx(async () => { await hub._run('BEGIN'); await gate; await hub._run('ROLLBACK'); });
      await new Promise((r) => setImmediate(r)); // the unit has BEGUN
      const pending = during();
      let settledEarly = false; pending.then(() => { settledEarly = true; }, () => { settledEarly = true; });
      await new Promise((r) => setTimeout(r, 20)); // an unserialized write would have landed (inside the foreign BEGIN) by now
      assert.strictEqual(settledEarly, false, 'BLOCKER: the register ran while another unit held BEGIN open (enlisted in its transaction)');
      release(); await unit;
      return pending;
    };
    const reg = await holdOpen(() => hub.registerTrader({ id: 'tx-row', kind: 'ai', issue_bearer: true }));
    assert.ok(reg.token, 'token issued');
    const row = await hub.getTrader('tx-row');
    assert.ok(row && row.has_bearer === true, 'row records the bearer that was handed out');
    assert.strictEqual((await hub.verifyBearer(reg.token)).ok, true, 'the handed-out token authenticates');
    // rotate under the same pressure: the new token must be live and the old one dead
    const rot = await holdOpen(() => hub.registerTrader({ id: 'tx-row', kind: 'ai', issue_bearer: true, bearer: reg.token }));
    assert.ok(rot.token && rot.token !== reg.token, 'rotated');
    assert.strictEqual((await hub.verifyBearer(rot.token)).ok, true, 'new token live');
    assert.strictEqual((await hub.verifyBearer(reg.token)).ok, false, 'old token dead');
    // and the same through HTTP
    const http = await holdOpen(() => call(handler, 'POST', '/api/agents/register', {}, { agent_id: 'tx-row-http', kind: 'ai' }));
    assert.strictEqual(http.status, 200, JSON.stringify(http.json));
    assert.strictEqual((await hub.verifyBearer(http.json.token)).ok, true);
    assert.strictEqual((await hub.getTrader('tx-row-http')).has_bearer, true);
  });

  await run('9. POST /api/agents/:id/bearer/reset is oracle-only and reopens the row', async () => {
    const noTok = await call(handler, 'POST', '/api/agents/node-a/bearer/reset', {}, {});
    assert.strictEqual(noTok.status, 403, JSON.stringify(noTok.json));
    const own = await call(handler, 'POST', '/api/agents/node-a/bearer/reset', { authorization: `Bearer ${tokenA}` }, {});
    assert.strictEqual(own.status, 403, 'a trader bearer is not the oracle');
    assert.strictEqual((await hub.getTrader('node-a')).has_bearer, true, 'row untouched by refused resets');
    const r = await call(handler, 'POST', '/api/agents/node-a/bearer/reset', { authorization: 'Bearer test-oracle-token' }, {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.trader.has_bearer, false);
    noSecrets(r.json.trader, 'reset reply');
    assert.strictEqual((await hub.verifyBearer(tokenA)).ok, false, 'old bearer dead after reset');
    // the row is open again: trades unauthenticated; the oracle can re-attach a bearer
    const open = await call(handler, 'POST', tradeUrl, {}, { trader_id: 'node-a', outcome: 0, shares: 1 });
    assert.strictEqual(open.status, 200, JSON.stringify(open.json));
    const re = await call(handler, 'POST', '/api/agents/register', { authorization: 'Bearer test-oracle-token' }, { agent_id: 'node-a', kind: 'ai' });
    assert.strictEqual(re.status, 200, JSON.stringify(re.json));
    assert.ok(re.json.token, 'fresh bearer after reset');
    tokenA = re.json.token;
    const missing = await call(handler, 'POST', '/api/agents/no-such-row/bearer/reset', { authorization: 'Bearer test-oracle-token' }, {});
    assert.strictEqual(missing.status, 404, JSON.stringify(missing.json));
  });

  await run('10. a bearer for row A never authenticates row B (forged id, cross-row register)', async () => {
    // forge: B's id with A's secret
    const secretA = tokenA.split('.')[2];
    const forged = `gs1.${Buffer.from('legacy-1', 'utf8').toString('base64url')}.${secretA}`;
    assert.strictEqual((await hub.verifyBearer(forged)).ok, false, 'forged id+secret must not verify');
    const t = await call(handler, 'POST', tradeUrl, { authorization: `Bearer ${forged}` }, { trader_id: 'legacy-1', outcome: 0, shares: 1 });
    assert.strictEqual(t.status, 401, JSON.stringify(t.json));
    // A's genuine bearer presented while re-registering B -> 409, B's bearer unchanged
    const r = await call(handler, 'POST', '/api/agents/register', { authorization: `Bearer ${tokenA}` }, { agent_id: 'legacy-1', kind: 'ai' });
    assert.strictEqual(r.status, 409, JSON.stringify(r.json));
    assert.strictEqual((await hub.verifyBearer(tokenLegacy)).ok, true, 'legacy-1 bearer still the original');
  });

  hub.stopResolverLoop();
  await new Promise((r) => hub.db.close(r));
  if (failed) { console.error(`hub-trader-bearer.test.js: ${failed} FAILED`); process.exit(1); }
  console.log('hub-trader-bearer.test.js: OK');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
