'use strict';

// ADR-0041 Phase 1: the hub's KAX token verifier. Spins up a tiny JWKS server
// with a test Ed25519 key, points KAX_JWKS_URL at it, and checks that valid
// tokens verify and every forgery/expiry/issuer vector is rejected — the same
// hardening KAX's own verifier has.

const assert = require('assert');
const http = require('http');

async function main() {
  const { generateKeyPair, exportJWK, importJWK, SignJWT, calculateJwkThumbprint } = await import('jose');

  const ISS = 'https://kax.ninja-portal.com';
  const ALG = 'EdDSA';
  const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const privJwk = await exportJWK(privateKey);
  const kid = await calculateJwkThumbprint(privJwk);
  const signKey = await importJWK({ ...privJwk, alg: ALG }, ALG);
  const { d, ...pubJwk } = privJwk; // public = private minus d
  pubJwk.kid = kid; pubJwk.alg = ALG; pubJwk.use = 'sig';

  // Serve the JWKS on an ephemeral loopback port.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [pubJwk] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  process.env.KAX_JWKS_URL = `http://127.0.0.1:${port}/jwks.json`;
  process.env.KAX_IDENTITY_ISSUER = ISS;

  // Require AFTER env is set; reset the cache to be safe.
  const { verifyKaxToken, traderIdFromClaims, bearerToken, setPassRevocationCheck, _resetJwksCache } = require('../server/kax-identity');
  _resetJwksCache();

  const now = Math.floor(Date.now() / 1000);
  const mk = (o = {}) => new SignJWT(o.claims || { kind: 'agent', bot_id: 'bot-xyz' })
    .setProtectedHeader({ alg: ALG, kid: o.kid || kid, typ: 'JWT' })
    .setIssuer(o.iss || ISS).setSubject(o.sub || 'user-1')
    .setIssuedAt(o.iat || now).setExpirationTime(o.exp || now + 900).setJti('j')
    .sign(o.key || signKey);

  // 1. valid agent token verifies + derives the bot-scoped trader id
  {
    const token = await mk();
    const v = await verifyKaxToken(`Bearer ${token}`);
    assert.strictEqual(v.ok, true, `valid token should verify: ${v.error}`);
    assert.strictEqual(v.claims.kind, 'agent');
    assert.strictEqual(traderIdFromClaims(v.claims), 'kax:agent:bot-xyz');
  }
  // 2. user token derives a user-scoped trader id
  {
    const token = await mk({ claims: { kind: 'user' }, sub: 'user-42' });
    const v = await verifyKaxToken(`Bearer ${token}`);
    assert.strictEqual(v.ok, true);
    assert.strictEqual(traderIdFromClaims(v.claims), 'kax:user:user-42');
  }
  // 3. missing bearer -> rejected
  assert.strictEqual((await verifyKaxToken(undefined)).ok, false);
  assert.strictEqual((await verifyKaxToken('Basic abc')).ok, false);
  // 4. expired -> rejected
  assert.strictEqual((await verifyKaxToken(`Bearer ${await mk({ iat: now - 3600, exp: now - 3000 })}`)).ok, false);
  // 5. wrong issuer -> rejected
  assert.strictEqual((await verifyKaxToken(`Bearer ${await mk({ iss: 'https://evil' })}`)).ok, false);
  // 6. alg=none unsigned forgery -> rejected
  {
    const h = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ iss: ISS, sub: 'x', kind: 'service', iat: now, exp: now + 900 })).toString('base64url');
    assert.strictEqual((await verifyKaxToken(`Bearer ${h}.${p}.`)).ok, false);
  }
  // 7. token signed by a foreign key (unknown kid) -> rejected
  {
    const { privateKey: ak } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const akey = await importJWK({ ...await exportJWK(ak), alg: ALG }, ALG);
    assert.strictEqual((await verifyKaxToken(`Bearer ${await mk({ kid: 'attacker', key: akey })}`)).ok, false);
  }

  // 8. (#303) a pass-minted token (kind = "pass") verifies and derives kax:pass:<sub>
  {
    const token = await mk({ claims: { kind: 'pass' }, sub: 'pass_7f3a' });
    const v = await verifyKaxToken(`Bearer ${token}`);
    assert.strictEqual(v.ok, true, `pass token should verify: ${v.error}`);
    assert.strictEqual(traderIdFromClaims(v.claims), 'kax:pass:pass_7f3a');
    assert.strictEqual(traderIdFromClaims({ kind: 'pass', sub: 'p1' }), 'kax:pass:p1');
    // the revocation hook is consulted for pass tokens only, and a revoked pass is refused
    const seen = [];
    setPassRevocationCheck(async (claims) => { seen.push(claims.sub); return claims.sub === 'pass_7f3a'; });
    try {
      const revoked = await verifyKaxToken(`Bearer ${token}`);
      assert.strictEqual(revoked.ok, false);
      assert.match(revoked.error, /revoked/);
      const other = await verifyKaxToken(`Bearer ${await mk({ claims: { kind: 'pass' }, sub: 'pass_live' })}`);
      assert.strictEqual(other.ok, true, `unrevoked pass should verify: ${other.error}`);
      const agent = await verifyKaxToken(`Bearer ${await mk()}`);
      assert.strictEqual(agent.ok, true);
      assert.deepStrictEqual(seen, ['pass_7f3a', 'pass_live'], 'hook runs for pass tokens only');
    } finally { setPassRevocationCheck(null); }
    assert.strictEqual((await verifyKaxToken(`Bearer ${token}`)).ok, true, 'default hook revokes nothing');
  }
  // 9. an unknown kind is still rejected; bearerToken() splits the header
  assert.strictEqual((await verifyKaxToken(`Bearer ${await mk({ claims: { kind: 'admin' } })}`)).ok, false);
  assert.strictEqual(bearerToken('Bearer abc.def'), 'abc.def');
  assert.strictEqual(bearerToken('bearer   xyz '), 'xyz');
  assert.strictEqual(bearerToken('Basic abc'), null);
  assert.strictEqual(bearerToken(undefined), null);

  server.close();
  console.log('kax-identity.test.js: OK (valid tokens verify + derive trader id; pass kind + revocation hook; forgery/expiry/issuer all rejected)');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
