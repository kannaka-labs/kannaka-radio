'use strict';

// guest-withdrawal.test.js — a guest can take their work off the air without
// the operator (#443, server/guest-withdrawal.js). Here: the log and the
// gate, links and tokens, the e-mail decision, confirmations, the public
// view, the routes and the CLI. What happens to a piece already on air is
// test/guest-withdrawal-onair.test.js.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const gw = require('../server/guest-withdrawal');
const gc = require('../server/guest-consent');
const { PodcastScheduler } = require('../server/podcast-scheduler');

let failures = 0;
const queue = [];
function check(name, fn) {
  queue.push(async () => {
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e}`); }
  });
}
const quiet = { log: () => {}, warn: () => {} };
const SECRET = 'test-secret-not-real';

function tmpStation() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-'));
  const musicDir = path.join(root, 'music');
  const folder = 'Guest Reading';
  fs.mkdirSync(path.join(musicDir, folder), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
  const P = { ...gc.defaultPaths(root, {}), ...gw.defaultPaths(root, {}) };
  const sidecar = { guest: 'writer-a', requires: [] };
  fs.writeFileSync(path.join(musicDir, folder, 'A.mp3'), 'x');
  fs.writeFileSync(path.join(musicDir, folder, 'A.guest.json'), JSON.stringify(sidecar));
  fs.writeFileSync(path.join(musicDir, folder, 'B.mp3'), 'x');
  fs.writeFileSync(path.join(musicDir, folder, 'B.guest.json'), JSON.stringify({ guest: 'writer-b', requires: [] }));
  fs.writeFileSync(P.consentFile, JSON.stringify({ guests: {
    'writer-a': { consent: true, resolved: [], contact: { email: 'a@example.org' } },
    'writer-b': { consent: true, resolved: [], contact: { email: 'b@example.net' }, tokenEpoch: 2 },
    'masto-c': { consent: true, resolved: [], contact: { mastodon: { acct: 'c@example.social', id: '123' } } },
  } }));
  const gate = gc.createGate({ musicDir, folder, ...P, log: quiet });
  return { root, musicDir, folder, P, gate };
}

// ── tokens ──────────────────────────────────────────────────────

check('token: the right link verifies; forged, other-guest, old-epoch and no-secret do not', () => {
  const t = gw.makeToken(SECRET, 'writer-a', 0);
  assert.ok(gw.verifyToken(SECRET, 'writer-a', 0, t));
  assert.ok(!gw.verifyToken(SECRET, 'writer-a', 0, t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A')), 'one char changed');
  assert.ok(!gw.verifyToken(SECRET, 'writer-b', 0, t), 'another guest');
  assert.ok(!gw.verifyToken(SECRET, 'writer-a', 1, t), 'an old epoch');
  assert.ok(!gw.verifyToken('', 'writer-a', 0, t), 'no secret');
  assert.ok(!gw.verifyToken('other-secret', 'writer-a', 0, t), 'another secret');
  assert.ok(!gw.verifyToken(SECRET, 'writer-a', 0, ''), 'empty');
  assert.ok(!gw.verifyToken(SECRET, '../x', 0, t), 'not an id');
});

check('token input is domain-separated and length-prefixed (no id/epoch collisions)', () => {
  assert.notStrictEqual(gw.tokenInput('a:1', 0), gw.tokenInput('a', 10));
  assert.notStrictEqual(gw.tokenInput('a1', 0), gw.tokenInput('a', 10));
  assert.ok(gw.tokenInput('x', 0).startsWith('guest-withdraw-v1\n'));
});

// ── the log and the gate ────────────────────────────────────────

check('withdrawal holds the next airing, /audio/ and a restart resume; the audit row is written', () => {
  const st = tmpStation();
  assert.ok(st.gate.check('A.mp3').ok, 'cleared before');
  const r = gw.withdraw(st.P.withdrawalsFile, { guest: 'writer-a', channel: 'link', verified: true, from: 'withdrawal link', secret: SECRET });
  assert.ok(r.created);
  const rows = fs.readFileSync(st.P.withdrawalsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].kind, 'withdraw');
  assert.strictEqual(rows[0].guest, 'writer-a');
  assert.strictEqual(rows[0].channel, 'link');
  assert.ok(Date.parse(rows[0].at));
  assert.strictEqual(rows[0].publicId, gw.publicIdOf(SECRET, 'writer-a'));
  const res = st.gate.check('A.mp3');
  assert.strictEqual(res.ok, false);
  assert.ok(res.reasons.some((x) => /withdrawn by "writer-a"/.test(x)), res.reasons.join('; '));
  assert.ok(st.gate.check('B.mp3').ok, 'another guest is untouched');
  assert.strictEqual(gc.servable(st.musicDir, 'Guest Reading/A.mp3', st.P.consentFile, st.P.withdrawalsFile), false, '/audio/ refuses it');
  assert.strictEqual(gc.servable(st.musicDir, 'Guest Reading/B.mp3', st.P.consentFile, st.P.withdrawalsFile), true);
  // A restart: a fresh gate (and scheduler) reads the same log.
  const gate2 = gc.createGate({ musicDir: st.musicDir, folder: st.folder, ...st.P, log: quiet });
  assert.strictEqual(gate2.check('A.mp3', { ignoreAirings: true }).ok, false, 'resume path holds it too');
  const engine = { state: { channel: 'dj', playlist: [], playlistMeta: [], history: [], currentTrackIdx: 0, currentAlbum: 'X' }, loadAlbum() {} };
  fs.writeFileSync(path.join(st.root, 'onair.json'), JSON.stringify({ file: 'Guest Reading/A.mp3', folder: 'Guest Reading', startedAtMs: Date.now() - 10000 }));
  const s = new PodcastScheduler({ djEngine: engine, voiceDJ: {}, broadcast() {}, broadcastState() {}, getMusicDir: () => st.musicDir, gate: gate2,
    onairFile: path.join(st.root, 'onair.json'), probeDurationMs: () => 120000, show: { label: 'Guest Reading', folder: 'Guest Reading', airHours: [], intro: null } });
  assert.strictEqual(s._resumeIfInterrupted(), false, 'not resumed after a restart');
});

check('repeat requests are idempotent: same requestId, or already withdrawn → no new row', () => {
  const st = tmpStation();
  const a = gw.withdraw(st.P.withdrawalsFile, { guest: 'writer-a', channel: 'email', requestId: '<m1@x>' });
  const b = gw.withdraw(st.P.withdrawalsFile, { guest: 'writer-a', channel: 'email', requestId: '<m1@x>' });
  const c = gw.withdraw(st.P.withdrawalsFile, { guest: 'writer-a', channel: 'link' });
  assert.ok(a.created && b.duplicate && c.already);
  assert.strictEqual(b.row.at, a.row.at);
  assert.strictEqual(fs.readFileSync(st.P.withdrawalsFile, 'utf8').trim().split('\n').length, 1);
});

check('re-consent is a row with evidence, and the latest row decides', () => {
  const st = tmpStation();
  gw.withdraw(st.P.withdrawalsFile, { guest: 'writer-a', channel: 'link' });
  assert.throws(() => gw.reconsent(st.P.withdrawalsFile, { guest: 'writer-a', evidence: '' }), /evidence/);
  assert.strictEqual(st.gate.check('A.mp3').ok, false);
  const r = gw.reconsent(st.P.withdrawalsFile, { guest: 'writer-a', evidence: '<yes-again@example.org>' });
  assert.ok(r.created);
  assert.ok(st.gate.check('A.mp3').ok, 'cleared by the later re-consent row');
  assert.ok(gw.reconsent(st.P.withdrawalsFile, { guest: 'writer-a', evidence: 'x' }).already, 'nothing to re-consent');
  gw.withdraw(st.P.withdrawalsFile, { guest: 'writer-a', channel: 'link' });
  assert.strictEqual(st.gate.check('A.mp3').ok, false, 'and a later withdrawal holds again');
  const view = gw.publicView(st.P.withdrawalsFile);
  assert.deepStrictEqual(view.rows.map((x) => x.kind), ['withdraw', 'reconsent', 'withdraw']);
  assert.strictEqual(view.chainBreaks, 0);
});

check('an unreadable or malformed log holds EVERY guest; a torn line stays on its own line', () => {
  const st = tmpStation();
  fs.writeFileSync(st.P.withdrawalsFile, '{"v":1,"at":"2026-11-08T00:00:00Z","kind":"withd');
  const r = st.gate.check('B.mp3');
  assert.strictEqual(r.ok, false);
  assert.ok(r.reasons.includes('withdrawal log unreadable'));
  assert.strictEqual(gc.servable(st.musicDir, 'Guest Reading/B.mp3', st.P.consentFile, st.P.withdrawalsFile), false);
  gw.withdraw(st.P.withdrawalsFile, { guest: 'writer-a', channel: 'operator' });
  const lines = fs.readFileSync(st.P.withdrawalsFile, 'utf8').split('\n');
  assert.strictEqual(lines[0], '{"v":1,"at":"2026-11-08T00:00:00Z","kind":"withd', 'the torn line was not glued to the new row');
  assert.strictEqual(JSON.parse(lines[1]).guest, 'writer-a');
  assert.strictEqual(gw.readLog(st.P.withdrawalsFile, quiet).bad, 1);
  // Repair (docs/guest-withdrawal.md): drop the torn line; the rest stands.
  fs.writeFileSync(st.P.withdrawalsFile, lines.slice(1).join('\n'));
  assert.ok(st.gate.check('B.mp3').ok);
  assert.strictEqual(st.gate.check('A.mp3').ok, false);
  // A directory where the file should be: unreadable, everyone held.
  const st2 = tmpStation();
  fs.mkdirSync(st2.P.withdrawalsFile);
  assert.strictEqual(st2.gate.check('B.mp3').ok, false);
});

check('the public view leaks no guest id, sender, note or request id; the hash chain checks', () => {
  const st = tmpStation();
  gw.withdraw(st.P.withdrawalsFile, { guest: 'writer-a', channel: 'email', from: 'a@example.org', requestId: '<secret-msg@x>', note: 'private words', secret: SECRET });
  gw.withdraw(st.P.withdrawalsFile, { guest: 'writer-b', channel: 'link', from: 'withdrawal link', secret: SECRET });
  const view = gw.publicView(st.P.withdrawalsFile);
  const text = JSON.stringify(view);
  for (const leak of ['writer-a', 'writer-b', 'a@example.org', 'secret-msg', 'private words', 'withdrawal link']) {
    assert.ok(!text.includes(leak), `public view leaks ${leak}`);
  }
  assert.deepStrictEqual(Object.keys(view.rows[0]).sort(), ['at', 'channel', 'hash', 'kind', 'prev', 'publicId', 'verified']);
  assert.strictEqual(view.rows[1].prev, view.rows[0].hash);
  assert.strictEqual(view.chainBreaks, 0);
  // Tamper with a public field: the chain says so.
  const lines = fs.readFileSync(st.P.withdrawalsFile, 'utf8').trim().split('\n');
  const r0 = JSON.parse(lines[0]); r0.at = '2020-01-01T00:00:00.000Z';
  fs.writeFileSync(st.P.withdrawalsFile, [JSON.stringify(r0), lines[1]].join('\n') + '\n');
  assert.ok(gw.publicView(st.P.withdrawalsFile).chainBreaks > 0);
});

check('guest-show labels get no stings (nothing unseen is queued ahead of a guest intro)', () => {
  const { showGetsStings } = require('../server/sound-library');
  assert.strictEqual(showGetsStings('Guest Showcase intro'), false);
  assert.strictEqual(showGetsStings('Guest Reading'), false);
});

check('guest data is gitignored (consent, airings, withdrawals, outbox)', () => {
  const root = path.resolve(__dirname, '..');
  for (const f of ['workspace/guest-consent.json', 'workspace/guest-airings.json', 'workspace/guest-airings.json.tmp-1',
    'workspace/guest-withdrawals.jsonl', 'workspace/guest-withdraw-outbox.jsonl']) {
    try { execFileSync('git', ['check-ignore', '-q', f], { cwd: root, stdio: 'ignore' }); }
    catch (e) {
      if (e && e.code === 'ENOENT') return; // no git on this runner
      throw new Error(`${f} is not gitignored`);
    }
  }
});

// ── e-mail ─────────────────────────────────────────────────────

const AR_OK = 'mx.spacechild.love; dkim=pass header.d=example.org header.s=s1; spf=pass smtp.mailfrom=a@example.org; dmarc=pass (p=reject) header.from=example.org';

check('subject parsing: "withdraw", any case, Re:, optional id; nothing else', () => {
  assert.deepStrictEqual(gw.parseWithdrawSubject('withdraw'), { id: null });
  assert.deepStrictEqual(gw.parseWithdrawSubject('Re: WITHDRAW'), { id: null });
  assert.deepStrictEqual(gw.parseWithdrawSubject('Fwd: re: Withdraw Writer-A'), { id: 'writer-a' });
  assert.strictEqual(gw.parseWithdrawSubject('Re: your show tonight'), null);
  assert.strictEqual(gw.parseWithdrawSubject('withdrawal of funds offer'), null);
});

check('a matching From is NOT verification: DKIM and DMARC must pass, aligned to the contact domain', () => {
  assert.ok(gw.authVerified([AR_OK], 'Writer A <a@example.org>'));
  assert.ok(!gw.authVerified([], 'a@example.org'), 'no results');
  assert.ok(!gw.authVerified(['mx.spacechild.love; dkim=pass header.d=evil.com; dmarc=pass header.from=example.org'], 'a@example.org'), 'dkim for another domain');
  assert.ok(!gw.authVerified(['mx.spacechild.love; dkim=pass header.d=example.org; dmarc=fail header.from=example.org'], 'a@example.org'), 'dmarc fail');
  assert.ok(!gw.authVerified([AR_OK], 'a@example.org', { authservId: 'other.mx' }), 'not our MTA');
  assert.ok(gw.authVerified([AR_OK], 'a@example.org', { authservId: 'mx.spacechild.love' }));
});

check('email decisions: contact + auth → verified; spoofed, other-guest id, plain words → held unverified, operator told', () => {
  const st = tmpStation();
  const c = st.P.consentFile;
  let d = gw.decideEmail({ consentFile: c, from: 'a@example.org', subject: 'withdraw', authResults: [AR_OK] });
  assert.deepStrictEqual([d.action, d.guest, d.verified, d.notifyOperator], ['withdraw', 'writer-a', true, false]);
  d = gw.decideEmail({ consentFile: c, from: 'a@example.org', subject: 'Re: withdraw', authResults: [] });
  assert.deepStrictEqual([d.action, d.guest, d.verified, d.notifyOperator], ['withdraw', 'writer-a', false, true]);
  d = gw.decideEmail({ consentFile: c, from: 'stranger@x.com', subject: 'withdraw writer-b', authResults: [] });
  assert.deepStrictEqual([d.action, d.guest, d.verified, d.notifyOperator], ['withdraw', 'writer-b', false, true]);
  d = gw.decideEmail({ consentFile: c, from: 'stranger@x.com', subject: 'withdraw', authResults: [] });
  assert.deepStrictEqual([d.action, d.notifyOperator], ['ignore', true]);
  d = gw.decideEmail({ consentFile: c, from: 'b@example.net', subject: 'about tonight', body: 'Actually, please don\'t air it. Sorry!', authResults: [] });
  assert.deepStrictEqual([d.action, d.guest, d.verified, d.notifyOperator], ['withdraw', 'writer-b', false, true]);
  d = gw.decideEmail({ consentFile: c, from: 'b@example.net', subject: 'thanks', body: 'Looking forward to hearing it!', authResults: [] });
  assert.strictEqual(d.action, 'ignore');
});

// ── confirmations ───────────────────────────────────────────────

check('confirmation is queued to the contact ON RECORD, once a day per guest, and sent through a mailer', async () => {
  const st = tmpStation();
  const r = gw.withdraw(st.P.withdrawalsFile, { guest: 'writer-a', channel: 'email', from: 'forger@evil.com', secret: SECRET });
  const rec = gw.guestRecord(st.P.consentFile, 'writer-a');
  const q = gw.queueConfirmation(st.P.outboxFile, { guest: 'writer-a', record: rec, row: r.row, channel: 'email' });
  assert.ok(q.queued);
  assert.strictEqual(q.to, 'a@example.org', 'never to whoever asked');
  assert.ok(q.body.includes(r.row.hash) && q.body.includes(r.row.publicId), 'the guest gets their row hash and public id');
  assert.ok(/did not ask for this/.test(q.body));
  assert.strictEqual(gw.queueConfirmation(st.P.outboxFile, { guest: 'writer-a', record: rec, row: r.row, channel: 'email' }).queued, false, 'daily cap');
  assert.strictEqual(gw.pendingConfirmations(st.P.outboxFile).length, 1);
  const sent = [];
  const mailer = { configured: () => true, send: async (m) => { sent.push(m); return true; } };
  const f = await gw.flushOutbox(st.P.outboxFile, mailer);
  assert.deepStrictEqual(f, { sent: 1, failed: 0, left: 0 });
  assert.strictEqual(sent[0].to, 'a@example.org');
  assert.strictEqual(gw.pendingConfirmations(st.P.outboxFile).length, 0);
  const ev = gw.readOutbox(st.P.outboxFile).map((e) => e.event);
  assert.deepStrictEqual(ev, ['queued', 'sent'], 'append-only events, nothing rewritten');
  // Mastodon-only guest: queued, never "sent" by the mailer, visible in health.
  const r2 = gw.withdraw(st.P.withdrawalsFile, { guest: 'masto-c', channel: 'link' });
  const q2 = gw.queueConfirmation(st.P.outboxFile, { guest: 'masto-c', record: gw.guestRecord(st.P.consentFile, 'masto-c'), row: r2.row, channel: 'link' });
  assert.strictEqual(q2.via, 'mastodon');
  await gw.flushOutbox(st.P.outboxFile, mailer);
  assert.strictEqual(gw.outboxHealth(st.P.outboxFile).pending, 1);
});

// ── the routes ───────────────────────────────────────────────────

function makeServer(baseDir, extra = {}) {
  const setupRoutes = require('../server/routes');
  const noop = () => {};
  const deps = {
    djEngine: { state: { channel: 'dj', playlist: [], playlistMeta: [], currentTrackIdx: 0 }, userQueue: [] },
    perception: { perceive: noop, getHistory: () => [] }, nats: { connected: false, publish: noop },
    flux: { publish: noop }, live: {}, voiceDJ: { isTalking: () => false }, syncManager: {}, voteManager: {},
    webrtcSignaling: {}, musicGen: {}, broadcast: noop, broadcastState: noop, floor: {},
    config: { spaPath: __dirname, getMusicDir: () => path.join(baseDir, 'music'), musicDir: path.join(baseDir, 'music'), baseDir, broadcastState: noop, broadcastQueue: noop },
    gsHub: null, ...extra,
  };
  const handler = setupRoutes(deps);
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, deps })));
}

function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method,
      headers: body ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

check('routes: GET confirms only; forged/unknown → identical 403; no secret → 503 naming e-mail; POST withdraws once', async () => {
  const st = tmpStation();
  const applied = [];
  const { server, port } = await makeServer(st.root, { onGuestWithdrawn: (g) => applied.push(g) });
  const old = process.env.GUEST_WITHDRAW_SECRET;
  try {
    delete process.env.GUEST_WITHDRAW_SECRET;
    let r = await req(port, 'GET', '/guest/withdraw?g=writer-a&t=abc');
    assert.strictEqual(r.status, 503);
    assert.ok(r.body.includes('kannaka@spacechild.love'), 'names the e-mail fallback');
    process.env.GUEST_WITHDRAW_SECRET = SECRET;
    const t = gw.makeToken(SECRET, 'writer-a', 0);
    r = await req(port, 'GET', `/guest/withdraw?g=writer-a&t=${t}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['referrer-policy'], 'no-referrer');
    assert.strictEqual(r.headers['cache-control'], 'no-store');
    assert.ok(/<form method="post"/.test(r.body));
    assert.ok(!r.body.includes('a@example.org'), 'the confirm page shows no contact');
    assert.strictEqual(fs.existsSync(st.P.withdrawalsFile), false, 'a GET (a mail scanner prefetch) changes nothing');
    const forged = await req(port, 'POST', '/guest/withdraw', `g=writer-a&t=${gw.makeToken('wrong', 'writer-a', 0)}`);
    const unknown = await req(port, 'POST', '/guest/withdraw', `g=nobody&t=${t}`);
    const otherGuest = await req(port, 'POST', '/guest/withdraw', `g=writer-b&t=${t}`);
    const oldEpoch = await req(port, 'POST', '/guest/withdraw', `g=writer-b&t=${gw.makeToken(SECRET, 'writer-b', 1)}`);
    for (const x of [forged, unknown, otherGuest, oldEpoch]) assert.strictEqual(x.status, 403);
    assert.strictEqual(forged.body, unknown.body, 'an unknown guest and a bad token look the same');
    assert.strictEqual(fs.existsSync(st.P.withdrawalsFile), false, 'nothing written for a rejected token');
    r = await req(port, 'POST', '/guest/withdraw', `g=writer-a&t=${t}`);
    assert.strictEqual(r.status, 200);
    assert.ok(/Withdrawn/.test(r.body));
    assert.deepStrictEqual(applied, ['writer-a'], 'taken off the air at once');
    assert.strictEqual(gw.readLog(st.P.withdrawalsFile).rows.length, 1);
    assert.strictEqual(gw.pendingConfirmations(st.P.outboxFile).length, 1, 'confirmation queued');
    r = await req(port, 'POST', '/guest/withdraw', `g=writer-a&t=${t}`);
    assert.ok(/Already withdrawn/.test(r.body));
    assert.strictEqual(gw.readLog(st.P.withdrawalsFile).rows.length, 1, 'no second row');
    assert.strictEqual(gw.readOutbox(st.P.outboxFile).length, 1, 'no second confirmation');
    assert.deepStrictEqual(applied, ['writer-a']);
    // The public log.
    r = await req(port, 'GET', '/api/guest-withdrawals');
    const j = JSON.parse(r.body);
    assert.strictEqual(j.rows.length, 1);
    assert.strictEqual(j.confirmations.pending, 1);
    assert.ok(!r.body.includes('writer-a') && !r.body.includes('withdrawal link'));
  } finally {
    if (old === undefined) delete process.env.GUEST_WITHDRAW_SECRET; else process.env.GUEST_WITHDRAW_SECRET = old;
    server.close();
  }
});

