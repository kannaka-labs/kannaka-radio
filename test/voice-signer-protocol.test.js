"use strict";
/**
 * voice-signer-protocol.test.js — the request gate of the O2 Nostr voice signer
 * (ops/voice-signer/protocol.js, ADR-0043). This is the only thing between the bus
 * and Kannaka's voice key, so each rule is pinned: the two HMAC versions are not
 * interchangeable, a long-form article's tags are authenticated, only kinds 1 and
 * 30023 are signed, and stale or replayed requests are refused.
 */
const assert = require("assert");
const crypto = require("crypto");
const P = require("../ops/voice-signer/protocol");

let failed = 0;
function run(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e && e.message}`); failed++; }
}
console.log("voice-signer-protocol.test.js");

const SECRET = "test-secret-" + crypto.randomBytes(8).toString("hex");
const T0 = 1_790_000_000_000;
const gate = () => P.createGate({ secret: SECRET, now: () => T0 });
let n = 0;
const nonce = () => "n" + (n++);

function v1(content, tags = [], extra = {}) {
  const ts = T0, no = nonce();
  return JSON.stringify({ content, tags, ts, nonce: no, hmac: P.expectedHmac(SECRET, ts, no, content), ...extra });
}
function v2(content, tags, kind = P.LONGFORM_KIND, extra = {}) {
  const ts = T0, no = nonce();
  return JSON.stringify({ kind, content, tags, ts, nonce: no, hmac: P.expectedHmacV2(SECRET, ts, no, kind, content, tags), ...extra });
}
const ART_TAGS = [["d", "slug"], ["title", "A Title"], ["t", "ai"]];

run("kind 1 with a v1 HMAC is signed, and malformed tags are dropped", () => {
  const r = gate().check(v1("hello", [["t", "ai"], ["bad", 3]]));
  assert.strictEqual(r.ok, true); assert.strictEqual(r.kind, 1);
  assert.deepStrictEqual(r.tags, [["t", "ai"]]);
});

run("kind 1 refuses a v2 HMAC (the versions are not interchangeable)", () => {
  const ts = T0, no = nonce(), c = "hello";
  const req = JSON.stringify({ content: c, tags: [], ts, nonce: no, hmac: P.expectedHmacV2(SECRET, ts, no, 1, c, []) });
  assert.strictEqual(gate().check(req).error, "bad_hmac");
});

run("a long-form article with a v2 HMAC is signed with its tags exactly as sent", () => {
  const r = gate().check(v2("# Body", ART_TAGS));
  assert.strictEqual(r.ok, true); assert.strictEqual(r.kind, 30023);
  assert.deepStrictEqual(r.tags, ART_TAGS);
});

run("a long-form article with a v1 HMAC is refused", () => {
  const ts = T0, no = nonce(), c = "# Body";
  const req = JSON.stringify({ kind: 30023, content: c, tags: ART_TAGS, ts, nonce: no, hmac: P.expectedHmac(SECRET, ts, no, c) });
  assert.strictEqual(gate().check(req).error, "bad_hmac");
});

run("re-titling a long-form article after it was authorised is refused", () => {
  const req = JSON.parse(v2("# Body", ART_TAGS));
  req.tags = [["d", "slug"], ["title", "Someone Else's Title"], ["t", "ai"]];
  assert.strictEqual(gate().check(JSON.stringify(req)).error, "bad_hmac");
});

run("changing the kind after it was authorised is refused", () => {
  const req = JSON.parse(v2("# Body", ART_TAGS));
  req.kind = 1;
  assert.strictEqual(gate().check(JSON.stringify(req)).error, "bad_hmac");
});

run("a long-form article needs both d and title", () => {
  assert.strictEqual(gate().check(v2("# Body", [["d", "slug"]])).error, "longform_needs_d_and_title");
  assert.strictEqual(gate().check(v2("# Body", [["title", "T"]])).error, "longform_needs_d_and_title");
});

run("malformed long-form tags are refused, not filtered", () => {
  assert.strictEqual(gate().check(v2("# Body", [["d", "slug"], ["title", "T"], ["x"]])).error, "bad_tags");
});

run("only kinds 1 and 30023 are signed", () => {
  assert.strictEqual(gate().check(v2("x", ART_TAGS, 4)).error, "unsupported_kind");
  assert.strictEqual(gate().check(v2("x", ART_TAGS, 0)).error, "unsupported_kind");
});

run("a stale request is refused", () => {
  const g = P.createGate({ secret: SECRET, now: () => T0 + P.FRESHNESS_MS + 1 });
  assert.strictEqual(g.check(v1("hello")).error, "stale");
});

run("a replayed nonce is refused the second time", () => {
  const g = gate(), req = v1("hello");
  assert.strictEqual(g.check(req).ok, true);
  assert.strictEqual(g.check(req).error, "replay");
});

run("an oversized article is refused", () => {
  const big = "x".repeat(P.LONGFORM_MAX_BYTES + 1);
  assert.strictEqual(gate().check(v2(big, ART_TAGS)).error, "too_long");
});

run("bad JSON, empty content and missing auth fields are refused", () => {
  assert.strictEqual(gate().check("{").error, "bad_json");
  assert.strictEqual(gate().check(v1("")).error, "no_content");
  assert.strictEqual(gate().check(JSON.stringify({ content: "x" })).error, "missing_auth_fields");
});

run("the wrong secret is refused", () => {
  const other = P.createGate({ secret: "not-the-secret", now: () => T0 });
  assert.strictEqual(other.check(v1("hello")).error, "bad_hmac");
});

if (failed) { console.error(`voice-signer-protocol: ${failed} failed`); process.exit(1); }
console.log("  all passing");
