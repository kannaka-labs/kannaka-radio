#!/usr/bin/env node
'use strict';
/**
 * guest-withdraw.js — the operator's and the inbox's side of guest
 * withdrawal (#443, server/guest-withdrawal.js). Prints JSON.
 *
 *   link <guest>                      the guest's withdrawal URL (needs
 *                                     GUEST_WITHDRAW_SECRET; never prints it)
 *   withdraw <guest> --channel link|email|mastodon|operator
 *            [--from <who>] [--request-id <id>] [--note <text>] [--verified]
 *            [--in-reply-to <Message-ID>]
 *   email --from <addr> --subject <s> [--body-file <f>]
 *         [--auth-results-file <f>] [--message-id <id>]
 *                                     decide an inbound e-mail and apply it
 *                                     (kannaka-inbox.py calls this FIRST,
 *                                     before any auto-reply)
 *   reconsent <guest> --evidence <Message-ID or status URL>
 *   status                            latest row per guest + pending confirmations
 *   outbox                            confirmations not yet sent
 *   mark <outboxId> sent|failed [--via <how>] [--error <text>]
 *
 * Files: <base>/workspace/guest-withdrawals.jsonl and
 * guest-withdraw-outbox.jsonl (env GUEST_WITHDRAWALS_FILE /
 * GUEST_WITHDRAW_OUTBOX_FILE), consent file per server/guest-consent.js.
 * <base> is KANNAKA_RADIO_BASE_DIR or this repo.
 *
 * The running radio watches the log, so a withdrawal written here takes the
 * guest off the air within ~5 s; no route, no restart.
 */

const fs = require('fs');
const path = require('path');
const gw = require('../server/guest-withdrawal');
const gc = require('../server/guest-consent');

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (k === 'verified') { opt.verified = true; continue; }
      opt[k] = argv[i + 1];
      i++;
    } else pos.push(a);
  }
  return { pos, opt };
}

function paths(env = process.env) {
  const base = env.KANNAKA_RADIO_BASE_DIR || path.join(__dirname, '..');
  return { ...gc.defaultPaths(base, env), ...gw.defaultPaths(base, env) };
}

function readFileOpt(f) {
  if (!f) return '';
  return fs.readFileSync(f, 'utf8');
}

