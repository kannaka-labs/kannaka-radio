'use strict';
/**
 * Guest withdrawal — a guest can take their piece off the air without asking
 * the operator (issue #443).
 *
 * The consent file (server/guest-consent.js) is the operator's: he writes
 * "consent": true once the guest has said yes. Withdrawal is the guest's,
 * so it lives in a separate APPEND-ONLY log the radio never rewrites:
 *
 *   workspace/guest-withdrawals.jsonl   (env GUEST_WITHDRAWALS_FILE)
 *
 * One JSON object per line:
 *   { v:1, at, kind:"withdraw"|"reconsent", guest, channel, verified,
 *     from, requestId, note, evidence, publicId, prev, hash }
 *
 * The latest row per guest decides. A "withdraw" row holds every file of
 * that guest at the next scheduling decision, on /audio/ and on resume; a
 * later "reconsent" row (operator only, and only with evidence: the guest's
 * Message-ID or status URL) lifts it. Re-consent is a row in the same log,
 * not a quiet edit of a private file, so the public view below shows it.
 *
 * A log that exists but cannot be read, or holds one malformed line, holds
 * EVERY guest (the airings-ledger rule): a torn write must never read as
 * "nobody withdrew". The fix is in docs/guest-withdrawal.md (repair).
 *
 * Public view (GET /api/guest-withdrawals): per row only at, kind, channel,
 * verified, publicId, prev and hash. `hash` chains over exactly those
 * fields, so anyone can check the chain from the public view alone. The
 * guest is named only by publicId = HMAC(secret, "public:"+id), because
 * that a person withdrew can itself be sensitive. The confirmation tells
 * the guest their publicId and row hash.
 *
 * Withdrawal links: GET /guest/withdraw?g=<id>&t=<token> shows a confirm
 * page (mail scanners prefetch links; a GET changes nothing), the POST
 * withdraws. token = HMAC-SHA256(GUEST_WITHDRAW_SECRET,
 * "guest-withdraw-v1\n" + len(id) + ":" + id + "\n" + tokenEpoch), base64url.
 * Nothing is stored; raising the guest's `tokenEpoch` in the consent file
 * retires their old link.
 *
 * Confirmations go to an append-only outbox (events queued → sent|failed),
 * to the contact on record, never to whoever asked: a forged request then
 * reaches the real guest.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOG_VERSION = 1;
const KINDS = Object.freeze(['withdraw', 'reconsent']);
const CHANNELS = Object.freeze(['link', 'email', 'mastodon', 'operator']);
const GUEST_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const DEFAULT_FALLBACK_EMAIL = 'kannaka@spacechild.love';
const CONFIRM_CAP_MS = 24 * 60 * 60 * 1000;

function defaultPaths(baseDir, env = process.env) {
  const ws = path.join(baseDir || '.', 'workspace');
  return {
    withdrawalsFile: env.GUEST_WITHDRAWALS_FILE || path.join(ws, 'guest-withdrawals.jsonl'),
    outboxFile: env.GUEST_WITHDRAW_OUTBOX_FILE || path.join(ws, 'guest-withdraw-outbox.jsonl'),
  };
}

function validGuestId(id) { return typeof id === 'string' && GUEST_ID_RE.test(id); }

// ── tokens ──────────────────────────────────────────────────────

function tokenInput(id, epoch) {
  const s = String(id);
  // Domain-separated and length-prefixed: no two (id, epoch) pairs share an input.
  return `guest-withdraw-v1\n${Buffer.byteLength(s)}:${s}\n${Number.isInteger(epoch) ? epoch : 0}`;
}

function makeToken(secret, id, epoch = 0) {
  if (!secret) throw new Error('GUEST_WITHDRAW_SECRET is not set');
  return crypto.createHmac('sha256', String(secret)).update(tokenInput(id, epoch)).digest('base64url');
}

/** Constant-time check of a supplied token. False for anything malformed. */
function verifyToken(secret, id, epoch, supplied) {
  if (!secret || !validGuestId(id) || typeof supplied !== 'string' || supplied.length > 128) return false;
  const want = Buffer.from(makeToken(secret, id, epoch));
  const got = Buffer.from(supplied);
  if (want.length !== got.length) {
    // Same work either way, so the length of a wrong token says nothing.
    crypto.timingSafeEqual(want, want);
    return false;
  }
  return crypto.timingSafeEqual(want, got);
}

