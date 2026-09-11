'use strict';

// ghostsignals-http-validation.test.js — the /api/* GhostSignals surface in
// routes.js, driven with mock req/res against a stub hub (same harness as
// market-auth-gate.test.js). Each case failed on the pre-hardening routes:
//
//   1. an oversized JSON body is refused with 413 before the hub is called
//      (there was no cap: the body was concatenated into a string unbounded),
//   2. a body that is not a JSON object / invalid JSON is a 400, hub not called,
//   3. POST /api/agents/register refuses ids in the reserved `kax:` namespace,
//   4. a play-tier trade naming a `kax:` trader id without a token is a 401,
//      and a bearer that does not verify is a 401 on any tier (the id is
//      never taken from the body once a token is involved),
//   5. POST /api/markets refuses ttl_sec <= 0 / non-numeric at the boundary,
//   6. `limit` query params are clamped to 1..100 (negative used to reach
//      SQLite as LIMIT -1 = unbounded),
//   7. GET /api/agents/:id resolves principal ids containing ':' (URL-encoded),
//   8. a hub error carrying `.status` is passed through (413/403), others 400.

const assert = require('assert');
const { EventEmitter } = require('events');
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
        if (body != null) {
          // Deliver in 16 KB chunks so the streaming cap is exercised, not
          // just the content-length precheck.
          const buf = Buffer.from(body);
          for (let i = 0; i < buf.length && !req.destroyed; i += 16384) req.emit('data', buf.subarray(i, i + 16384));
        }
        if (!req.destroyed) req.emit('end');
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

function makeHandler(hubStub) {
  return setupRoutes({
    gsHub: hubStub,
    broadcast: () => {},
    config: { baseDir: __dirname, spaPath: __dirname, getMusicDir: () => __dirname },
  });
}

async function call(handler, method, url, headers, body) {
  const req = mockReq(method, url, headers, body);
  const res = mockRes();
  await handler(req, res);
  await res.done;
  let json = null;
  try { json = JSON.parse(res.body); } catch (_) { /* not json */ }
  return { status: res.statusCode, json, req };
}

