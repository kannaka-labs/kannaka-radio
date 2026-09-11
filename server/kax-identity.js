'use strict';

/**
 * kax-identity.js — verify KAX-issued identity tokens (ADR-0041 Phase 1).
 *
 * KAX is the constellation identity provider; it signs short-lived EdDSA
 * tokens and publishes its public keys at a JWKS URL. The hub verifies those
 * tokens LOCALLY against the fetched JWKS — no per-request call back to KAX.
 *
 * Hardening (matches KAX's own verifier, per the ADR-0041 review):
 *  - algorithm pinned to EdDSA (rejects alg=none and HMAC-with-public-key
 *    confusion — jose never treats an asymmetric key as an HMAC secret),
 *  - issuer required, exp/iat/sub/kind required, small clock tolerance,
 *  - key selected by kid from the remote JWKS (cached; refetched on an unknown
 *    kid with a cooldown so a rotation is picked up without hammering KAX),
 *  - FAIL-CLOSED: if the JWKS can't be fetched, verification throws and the
 *    caller denies — a KAX/JWKS outage never silently admits an unverified
 *    trader.
 *
 * jose is ESM-only (v6); loaded via dynamic import() so this stays a plain
 * CommonJS module regardless of the Node version on the host.
 */

const KAX_JWKS_URL = process.env.KAX_JWKS_URL || "https://kax.ninja-portal.com/api/auth/jwks.json";
const KAX_ISSUER = process.env.KAX_IDENTITY_ISSUER || "https://kax.ninja-portal.com";
const IDENTITY_ALG = "EdDSA";

let _jwks = null;
async function getJwks() {
  const { createRemoteJWKSet } = await import("jose");
  if (!_jwks) {
    _jwks = createRemoteJWKSet(new URL(KAX_JWKS_URL), {
      cooldownDuration: 30_000, // min gap between refetches on an unknown kid
      timeoutDuration: 8_000,
    });
  }
  return _jwks;
}

/** Reset the cached JWKS — for tests that point KAX_JWKS_URL at a fixture. */
function _resetJwksCache() {
  _jwks = null;
}

function bearer(authHeader) {
  if (typeof authHeader !== "string") return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * Pass revocation hook (#303). A `kind = "pass"` token is minted by
 * ninja-portal for a paid pass; the pass can be cancelled before the token
 * expires. ninja-portal does not yet expose a revocation check, so this
 * returns false (nothing revoked) — swap the implementation via
 * setPassRevocationCheck() once that endpoint exists. Called on every
 * verified pass token, so a check must be cheap or cached.
 */
let passRevocationCheck = async (_claims) => false;
function setPassRevocationCheck(fn) {
  passRevocationCheck = typeof fn === "function" ? fn : async () => false;
}

/**
 * Verify an Authorization header carrying a KAX token.
 * Returns { ok:true, claims } or { ok:false, error }. Never throws.
 */
async function verifyKaxToken(authHeader) {
  const token = bearer(authHeader);
  if (!token) return { ok: false, error: "missing bearer token" };
  try {
    const { jwtVerify } = await import("jose");
    const jwks = await getJwks();
    const { payload } = await jwtVerify(token, jwks, {
      issuer: KAX_ISSUER,
      algorithms: [IDENTITY_ALG],
      requiredClaims: ["exp", "iat", "sub", "kind"],
      clockTolerance: 5,
    });
    const kind = payload.kind;
    if (kind !== "user" && kind !== "agent" && kind !== "service" && kind !== "pass") {
      return { ok: false, error: "invalid principal kind" };
    }
    if (kind === "pass" && await passRevocationCheck(payload)) {
      return { ok: false, error: "pass revoked" };
    }
    return { ok: true, claims: payload };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * The stable hub trader id derived from a verified token. Agent tokens trade
 * AS the OBC bot they proved control of; users trade as their user id. The
 * `kax:` namespace guarantees these can never collide with open play-tier
 * self-registered trader ids (which are arbitrary strings), so an attacker
 * can't self-register a play trader that impersonates an authenticated one.
 * A pass-minted token (kind = "pass", #303) trades as `kax:pass:<sub>`.
 */
function traderIdFromClaims(claims) {
  if (claims.kind === "agent" && claims.bot_id) return `kax:agent:${claims.bot_id}`;
  return `kax:${claims.kind}:${claims.sub}`;
}

module.exports = { verifyKaxToken, traderIdFromClaims, bearerToken: bearer, setPassRevocationCheck, _resetJwksCache };