/** The name a guest goes by in public: a keyed hash of their id, or null with no secret. */
function publicIdOf(secret, id) {
  if (!secret || !id) return null;
  return crypto.createHmac('sha256', String(secret)).update(`guest-withdraw-public-v1\n${id}`).digest('hex').slice(0, 16);
}

// ── the log ────────────────────────────────────────────────────

const PUBLIC_FIELDS = Object.freeze(['at', 'kind', 'channel', 'verified', 'publicId', 'prev']);

function publicPart(row) {
  const o = {};
  for (const k of PUBLIC_FIELDS) o[k] = row[k] === undefined ? null : row[k];
  return o;
}

function rowHash(row) {
  return crypto.createHash('sha256').update(JSON.stringify(publicPart(row))).digest('hex');
}

function validRow(r) {
  return r && typeof r === 'object' && !Array.isArray(r)
    && KINDS.includes(r.kind) && validGuestId(r.guest)
    && typeof r.at === 'string' && Number.isFinite(Date.parse(r.at))
    && CHANNELS.includes(r.channel);
}

// Cache by (mtime, size): /audio/ consults the log on every range request.
const _cache = new Map();

/**
 * { ok, rows, bad, error }. A missing file is an empty, readable log. A file
 * that cannot be read, or that holds any line that is not a valid row, is
 * ok:false — and ok:false holds every guest.
 */
function readLog(file, log = console) {
  let st;
  try { st = fs.statSync(file); } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, rows: [], bad: 0 };
    return { ok: false, rows: [], bad: 0, error: e && e.message };
  }
  const key = `${st.mtimeMs}:${st.size}:${st.ino}`;
  const hit = _cache.get(file);
  if (hit && hit.key === key) return hit.value;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    return { ok: false, rows: [], bad: 0, error: e && e.message };
  }
  const rows = [];
  let bad = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let r = null;
    try { r = JSON.parse(line); } catch (_) { r = null; }
    if (validRow(r)) rows.push(r); else bad++;
  }
  const value = { ok: bad === 0, rows, bad };
  if (bad && log && log.warn) {
    log.warn(`[guest-withdrawal] ${file}: ${bad} malformed line(s) — EVERY guest is held until it is repaired (docs/guest-withdrawal.md)`);
  }
  _cache.set(file, { key, value });
  return value;
}

/** Map guest → their latest row. */
function latestByGuest(rows) {
  const m = new Map();
  for (const r of rows) m.set(r.guest, r);
  return m;
}

/**
 * What the consent gate needs: { unreadable, withdrawnAt(guest) → iso|null }.
 */
function holdState(file, log = console) {
  const l = readLog(file, log);
  const latest = latestByGuest(l.rows);
  return {
    unreadable: !l.ok,
    withdrawnAt(guest) {
      const r = latest.get(guest);
      return r && r.kind === 'withdraw' ? r.at : null;
    },
  };
}

/**
 * Append one row: O_APPEND, one write() per row, a newline first if the file
 * does not end in one (a torn line stays on its own line and reads as
 * malformed, which holds everyone, rather than gluing onto the next row),
 * fsync before returning.
 */
function appendLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a+');
  try {
    const size = fs.fstatSync(fd).size;
    let lead = '';
    if (size > 0) {
      const b = Buffer.alloc(1);
      fs.readSync(fd, b, 0, 1, size - 1);
      if (b[0] !== 0x0a) lead = '\n';
    }
    fs.writeSync(fd, lead + JSON.stringify(obj) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  _cache.delete(file);
}

function lastHash(rows) {
  return rows.length ? (rows[rows.length - 1].hash || rowHash(rows[rows.length - 1])) : null;
}

/**
 * Withdraw a guest. Idempotent:
 *   • a requestId already in the log → { duplicate:true, row } (no new row);
 *   • the guest is already withdrawn → { already:true, row } (no new row);
 *   • otherwise one row is appended → { created:true, row }.
 * Only `created` should send a confirmation.
 */
function withdraw(file, { guest, channel, verified = false, from = null, requestId = null, note = null, secret = null, now = new Date() }, log = console) {
  if (!validGuestId(guest)) throw new Error('invalid guest id');
  if (!CHANNELS.includes(channel)) throw new Error(`invalid channel (one of ${CHANNELS.join(', ')})`);
  const l = readLog(file, log);
  if (requestId) {
    const dup = l.rows.find((r) => r.requestId && r.requestId === requestId);
    if (dup) return { ok: true, duplicate: true, row: dup };
  }
  const cur = latestByGuest(l.rows).get(guest);
  if (cur && cur.kind === 'withdraw') return { ok: true, already: true, row: cur };
  const row = {
    v: LOG_VERSION,
    at: now.toISOString(),
    kind: 'withdraw',
    guest,
    channel,
    verified: verified === true,
    from: from ? String(from).slice(0, 320) : null,
    requestId: requestId ? String(requestId).slice(0, 200) : null,
    note: note ? String(note).slice(0, 500) : null,
    publicId: publicIdOf(secret, guest),
    prev: lastHash(l.rows),
  };
  row.hash = rowHash(row);
  appendLine(file, row);
  return { ok: true, created: true, row };
}

/** Operator only, and only with evidence of the guest's new yes. */
function reconsent(file, { guest, evidence, by = 'operator', secret = null, now = new Date() }, log = console) {
  if (!validGuestId(guest)) throw new Error('invalid guest id');
  if (!evidence || !String(evidence).trim()) throw new Error('re-consent needs evidence (the guest\'s Message-ID or status URL)');
  const l = readLog(file, log);
  const cur = latestByGuest(l.rows).get(guest);
  if (!cur || cur.kind !== 'withdraw') return { ok: true, already: true, row: cur || null };
  const row = {
    v: LOG_VERSION,
    at: now.toISOString(),
    kind: 'reconsent',
    guest,
    channel: 'operator',
    verified: true,
    from: String(by).slice(0, 320),
    requestId: null,
    note: null,
    evidence: String(evidence).slice(0, 500),
    publicId: publicIdOf(secret, guest),
    prev: lastHash(l.rows),
  };
  row.hash = rowHash(row);
  appendLine(file, row);
  return { ok: true, created: true, row };
}

/** The public view: no guest id, no `from`, no note, no request id. */
function publicView(file, log = console) {
  const l = readLog(file, log);
  let prev = null;
  let chainBreaks = 0;
  const rows = l.rows.map((r) => {
    const p = publicPart(r);
    const hash = rowHash(r);
    if (r.hash && r.hash !== hash) chainBreaks++;
    if (p.prev !== prev) chainBreaks++;
    prev = hash;
    return { ...p, hash };
  });
  return { ok: l.ok, malformedLines: l.bad, rows, chainBreaks };
}

// ── the consent file's guest record ──────────────────────────────

function readConsentFile(consentFile) {
  try {
    const v = JSON.parse(fs.readFileSync(consentFile, 'utf8'));
    return v && v.guests && typeof v.guests === 'object' ? v.guests : {};
  } catch (_) { return {}; }
}

function guestRecord(consentFile, id) {
  if (!validGuestId(id)) return null;
  const g = readConsentFile(consentFile);
  return Object.prototype.hasOwnProperty.call(g, id) && g[id] && typeof g[id] === 'object' ? g[id] : null;
}

function tokenEpochOf(rec) {
  return rec && Number.isInteger(rec.tokenEpoch) && rec.tokenEpoch >= 0 ? rec.tokenEpoch : 0;
}

function contactEmail(rec) {
  const e = rec && rec.contact && rec.contact.email;
  return typeof e === 'string' && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e) ? e.trim() : null;
}

function bareAddress(s) {
  const m = String(s || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(s || '')).trim().toLowerCase();
}

/** The guest whose contact e-mail is `addr`, or null (several → null: ambiguous). */
function guestByEmail(consentFile, addr) {
  const want = bareAddress(addr);
  if (!want) return null;
  const hits = Object.entries(readConsentFile(consentFile))
    .filter(([id, rec]) => validGuestId(id) && contactEmail(rec) && contactEmail(rec).toLowerCase() === want);
  return hits.length === 1 ? hits[0][0] : null;
}

/** Link check for the route: same answer for an unknown guest and a bad token. */
function checkLink({ consentFile, secret, guest, token }) {
  if (!secret) return { ok: false, status: 503 };
  const rec = guestRecord(consentFile, guest);
  // An unknown guest still costs one HMAC, so timing does not enumerate ids.
  const epoch = rec ? tokenEpochOf(rec) : 0;
  const good = verifyToken(secret, validGuestId(guest) ? guest : 'x', epoch, token);
  if (!rec || !good) return { ok: false, status: 403 };
  return { ok: true, record: rec };
}

