'use strict';
/**
 * consciousness-subject.test.js — a consciousness reading carries whose it is.
 *
 * `KANNAKA.consciousness` is ONE subject that every node on the bus publishes
 * to, last writer wins. The binary stamps `agent_id` on every payload
 * (build_consciousness_payload, kannaka-memory), but this client rebuilt the
 * state object field by field and dropped it.
 *
 * The observatory reads that object back out of /api/state and serves it as
 * /api/hrm/status, so on 2026-09-13 it reported phi 0.343 — skywave's — as
 * Kannaka's, and a prediction market had already settled a claim about
 * "Kannaka phi" against that endpoint. A number with no subject attached is
 * worse than no number: it is indistinguishable from the right one.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { NATSClient } = require('../server/nats-client');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

/** A client with no connection, driven straight at its message handler. */
function client() {
  const c = Object.create(NATSClient.prototype);
  c.swarmState = {
    queen: { phi: 0, agentCount: 0 },
    consciousness: {
      agent_id: null, phi: 0, xi: 0, order: 0, mean_order: 0,
      num_clusters: 0, clusters: 0, active: 0, total: 0,
      level: 'dormant', consciousness_level: 'dormant',
      irrationality: 0, hemispheric_divergence: 0, callosal_efficiency: 0,
      consciousnessSource: null, source: null, timestamp: null,
    },
    agents: {}, dreams: [], agentEvents: [],
  };
  c._broadcast = () => {};
  c.emit = () => {};
  return c;
}

/**
 * The wire contract for KANNAKA.consciousness requires schema_version, ts,
 * agent_id and phi (NATS_REQUIRED_FIELDS), and strict mode — on unless
 * KANNAKA_SCHEMA_STRICT=off — DROPS a payload that is missing one. So every
 * fixture here is contract-complete; a payload without agent_id never reaches
 * the rebuild in production at all.
 */
function payload(extra) {
  return Object.assign({
    schema_version: 1,
    ts: Date.now(),
    agent_id: 'kannaka-prime',
    phi: 0.5,
    xi: 0.05,
    order: 0.2,
    consciousness_level: 'aware',
    source: 'binary',
  }, extra);
}

function deliver(c, extra) {
  c._handleMessage('KANNAKA.consciousness', JSON.stringify(payload(extra)));
  return c.swarmState.consciousness;
}

console.log('consciousness-subject');

test('a reading keeps the agent_id the publisher stamped', () => {
  const c = client();
  const out = deliver(c, { agent_id: 'kannaka-prime', phi: 0.628, total_memories: 1127 });
  assert.strictEqual(out.agent_id, 'kannaka-prime', 'the subject must survive the rebuild');
  assert.strictEqual(out.phi, 0.628);
});

test('another node\u2019s reading is labelled as that node\u2019s', () => {
  const c = client();
  const out = deliver(c, { agent_id: 'skywave', phi: 0.343 });
  assert.strictEqual(out.agent_id, 'skywave',
    'the radio may hold it, but it must not lose track of whose it is');
  assert.strictEqual(out.phi, 0.343);
});

test('the subject changes when the publisher changes', () => {
  const c = client();
  deliver(c, { agent_id: 'skywave', phi: 0.343 });
  const out = deliver(c, { agent_id: 'kannaka-prime', phi: 0.628 });
  assert.strictEqual(out.agent_id, 'kannaka-prime');
  assert.strictEqual(out.phi, 0.628);
});

test('the production initial state declares the field', () => {
  // Asserted against the SOURCE, not against this file's own fixture: a test
  // that builds swarmState by hand and then checks its own handiwork proves
  // nothing about what the constructor actually creates.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'nats-client.js'), 'utf8');
  const block = src.slice(src.indexOf('consciousness: {'), src.indexOf('dreams: []'));
  assert.match(block, /agent_id:\s*null/,
    'a consumer must find the field declared, not undefined, before any payload');
});

test('the contract requires agent_id, so an anonymous reading is dropped', () => {
  const c = client();
  const anon = payload({});
  delete anon.agent_id;
  c._handleMessage('KANNAKA.consciousness', JSON.stringify(anon));
  assert.strictEqual(c.swarmState.consciousness.phi, 0,
    'strict mode must drop a payload that names nobody, not absorb it');
  assert.strictEqual(c.swarmState.consciousness.agent_id, null);
});

test('with strict mode off, an unattributed reading does not inherit a name', () => {
  const prev = process.env.KANNAKA_SCHEMA_STRICT;
  process.env.KANNAKA_SCHEMA_STRICT = 'off';
  try {
    const c = client();
    deliver(c, { agent_id: 'skywave', phi: 0.343 });
    const anon = payload({ phi: 0.9 });
    delete anon.agent_id;
    c._handleMessage('KANNAKA.consciousness', JSON.stringify(anon));
    assert.strictEqual(c.swarmState.consciousness.agent_id, null,
      'inheriting would stamp skywave on a reading that never claimed it');
  } finally {
    if (prev === undefined) delete process.env.KANNAKA_SCHEMA_STRICT;
    else process.env.KANNAKA_SCHEMA_STRICT = prev;
  }
});


test('another node cannot set the queen phi, but can set the swarm order', () => {
  // phi is PER-AGENT — Kannaka's is not skywave's — so a neighbour must not
  // set it. The Kuramoto order parameter is a property of the SWARM: every
  // node reads the same system, so a canonical packet still sets it (#219).
  const c = client();
  c.selfAgentId = 'kannaka-prime';
  c.swarmState.queen.phi = 0.628;
  deliver(c, { agent_id: 'skywave', phi: 0.343, order: 0.91 });
  assert.strictEqual(c.swarmState.queen.phi, 0.628,
    'rejecting a neighbour at one tier is not rejecting it if the next tier takes it');
  assert.strictEqual(c.swarmState.queen.orderParameter, 0.91,
    'the swarm order is not per-agent and must keep flowing');
});

test('the queen view still follows our own reading', () => {
  const c = client();
  c.selfAgentId = 'kannaka-prime';
  deliver(c, { agent_id: 'kannaka-prime', phi: 0.77, order: 0.31 });
  assert.strictEqual(c.swarmState.queen.phi, 0.77);
  assert.strictEqual(c.swarmState.queen.orderParameter, 0.31);
});

if (failures) { console.error(`consciousness-subject: ${failures} failed`); process.exit(1); }
console.log('consciousness-subject: all passed');