check('routes: failed attempts are limited, a valid token never is', async () => {
  const st = tmpStation();
  const { server, port } = await makeServer(st.root);
  const old = process.env.GUEST_WITHDRAW_SECRET;
  process.env.GUEST_WITHDRAW_SECRET = SECRET;
  try {
    let last = null;
    for (let i = 0; i < 25; i++) last = await req(port, 'POST', '/guest/withdraw', 'g=writer-a&t=nope');
    assert.strictEqual(last.status, 429, 'a flood of bad tokens is throttled');
    const ok = await req(port, 'POST', '/guest/withdraw', `g=writer-a&t=${gw.makeToken(SECRET, 'writer-a', 0)}`);
    assert.strictEqual(ok.status, 200, 'the real guest still gets through');
  } finally {
    if (old === undefined) delete process.env.GUEST_WITHDRAW_SECRET; else process.env.GUEST_WITHDRAW_SECRET = old;
    server.close();
  }
});

// ── the CLI ───────────────────────────────────────────────────────

check('CLI: link never prints the secret; email path withdraws, confirms once, tells the operator when unverified', () => {
  const st = tmpStation();
  const { run } = require('../scripts/guest-withdraw');
  const env = { KANNAKA_RADIO_BASE_DIR: st.root, GUEST_WITHDRAW_SECRET: SECRET, RADIO_OPERATOR_EMAIL: 'op@example.com' };
  const outs = [];
  const out = (o) => outs.push(o);
  assert.strictEqual(run(['link', 'writer-b'], env, out), 0);
  assert.ok(outs[0].url.includes('g=writer-b&t='));
  assert.ok(!JSON.stringify(outs[0]).includes(SECRET), 'no secret in the output');
  assert.ok(gw.verifyToken(SECRET, 'writer-b', 2, new URL(outs[0].url).searchParams.get('t')), 'the link carries the guest\'s current epoch');
  assert.strictEqual(run(['link', 'writer-a'], { ...env, GUEST_WITHDRAW_SECRET: '' }, out), 2);
  const ar = path.join(st.root, 'ar.txt');
  fs.writeFileSync(ar, AR_OK + '\n');
  run(['email', '--from', 'Writer A <a@example.org>', '--subject', 'Re: withdraw', '--auth-results-file', ar, '--message-id', '<m1@example.org>'], env, out);
  let o = outs[outs.length - 1];
  assert.deepStrictEqual([o.action, o.guest, o.verified, o.created], ['withdraw', 'writer-a', true, true]);
  assert.ok(o.confirmation && o.confirmation.queued && o.confirmation.to === 'a@example.org');
  assert.strictEqual(o.operatorNote, undefined, 'verified: the operator need not look');
  run(['email', '--from', 'Writer A <a@example.org>', '--subject', 'Re: withdraw', '--auth-results-file', ar, '--message-id', '<m1@example.org>'], env, out);
  o = outs[outs.length - 1];
  assert.ok(o.duplicate && !o.confirmation, 'the inbox re-reading the same message changes nothing');
  run(['email', '--from', 'stranger@x.com', '--subject', 'withdraw writer-b', '--message-id', '<m2@x.com>'], env, out);
  o = outs[outs.length - 1];
  assert.deepStrictEqual([o.action, o.guest, o.verified, o.created], ['withdraw', 'writer-b', false, true]);
  assert.ok(o.operatorNote && o.operatorNote.queued);
  assert.strictEqual(o.confirmation.to, 'b@example.net', 'the real guest hears of it');
  run(['status'], env, out);
  o = outs[outs.length - 1];
  assert.strictEqual(o.guests['writer-a'].kind, 'withdraw');
  assert.strictEqual(o.guests['writer-b'].verified, false);
  run(['reconsent', 'writer-b', '--evidence', '<yes@example.net>'], env, out);
  assert.ok(st.gate.check('B.mp3').ok);
  const pend = gw.pendingConfirmations(st.P.outboxFile);
  run(['mark', pend[0].id, 'sent', '--via', 'inbox'], env, out);
  assert.strictEqual(gw.pendingConfirmations(st.P.outboxFile).length, pend.length - 1);
});

(async () => {
  console.log('guest-withdrawal.test.js');
  for (const t of queue) await t();
  if (failures) { console.error(`\n${failures} guest-withdrawal test(s) failed`); process.exit(1); }
  console.log('all passed');
})();
