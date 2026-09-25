"use strict";
/**
 * protocol.js — the voice signer's request gate, dependency-free so CI can test it.
 *
 * A sign request is JSON: { content, tags?, ts, nonce, hmac, kind? }.
 *   kind 1 (default)  — notes, the radio's path. HMAC v1 = HMAC(secret, `${ts}:${nonce}:${sha256(content)}`).
 *                       Tags are NOT authenticated in v1, so only well-formed string-array tags pass.
 *   kind 30023        — NIP-23 long-form. HMAC v2 = HMAC(secret,
 *                       `v2:${ts}:${nonce}:${kind}:${sha256(content)}:${sha256(JSON.stringify(tags))}`),
 *                       so a bus writer cannot re-title or re-address an article. Tags must be well formed
 *                       and include `d` and `title`; content is capped at LONGFORM_MAX_BYTES.
 *   any other kind    — refused.
 * Every request: ±FRESHNESS_MS clock window, and a nonce is accepted once.
 */
const crypto = require("crypto");

const FRESHNESS_MS = 120_000;
const LONGFORM_KIND = 30023;
const LONGFORM_MAX_BYTES = 60_000;

function sha256hex(s) { return crypto.createHash("sha256").update(s).digest("hex"); }

function expectedHmac(secret, ts, nonce, content) {
  return crypto.createHmac("sha256", secret).update(`${ts}:${nonce}:${sha256hex(content)}`).digest("hex");
}

function expectedHmacV2(secret, ts, nonce, kind, content, tags) {
  return crypto.createHmac("sha256", secret)
    .update(`v2:${ts}:${nonce}:${kind}:${sha256hex(content)}:${sha256hex(JSON.stringify(tags))}`).digest("hex");
}

function timingEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** A stateful gate (it remembers nonces). `now` is injectable for tests. */
function createGate({ secret, now = () => Date.now() }) {
  if (!secret) throw new Error("no signer secret");
  const seenNonces = new Map(); // nonce -> expiry ts

  function pruneNonces(t) {
    for (const [n, exp] of seenNonces) if (exp < t) seenNonces.delete(n);
  }

  /** Returns { ok: true, kind, tags, content } to sign, or { ok: false, error }. */
  function check(reqStr) {
    let req;
    try { req = JSON.parse(reqStr); } catch { return { ok: false, error: "bad_json" }; }
    const { content, tags = [], ts, nonce, hmac } = req;
    const kind = req.kind === undefined ? 1 : req.kind;
    if (kind !== 1 && kind !== LONGFORM_KIND) return { ok: false, error: "unsupported_kind" };
    if (typeof content !== "string" || !content) return { ok: false, error: "no_content" };
    if (typeof ts !== "number" || typeof nonce !== "string" || typeof hmac !== "string") {
      return { ok: false, error: "missing_auth_fields" };
    }
    const t = now();
    if (Math.abs(t - ts) > FRESHNESS_MS) return { ok: false, error: "stale" };
    const want = kind === 1 ? expectedHmac(secret, ts, nonce, content) : expectedHmacV2(secret, ts, nonce, kind, content, tags);
    if (!timingEq(hmac, want)) return { ok: false, error: "bad_hmac" };
    pruneNonces(t);
    if (seenNonces.has(nonce)) return { ok: false, error: "replay" };
    seenNonces.set(nonce, t + FRESHNESS_MS);

    if (kind === 1) {
      const safeTags = Array.isArray(tags) ? tags.filter((x) => Array.isArray(x) && x.every((y) => typeof y === "string")) : [];
      return { ok: true, kind: 1, tags: safeTags, content };
    }
    // Long-form: the tags are HMAC-covered, so they are signed exactly as sent, but only if well formed.
    if (!Array.isArray(tags) || !tags.every((x) => Array.isArray(x) && x.length >= 2 && x.every((y) => typeof y === "string"))) {
      return { ok: false, error: "bad_tags" };
    }
    if (!tags.some((x) => x[0] === "d" && x[1]) || !tags.some((x) => x[0] === "title" && x[1])) {
      return { ok: false, error: "longform_needs_d_and_title" };
    }
    if (Buffer.byteLength(content, "utf8") > LONGFORM_MAX_BYTES) return { ok: false, error: "too_long" };
    return { ok: true, kind, tags, content };
  }

  return { check };
}

module.exports = { createGate, expectedHmac, expectedHmacV2, FRESHNESS_MS, LONGFORM_KIND, LONGFORM_MAX_BYTES };
