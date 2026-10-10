'use strict';

// utf8-chunk-split.test.js — a multibyte UTF-8 character split across two
// network chunks must arrive intact, in the NATS client and in the GhostSignals
// readJson body reader.
//
// Both decoded each chunk on its own (`data.toString()`, `body += c`), which
// turns the two halves of a split character into U+FFFD. In the NATS client
// that also changes the text's byte length, and the parser frames MSG bodies
// by byte count — so the body is cut wrong and the message after it is lost.

const assert = require('assert');
const http = require('http');
const net = require('net');
const { NATSClient } = require('../server/nats-client');
const setupRoutes = require('../server/routes');

let failures = 0;
process.exitCode = 1;
async function check(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e && e.message}`); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const noop = () => {};

(async () => {
  console.log('\nutf8-chunk-split.test.js');

  await check('NATS: a MSG body split inside a multibyte char is delivered intact, and framing survives', async () => {
    const sockets = [];
    const server = net.createServer((sock) => {
      sockets.push(sock);
      sock.setNoDelay(true);
      sock.on('error', noop);
      const p1 = '{"text":"Kannaka — ❤ radio"}';
      const p2 = '{"next":"ok"}';
      const frame = Buffer.concat([
        Buffer.from(`MSG T.one 1 ${Buffer.byteLength(p1)}\r\n`),
        Buffer.from(p1 + '\r\n'),
        Buffer.from(`MSG T.two 2 ${Buffer.byteLength(p2)}\r\n${p2}\r\n`),
      ]);
      const cut = frame.indexOf(0xe2) + 1; // inside the em dash (E2 80 94)
      sock.write(frame.slice(0, cut));
      setTimeout(() => sock.write(frame.slice(cut)), 80);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const orig = net.createConnection;
    net.createConnection = (opts, cb) => orig.call(net, { host: '127.0.0.1', port }, cb);
    const c = new NATSClient({ broadcast: noop });
    const got = [];
    c._handleMessage = (subject, body) => got.push([subject, body]);
    try {
      c.connect();
      await wait(400);
    } finally {
      net.createConnection = orig;
      c.disconnect();
      for (const s of sockets) { try { s.destroy(); } catch {} }
      server.close();
      server.unref();
    }
    assert.strictEqual(got.length, 2, `both messages must be delivered, got ${JSON.stringify(got)}`);
    assert.strictEqual(got[0][1], '{"text":"Kannaka — ❤ radio"}');
    assert.ok(!got[0][1].includes('�'), 'no replacement characters');
    assert.deepStrictEqual(got[1], ['T.two', '{"next":"ok"}']);
  });

  await check('readJson: a JSON body split inside a multibyte char round-trips', async () => {
    const seen = [];
    const gsHub = {
      isReady: () => true,
      registerTrader: async (t) => { seen.push(t.display_name); return { id: t.id, display_name: t.display_name }; },
    };
    const handler = setupRoutes({
      djEngine: { state: {}, getCurrentTrack: () => null },
      perception: {}, nats: { connected: false, publish: noop }, flux: {}, live: { isLive: () => false },
      voiceDJ: {}, syncManager: {}, voteManager: {}, webrtcSignaling: {}, musicGen: null,
      broadcast: noop, floor: {}, config: { spaPath: __dirname, getMusicDir: () => '/tmp/m' }, gsHub,
    });
    const server = http.createServer(handler);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const name = 'Ghost — Signals ❤';
    const body = Buffer.from(JSON.stringify({ agent_id: 'utf8-test-agent', display_name: name }), 'utf8');
    const cut = body.indexOf(0xe2) + 1;
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/agents/register', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': body.length } }, (r) => {
        const chunks = [];
        r.on('data', (d) => chunks.push(d));
        r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.setNoDelay(true);
      req.write(body.slice(0, cut));
      setTimeout(() => req.end(body.slice(cut)), 80);
    });
    server.close();
    assert.strictEqual(res.status, 200, `${res.status} ${res.body.slice(0, 160)}`);
    assert.deepStrictEqual(seen, [name], `display_name reached the hub as ${JSON.stringify(seen)}`);
  });

  if (failures) { console.error(`\nutf8-chunk-split: ${failures} failing`); process.exitCode = 1; return; }
  console.log('\nutf8-chunk-split: all passed');
  process.exitCode = 0;
})();
