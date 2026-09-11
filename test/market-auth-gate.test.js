'use strict';

// ADR-0041 Phase-0 regression: the oracle-token gate on the hub HTTP surface.
// Drives the REAL routes.js handleRequest with mock req/res so a future edit
// that removes or weakens the gate is caught in CI — not just verified by a
// one-off live curl.
//
//   POST /api/markets/:id/resolve      no/ wrong token -> 403, hub NOT called
//   POST /api/markets/:id/resolve      correct token   -> reaches the hub
//   POST /api/markets (tag=labs)       no token        -> 403, hub NOT called

const assert = require('assert');
const { EventEmitter } = require('events');
const setupRoutes = require('../server/routes');

process.env.GSHUB_ORACLE_TOKEN = 'test-oracle-token';

function mockReq(method, url, headers, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = Object.assign({ host: 'localhost' }, headers || {});
  const origOn = req.on.bind(req);
  // Emit the body once a consumer attaches its 'end' listener, so it survives
  // any awaits before readJson() subscribes.
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
  const res = {};
  res.statusCode = null;
  res.body = '';
  res.headers = null;
  res._resolve = null;
  res.done = new Promise((r) => { res._resolve = r; });
  res.writeHead = (code, hdrs) => { res.statusCode = code; res.headers = hdrs; };
  res.end = (data) => { if (data) res.body += data; res._resolve(); };
  return res;
}

function makeHandler(hubStub) {
  const deps = {
    gsHub: hubStub,
    broadcast: () => {},
    config: { baseDir: __dirname, spaPath: __dirname, getMusicDir: () => __dirname },
  };
  return setupRoutes(deps);
}

async function main() {
  // 1. resolve without a token -> 403, hub.resolveMarket never called.
  {
    let called = false;
    const handler = makeHandler({ resolveMarket: async () => { called = true; return {}; } });
    const req = mockReq('POST', '/api/markets/m_x/resolve', {}, JSON.stringify({ winning_outcome: 0 }));
    const res = mockRes();
    await handler(req, res); await res.done;
    assert.strictEqual(res.statusCode, 403, `no-token resolve should be 403, got ${res.statusCode}`);
    assert.strictEqual(called, false, 'BLOCKER: hub.resolveMarket was reached without a token');
  }

  // 2. resolve with the WRONG token -> 403.
  {
    let called = false;
    const handler = makeHandler({ resolveMarket: async () => { called = true; return {}; } });
    const req = mockReq('POST', '/api/markets/m_x/resolve', { authorization: 'Bearer nope' }, JSON.stringify({ winning_outcome: 0 }));
    const res = mockRes();
    await handler(req, res); await res.done;
    assert.strictEqual(res.statusCode, 403, `wrong-token resolve should be 403, got ${res.statusCode}`);
    assert.strictEqual(called, false, 'BLOCKER: hub.resolveMarket reached with a wrong token');
  }

  // 3. resolve WITH the correct token -> reaches the hub, 200.
  {
    let called = false;
    const handler = makeHandler({ resolveMarket: async () => { called = true; return { id: 'm_x', resolved: true }; } });
    const req = mockReq('POST', '/api/markets/m_x/resolve', { authorization: 'Bearer test-oracle-token' }, JSON.stringify({ winning_outcome: 0 }));
    const res = mockRes();
    await handler(req, res); await res.done;
    assert.strictEqual(called, true, 'correct-token resolve must reach the hub');
    assert.strictEqual(res.statusCode, 200, `correct-token resolve should be 200, got ${res.statusCode}`);
  }

  // 4. labs-tier market creation without a token -> 403, hub.createMarket never called.
  {
    let called = false;
    const handler = makeHandler({ createMarket: async () => { called = true; return {}; } });
    const req = mockReq('POST', '/api/markets', {}, JSON.stringify({ question: 'x', tag: 'labs', ttl_sec: 60 }));
    const res = mockRes();
    await handler(req, res); await res.done;
    assert.strictEqual(res.statusCode, 403, `no-token labs create should be 403, got ${res.statusCode}`);
    assert.strictEqual(called, false, 'BLOCKER: labs market created without a token');
  }

  // 5. labs-tier TRADE without a KAX token -> 401, placeTrade never called.
  //    (verifyKaxToken short-circuits on a missing bearer — no network needed.)
  {
    let traded = false;
    const handler = makeHandler({
      getMarket: async () => ({ id: 'm_labs', tag: 'labs', source: 'kannaka-labs', outcomes: ['Yes', 'No'] }),
      placeTrade: async () => { traded = true; return { cost: 1 }; },
      registerTrader: async () => ({}),
    });
    const req = mockReq('POST', '/api/markets/m_labs/trade', {}, JSON.stringify({ trader_id: 'sybil', outcome: 0, shares: 5 }));
    const res = mockRes();
    await handler(req, res); await res.done;
    assert.strictEqual(res.statusCode, 401, `no-token labs trade should be 401, got ${res.statusCode}`);
    assert.strictEqual(traded, false, 'BLOCKER: labs-tier trade placed without a KAX identity');
  }

  // 6. play-tier TRADE without a token -> unchanged: reaches the hub with the
  //    body-supplied trader id (open play tier is intentionally anonymous).
  {
    let seenTraderId = null;
    const handler = makeHandler({
      getMarket: async () => ({ id: 'm_play', tag: 'custom', source: 'system', outcomes: ['Yes', 'No'] }),
      placeTrade: async (args) => { seenTraderId = args.trader_id; return { cost: 1, prices: [0.5, 0.5] }; },
      registerTrader: async () => ({}),
      // #303: an unauthenticated trade looks the row up; a row with no bearer
      // (or no row yet) keeps the open path.
      getTrader: async () => null,
    });
    const req = mockReq('POST', '/api/markets/m_play/trade', {}, JSON.stringify({ trader_id: 'anon-player', outcome: 0, shares: 5 }));
    const res = mockRes();
    await handler(req, res); await res.done;
    assert.strictEqual(res.statusCode, 200, `play-tier trade should be 200, got ${res.statusCode}`);
    assert.strictEqual(seenTraderId, 'anon-player', 'play-tier trade must keep its anonymous body trader id');
  }

  console.log('market-auth-gate.test.js: OK (capless resolve/labs-create/labs-trade denied; play trade open; oracle token reaches the hub)');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