/** Authentication-Results values, one per line in the file (as the inbox wrote them). */
function authLines(f) {
  return readFileOpt(f).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function run(argv, env = process.env, out = (o) => console.log(JSON.stringify(o, null, 2))) {
  const { pos, opt } = parseArgs(argv);
  const cmd = pos[0];
  const P = paths(env);
  const secret = env.GUEST_WITHDRAW_SECRET || '';
  const origin = (env.RADIO_PUBLIC_URL || 'https://radio.ninja-portal.com').replace(/\/+$/, '');
  const fallbackEmail = env.GUEST_WITHDRAW_EMAIL || gw.DEFAULT_FALLBACK_EMAIL;

  // sender "inbox": kannaka-inbox.py sends it (threaded, as the station's
  // address) and marks it sent; the running radio leaves it alone.
  const confirm = (guest, row, channel, inReplyTo, sender = 'server') => {
    const rec = gw.guestRecord(P.consentFile, guest);
    try {
      return gw.queueConfirmation(P.outboxFile, { guest, record: rec, row, channel, siteOrigin: origin, fallbackEmail, inReplyTo: inReplyTo || null, sender });
    } catch (e) { return { queued: false, reason: e.message }; }
  };

  switch (cmd) {
    case 'link': {
      const guest = pos[1];
      if (!secret) return out({ ok: false, error: 'GUEST_WITHDRAW_SECRET is not set (it lives in the radio EnvironmentFile; systemctl show does not print it)' }), 2;
      const rec = gw.guestRecord(P.consentFile, guest);
      if (!rec) return out({ ok: false, error: `no guest "${guest}" in ${P.consentFile}` }), 2;
      const t = gw.makeToken(secret, guest, gw.tokenEpochOf(rec));
      return out({ ok: true, guest, tokenEpoch: gw.tokenEpochOf(rec), url: `${origin}/guest/withdraw?g=${encodeURIComponent(guest)}&t=${t}`,
        publicId: gw.publicIdOf(secret, guest) }), 0;
    }
    case 'withdraw': {
      const guest = pos[1];
      const r = gw.withdraw(P.withdrawalsFile, {
        guest, channel: opt.channel, verified: opt.verified === true, from: opt.from || null,
        requestId: opt['request-id'] || null, note: opt.note || null, secret,
      });
      const res = { ok: true, guest, created: !!r.created, already: !!r.already, duplicate: !!r.duplicate, at: r.row && r.row.at, hash: r.row && gw.rowHash(r.row) };
      if (r.created) res.confirmation = confirm(guest, r.row, opt.channel, opt['in-reply-to']);
      return out(res), 0;
    }
    case 'email': {
      const d = gw.decideEmail({
        consentFile: P.consentFile, from: opt.from, subject: opt.subject, body: readFileOpt(opt['body-file']),
        authResults: authLines(opt['auth-results-file']), authservId: env.GUEST_WITHDRAW_AUTHSERV_ID || undefined,
      });
      const res = { ok: true, action: d.action, guest: d.guest || null, verified: !!d.verified, reason: d.reason };
      if (d.action === 'withdraw') {
        const r = gw.withdraw(P.withdrawalsFile, {
          guest: d.guest, channel: 'email', verified: d.verified, from: opt.from || null,
          requestId: opt['message-id'] || null, note: d.reason, secret,
        });
        Object.assign(res, { created: !!r.created, already: !!r.already, duplicate: !!r.duplicate, at: r.row && r.row.at, hash: r.row && gw.rowHash(r.row) });
        if (r.created) res.confirmation = confirm(d.guest, r.row, 'email', opt['message-id'], 'inbox');
      }
      if (d.notifyOperator) {
        res.operatorNote = gw.queueOperatorNote(P.outboxFile, {
          to: env.RADIO_OPERATOR_EMAIL || null,
          sender: 'inbox',
          subject: `[radio] guest withdrawal needs a look: ${d.reason}`,
          body: `From: ${opt.from}\nSubject: ${opt.subject}\nMessage-ID: ${opt['message-id'] || '(none)'}\nDecision: ${d.action}${d.guest ? ` (${d.guest})` : ''}, verified=${!!d.verified}\nReason: ${d.reason}\n\nHeld anyway when a guest was named or matched: holding is the safe side. Re-consent only with evidence: scripts/guest-withdraw.js reconsent <guest> --evidence <id>.`,
        });
      }
      return out(res), 0;
    }
    case 'reconsent': {
      const guest = pos[1];
      const r = gw.reconsent(P.withdrawalsFile, { guest, evidence: opt.evidence, by: opt.by || 'operator', secret });
      return out({ ok: true, guest, created: !!r.created, notWithdrawn: !!r.already, at: r.row && r.row.at }), 0;
    }
    case 'status': {
      const l = gw.readLog(P.withdrawalsFile);
      const latest = {};
      for (const r of l.rows) latest[r.guest] = { kind: r.kind, at: r.at, channel: r.channel, verified: r.verified };
      return out({ ok: l.ok, malformedLines: l.bad, guests: latest, confirmations: gw.outboxHealth(P.outboxFile) }), l.ok ? 0 : 1;
    }
    case 'outbox':
      return out({ ok: true, pending: gw.pendingConfirmations(P.outboxFile) }), 0;
    case 'mark': {
      gw.markOutbox(P.outboxFile, pos[1], pos[2], { via: opt.via || null, error: opt.error || null });
      return out({ ok: true, id: pos[1], event: pos[2] }), 0;
    }
    default:
      out({ ok: false, error: 'usage: guest-withdraw.js link|withdraw|email|reconsent|status|outbox|mark … (see the header of this file)' });
      return 2;
  }
}

if (require.main === module) {
  let code = 1;
  try { code = run(process.argv.slice(2)); }
  catch (e) { console.log(JSON.stringify({ ok: false, error: e && e.message })); code = 1; }
  process.exit(code);
}

module.exports = { run, parseArgs };