// ── e-mail ─────────────────────────────────────────────────────

/** "withdraw", "Re: WITHDRAW", "withdraw luna" → { id|null }; anything else → null. */
function parseWithdrawSubject(subject) {
  const m = /^\s*(?:(?:re|fwd?|aw|sv)\s*:\s*)*withdraw(?:\s+([a-z0-9][a-z0-9._-]{0,63}))?\s*[.!]?\s*$/i.exec(String(subject || ''));
  return m ? { id: m[1] ? m[1].toLowerCase() : null } : null;
}

/** A plain-words request not to air, from a known contact (the deterministic floor). */
const FREE_TEXT_RE = /\b(withdraw|do\s*n[o']?t\s+air|do\s+not\s+(air|play|broadcast)|please\s+(remove|take\s+(it|this|my\s+\w+)\s+(down|off))|take\s+(it|this|my\s+\w+)\s+off\s+(the\s+)?air|pull\s+(it|my\s+\w+)|i\s+(withdraw|revoke)|revoke\s+(my\s+)?consent|no\s+longer\s+consent)\b/i;

function looksLikeWithdrawal(text) { return FREE_TEXT_RE.test(String(text || '')); }

function orgAligned(a, b) {
  a = String(a || '').toLowerCase().replace(/\.$/, '');
  b = String(b || '').toLowerCase().replace(/\.$/, '');
  if (!a || !b) return false;
  return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
}

/**
 * Did the receiving MTA authenticate this sender's domain? `results` is the
 * Authentication-Results header value(s) OUR mail server added (the inbox
 * passes only those whose authserv-id is ours; `authservId` re-checks it).
 * Requires dkim=pass with header.d aligned to the From domain AND dmarc=pass
 * for that domain. A From header alone proves nothing.
 */
function authVerified(results, fromAddr, { authservId } = {}) {
  const addr = bareAddress(fromAddr);
  const domain = addr.includes('@') ? addr.split('@').pop() : '';
  if (!domain) return false;
  const headers = (Array.isArray(results) ? results : [results]).filter((h) => typeof h === 'string' && h.trim());
  for (const h of headers) {
    const head = h.split(';')[0].trim().toLowerCase();
    if (authservId && head !== String(authservId).toLowerCase()) continue;
    const parts = h.split(';').slice(1).map((s) => s.trim().toLowerCase());
    const dkim = parts.some((p) => /^dkim\s*=\s*pass\b/.test(p)
      && (() => { const d = /header\.(?:d|i)\s*=\s*@?([^\s;]+)/.exec(p); return d && orgAligned(d[1].replace(/^.*@/, ''), domain); })());
    const dmarc = parts.some((p) => /^dmarc\s*=\s*pass\b/.test(p)
      && (() => { const d = /header\.from\s*=\s*([^\s;]+)/.exec(p); return d && orgAligned(d[1], domain); })());
    if (dkim && dmarc) return true;
  }
  return false;
}

/**
 * Decide an inbound e-mail. Deterministic: the inbox processor runs this
 * BEFORE any model-written auto-reply and marks the message handled.
 * Returns { action: "withdraw"|"ignore", guest, verified, notifyOperator, reason }.
 *   • subject "withdraw" (any case, Re: allowed), optional id;
 *   • guest = the sender's contact match; an id naming someone else is still
 *     held (holding is the safe side) but unverified and the operator is told;
 *   • a known contact writing "please don't air it" in plain words: held too,
 *     operator told;
 *   • verified only when the address is the contact on record AND our MTA's
 *     Authentication-Results show aligned DKIM + DMARC passes.
 */
function decideEmail({ consentFile, from, subject, body, authResults, authservId }) {
  const sender = guestByEmail(consentFile, from);
  const subj = parseWithdrawSubject(subject);
  const auth = authVerified(authResults, from, { authservId });
  if (subj) {
    let guest = sender;
    if (subj.id && subj.id !== sender) guest = guestRecord(consentFile, subj.id) ? subj.id : sender;
    if (!guest) return { action: 'ignore', reason: subj.id ? 'unknown guest id and unknown sender' : 'sender is not a guest contact on record', notifyOperator: true };
    const verified = guest === sender && auth;
    return { action: 'withdraw', guest, verified, notifyOperator: !verified, reason: verified ? 'subject, authenticated contact' : 'subject, sender not authenticated as this guest\'s contact' };
  }
  if (sender && looksLikeWithdrawal(`${subject || ''}\n${body || ''}`)) {
    return { action: 'withdraw', guest: sender, verified: false, notifyOperator: true, reason: 'plain-words request from a guest contact' };
  }
  return { action: 'ignore', reason: 'not a withdrawal', notifyOperator: false };
}

// ── confirmations (append-only outbox) ───────────────────────────

function readOutbox(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { const v = JSON.parse(line); if (v && typeof v === 'object') out.push(v); } catch (_) { /* skip */ }
  }
  return out;
}

/** Queued confirmations with no sent/failed-final event yet. */
function pendingConfirmations(file) {
  const ev = readOutbox(file);
  const done = new Set(ev.filter((e) => e.event === 'sent').map((e) => e.ref));
  return ev.filter((e) => e.event === 'queued' && !done.has(e.id));
}

function confirmationText({ row, guest, channel, siteOrigin, fallbackEmail }) {
  const origin = siteOrigin || 'https://radio.ninja-portal.com';
  const lines = [
    `Your withdrawal from Kannaka Radio is recorded.`,
    ``,
    `What happened: at ${row.at} the station recorded a withdrawal for your work (${channel} request${row.verified ? '' : ', not authenticated as you, held anyway because holding is the safe side'}).`,
    `From now on nothing of yours is scheduled, listed, served or resumed. If a piece of yours was on air, it was cut and the rest of that airing dropped.`,
    ``,
    `How to check it yourself:`,
    `  - ${origin}/api/guest-withdrawals lists every withdrawal. Yours is the row with publicId ${row.publicId || '(not set)'} and hash ${row.hash}.`,
    `  - Your file under ${origin}/audio/ now answers 404, and ${origin}/api/schedule no longer lists it.`,
    ``,
    `What this does not undo: airings that already happened, the short on-air summary already written to Kannaka's memory, and voice clips already rendered.`,
    ``,
    `If you did not ask for this, reply to this message; nothing of yours airs again until you say so.`,
    `To come back on air later, write to ${fallbackEmail || DEFAULT_FALLBACK_EMAIL}; the operator records your new yes in the same public log.`,
    ``,
    `This message was written by the station's software, not typed by a person.`,
  ];
  return { subject: 'Kannaka Radio: your withdrawal is recorded', body: lines.join('\n') };
}

/**
 * Queue a confirmation to the contact on record. At most one per guest per
 * day (forged requests must not become a way to mail-bomb a guest). Returns
 * { queued, id?, reason? }.
 */
function queueConfirmation(outboxFile, { guest, record, row, channel, siteOrigin, fallbackEmail, inReplyTo = null, sender = 'server', now = new Date() }) {
  const email = contactEmail(record);
  const masto = record && record.contact && record.contact.mastodon ? record.contact.mastodon : null;
  const to = email ? { channel: 'email', address: email } : (masto ? { channel: 'mastodon', address: masto } : null);
  if (!to) return { queued: false, reason: 'no contact on record' };
  const recent = readOutbox(outboxFile).some((e) => e.event === 'queued' && e.guest === guest
    && e.kind === 'confirmation' && now - Date.parse(e.at) < CONFIRM_CAP_MS);
  if (recent) return { queued: false, reason: 'a confirmation already went to this guest today' };
  const { subject, body } = confirmationText({ row, guest, channel, siteOrigin, fallbackEmail });
  const id = crypto.randomBytes(8).toString('hex');
  appendLine(outboxFile, {
    at: now.toISOString(), id, event: 'queued', kind: 'confirmation', guest,
    via: to.channel, to: to.address, subject, body, inReplyTo, rowHash: row.hash,
    sender: sender === 'inbox' ? 'inbox' : 'server',
  });
  return { queued: true, id, via: to.channel, to: to.address, subject, body };
}

/** Queue a note to the operator (an unverified or ambiguous request). */
function queueOperatorNote(outboxFile, { to, subject, body, sender = 'server', now = new Date() }) {
  const id = crypto.randomBytes(8).toString('hex');
  appendLine(outboxFile, { at: now.toISOString(), id, event: 'queued', kind: 'operator', guest: null, via: 'email', to: to || null, subject, body,
    sender: sender === 'inbox' ? 'inbox' : 'server' });
  return { queued: true, id };
}

function markOutbox(outboxFile, id, event, { via = null, error = null, now = new Date() } = {}) {
  if (!['sent', 'failed'].includes(event)) throw new Error('event must be sent or failed');
  appendLine(outboxFile, { at: now.toISOString(), ref: id, event, via, error: error ? String(error).slice(0, 300) : null });
}

// Outbox ids this process is sending right now. The link route and the log
// watcher both flush after one withdrawal; without this the second flush
// reads the row as still pending while the first awaits the relay, and the
// guest gets the confirmation twice.
const _inFlight = new Set();

/**
 * Try to send queued e-mail through a Mailer (server/mailer.js). Never throws.
 * Rows queued with sender "inbox" (the e-mail channel: kannaka-inbox.py
 * replies to the guest's own message, threaded, as the station's address,
 * then marks them sent) are left to the inbox, or the guest would hear twice.
 */
async function flushOutbox(outboxFile, mailer) {
  const res = { sent: 0, failed: 0, left: 0 };
  for (const e of pendingConfirmations(outboxFile)) {
    if (e.sender === 'inbox' || _inFlight.has(e.id)) { res.left++; continue; }
    if (e.via !== 'email' || !e.to || !mailer || typeof mailer.send !== 'function' || !(mailer.configured && mailer.configured())) { res.left++; continue; }
    _inFlight.add(e.id);
    let ok = false;
    try {
      try { ok = await mailer.send({ to: e.to, subject: e.subject, text: e.body }); } catch (_) { ok = false; }
      try { markOutbox(outboxFile, e.id, ok ? 'sent' : 'failed', { via: 'mailer', error: ok ? null : 'mailer refused or not configured' }); } catch (_) { /* best effort */ }
    } finally { _inFlight.delete(e.id); }
    if (ok) res.sent++; else { res.failed++; res.left++; }
  }
  return res;
}

/** Health line for the public view: how many confirmations wait, and since when. */
function outboxHealth(outboxFile) {
  const p = pendingConfirmations(outboxFile);
  const oldest = p.reduce((m, e) => (!m || e.at < m ? e.at : m), null);
  return { pending: p.length, oldestQueuedAt: oldest };
}

// ── live application ────────────────────────────────────────────

/**
 * Watch the log and call onWithdraw(guest, row) for each NEW withdraw row,
 * whoever wrote it (the server's link route or the CLI from the inbox).
 * Watches the directory (fs.watch on a file breaks when it does not exist
 * yet or is replaced) and polls every pollMs as a backstop. Rows already
 * present at start are not re-applied: the gate already holds them.
 */
function watchWithdrawals(file, onWithdraw, { pollMs = 5000, log = console } = {}) {
  const seen = new Set(readLog(file, log).rows.map((r) => r.hash || rowHash(r)));
  const scan = () => {
    let rows;
    try { rows = readLog(file, log).rows; } catch (_) { return; }
    for (const r of rows) {
      const h = r.hash || rowHash(r);
      if (seen.has(h)) continue;
      seen.add(h);
      if (r.kind === 'withdraw') {
        try { onWithdraw(r.guest, r); } catch (e) { if (log && log.warn) log.warn(`[guest-withdrawal] apply ${r.guest}: ${e && e.message}`); }
      }
    }
  };
  let watcher = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    watcher = fs.watch(path.dirname(file), (ev, name) => { if (!name || name === path.basename(file)) scan(); });
    if (watcher.unref) watcher.unref();
    watcher.on('error', () => {});
  } catch (_) { watcher = null; }
  const timer = setInterval(scan, pollMs);
  if (timer.unref) timer.unref();
  return { scan, close() { clearInterval(timer); if (watcher) try { watcher.close(); } catch (_) {} } };
}

module.exports = {
  LOG_VERSION, KINDS, CHANNELS, DEFAULT_FALLBACK_EMAIL,
  defaultPaths, validGuestId,
  tokenInput, makeToken, verifyToken, publicIdOf,
  readLog, holdState, withdraw, reconsent, publicView, rowHash,
  guestRecord, tokenEpochOf, contactEmail, guestByEmail, checkLink,
  parseWithdrawSubject, looksLikeWithdrawal, authVerified, decideEmail,
  readOutbox, pendingConfirmations, confirmationText, queueConfirmation, queueOperatorNote,
  markOutbox, flushOutbox, outboxHealth,
  watchWithdrawals,
};