let failed = 0;
async function run(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}: ${e.stack || e.message}`); failed++; }
}

async function main() {
  console.log('ghostsignals-http-validation.test.js');

  await run('1  an oversized JSON body is 413 and never reaches the hub', async () => {
    let created = 0;
    const handler = makeHandler({ createMarket: async () => { created++; return {}; } });
    const big = JSON.stringify({ question: 'x'.repeat(200 * 1024), ttl_sec: 60 });
    // Streaming cap (no content-length header).
    const r1 = await call(handler, 'POST', '/api/markets', {}, big);
    assert.strictEqual(r1.status, 413, `streamed oversize should be 413, got ${r1.status}`);
    assert.ok(r1.req.destroyed, 'the socket is destroyed rather than drained');
    // Declared cap (content-length precheck).
    const r2 = await call(handler, 'POST', '/api/markets', { 'content-length': String(10 * 1024 * 1024) }, '{}');
    assert.strictEqual(r2.status, 413);
    assert.strictEqual(created, 0, 'hub.createMarket was called with an oversized body');
    // A normal body still goes through.
    const r3 = await call(handler, 'POST', '/api/markets', {}, JSON.stringify({ question: 'ok', ttl_sec: 60 }));
    assert.strictEqual(r3.status, 200);
    assert.strictEqual(created, 1);
  });

  await run('2  invalid JSON / non-object bodies are 400, hub not called', async () => {
    let created = 0;
    const handler = makeHandler({ createMarket: async () => { created++; return {}; } });
    for (const body of ['{not json', '[1,2]', '"str"', 'null', '42']) {
      const r = await call(handler, 'POST', '/api/markets', {}, body);
      assert.strictEqual(r.status, 400, `body ${body} should be 400, got ${r.status}`);
      assert.ok(r.json && r.json.ok === false && /JSON|object/i.test(r.json.error), `error names the problem: ${r.json && r.json.error}`);
    }
    assert.strictEqual(created, 0);
  });

  await run('3  POST /api/agents/register refuses the reserved kax: namespace', async () => {
    let registered = [];
    const handler = makeHandler({ registerTrader: async (b) => { registered.push(b.id); return { id: b.id }; } });
    for (const id of ['kax:agent:victim-bot', 'KAX:user:42', 'kax:service:x']) {
      const r = await call(handler, 'POST', '/api/agents/register', {}, JSON.stringify({ id, display_name: 'Impostor' }));
      assert.strictEqual(r.status, 403, `${id} should be 403, got ${r.status}`);
    }
    assert.deepStrictEqual(registered, [], 'hub.registerTrader was reached with a kax: id');
    const ok = await call(handler, 'POST', '/api/agents/register', {}, JSON.stringify({ id: 'plain-player', display_name: 'P' }));
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(registered, ['plain-player']);
  });

  await run('4  a kax: trader id in a play-tier body needs a token; an unverifiable bearer is 401 on any tier', async () => {
    let traded = [];
    const handler = makeHandler({
      getMarket: async () => ({ id: 'm_play', tag: 'custom', source: 'system', outcomes: ['Yes', 'No'] }),
      placeTrade: async (a) => { traded.push(a.trader_id); return { cost: 1, prices: [0.5, 0.5] }; },
      registerTrader: async () => ({}),
      getTrader: async () => null, // #303: unauthenticated trade consults the row
    });
    const r1 = await call(handler, 'POST', '/api/markets/m_play/trade', {}, JSON.stringify({ trader_id: 'kax:agent:victim', outcome: 0, shares: 1 }));
    assert.strictEqual(r1.status, 401, `kax: id without token should be 401, got ${r1.status}`);
    // A bearer that cannot be verified (garbage token) must not fall back to the body id.
    const r2 = await call(handler, 'POST', '/api/markets/m_play/trade', { authorization: 'Bearer not.a.jwt' }, JSON.stringify({ trader_id: 'anon', outcome: 0, shares: 1 }));
    assert.strictEqual(r2.status, 401, `bad bearer on play tier should be 401, got ${r2.status}`);
    assert.deepStrictEqual(traded, [], 'hub.placeTrade reached with an unbound identity');
    // Plain anonymous play trade unchanged.
    const r3 = await call(handler, 'POST', '/api/markets/m_play/trade', {}, JSON.stringify({ trader_id: 'anon', outcome: 0, shares: 1 }));
    assert.strictEqual(r3.status, 200);
    assert.deepStrictEqual(traded, ['anon']);
  });

  await run('5  POST /api/markets refuses ttl_sec <= 0 / non-numeric at the boundary', async () => {
    let seen = [];
    const handler = makeHandler({ createMarket: async (b) => { seen.push(b.ttl_sec); return {}; } });
    for (const ttl of [0, -10, 'abc', '60', null]) {
      const r = await call(handler, 'POST', '/api/markets', {}, JSON.stringify({ question: 'q', ttl_sec: ttl }));
      assert.strictEqual(r.status, 400, `ttl_sec=${JSON.stringify(ttl)} should be 400, got ${r.status}`);
      assert.ok(/ttl_sec/.test(r.json.error));
    }
    assert.deepStrictEqual(seen, []);
    const ok = await call(handler, 'POST', '/api/markets', {}, JSON.stringify({ question: 'q', ttl_sec: 60 }));
    assert.strictEqual(ok.status, 200);
    // Omitted ttl_sec keeps the hub default.
    await call(handler, 'POST', '/api/markets', {}, JSON.stringify({ question: 'q' }));
    assert.deepStrictEqual(seen, [60, undefined]);
  });

  await run('6  limit query params are clamped to 1..100 on markets / leaderboard / trades', async () => {
    const seen = {};
    const handler = makeHandler({
      listMarkets: async (a) => { seen.markets = a.limit; return []; },
      leaderboard: async (a) => { seen.leaderboard = a.limit; return []; },
      getTraderTrades: async (_id, limit) => { seen.trades = limit; return []; },
    });
    await call(handler, 'GET', '/api/markets?limit=-1');
    await call(handler, 'GET', '/api/leaderboard?limit=-5');
    await call(handler, 'GET', '/api/agents/x/trades?limit=0');
    assert.deepStrictEqual(seen, { markets: 1, leaderboard: 1, trades: 25 }, `negative/zero limits reached the hub: ${JSON.stringify(seen)}`);
    await call(handler, 'GET', '/api/markets?limit=5000');
    await call(handler, 'GET', '/api/leaderboard?limit=abc');
    assert.strictEqual(seen.markets, 100);
    assert.strictEqual(seen.leaderboard, 20);
  });

  await run('7  GET /api/agents/:id resolves a URL-encoded principal id', async () => {
    let asked = null;
    const handler = makeHandler({ getTrader: async (id) => { asked = id; return { id }; } });
    const r = await call(handler, 'GET', '/api/agents/kax%3Aagent%3Asome-bot');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(asked, 'kax:agent:some-bot');
    const r404 = await call(makeHandler({ getTrader: async () => null }), 'GET', '/api/agents/nobody');
    assert.strictEqual(r404.status, 404);
  });

  await run('8  hub errors: 400 by default, `.status` honoured (never a leaked 500 for a bad input)', async () => {
    const handler = makeHandler({
      getMarket: async () => ({ id: 'm_play', tag: 'custom', source: 'system', outcomes: ['Yes', 'No'] }),
      placeTrade: async () => { throw new Error('shares must be positive'); },
      registerTrader: async () => ({}),
      getTrader: async () => null, // #303: unauthenticated trade consults the row
      resolveMarket: async () => { throw Object.assign(new Error('nope'), { status: 409 }); },
    });
    const r = await call(handler, 'POST', '/api/markets/m_play/trade', {}, JSON.stringify({ trader_id: 'a', outcome: 0, shares: -1 }));
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error, 'shares must be positive');
    const r2 = await call(handler, 'POST', '/api/markets/m_play/resolve', { authorization: 'Bearer test-oracle-token' }, JSON.stringify({ winning_outcome: 0 }));
    assert.strictEqual(r2.status, 409);
  });

  if (failed) { console.error(`\n${failed} http-validation test(s) FAILED`); process.exitCode = 1; }
  else console.log('\nAll ghostsignals-http-validation tests passed');
}

main().then(() => process.exit(process.exitCode || 0)).catch((e) => { console.error(e); process.exit(1); });
