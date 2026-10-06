'use strict';

/**
 * Transactional mail for the radio — the customer side of the ad business.
 *
 * The first real ad sold on 2026-08-23 and the buyer got NOTHING: no receipt,
 * no confirmation, and no word when it was reviewed. The operator got nothing
 * either, so a paid spot sat in the approval inbox unnoticed. This module is
 * the missing half of that loop.
 *
 * The SMTP conversation is ported from ninja-portal's portal.js — same style
 * (against the wire, no dependency). The parts that are easy to get subtly
 * wrong are kept explicit: replies can be MULTI-LINE and only the line whose
 * code is followed by a SPACE is the last one; every line ends CRLF, not LF;
 * and a body line beginning with `.` must be doubled or it ends the message
 * early.
 *
 * ⚠ The SMTP client is correct; the RELAY behind it was not. This was written
 * believing the shared Zoho account "had been delivering Constellation Pass
 * mail for weeks" — inferred from a comment, never checked against a real
 * inbox. On 2026-08-24 a search of the recipient's mailbox found NOTHING from
 * that relay had ever arrived: it answered `250 Message received` every time,
 * filed each message in its own Sent folder, and delivered none of them. Hence
 * a second transport, and hence the logging below. An accepted message is not
 * a delivered one, and only the recipient's mailbox settles it.
 *
 * Configuration (all optional):
 *   RESEND_API_KEY                                   preferred transport
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS   the relay (fallback)
 *   MAIL_FROM                                        e.g. 'Kannaka <nick@…>'
 *   RADIO_OPERATOR_EMAIL                             who reviews spots
 *
 * Transports are tried in order until one succeeds, and the one that carried
 * the message is logged. With neither configured the whole module is a silent
 * no-op.
 *
 * Mail is a courtesy layer over a money path that must not depend on it.
 * Nothing here throws into a webhook or an airing decision — every send is
 * best-effort and failures are logged, never propagated.
 */

const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

const SMTP_TIMEOUT_MS = 20000;

/** `Kannaka <nick@…>` → `nick@…`; SMTP envelopes take the bare address. */
function bareAddr(s) {
  const m = String(s).match(/<([^>]+)>/);
  return (m ? m[1] : String(s)).trim();
}

/** RFC 2047-encode a header value only when it isn't plain ASCII, so a subject
 *  with an em dash doesn't arrive as mojibake. */
function encodeHeader(value) {
  const s = String(value);
  return /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s).toString('base64') + '?=';
}

/** One SMTP conversation, over implicit TLS (465) or STARTTLS (anything else). */
function smtpSend({ host, port, user, pass, from, to, subject, text }) {
  const implicitTls = Number(port) === 465;

  return new Promise((resolve, reject) => {
    let sock = implicitTls
      ? tls.connect({ host, port: Number(port), servername: host })
      : net.connect({ host, port: Number(port) });

    let buf = '';
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* already gone */ }
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => finish(new Error('smtp timeout')), SMTP_TIMEOUT_MS);
    if (timer.unref) timer.unref();

    let steps = [];
    let awaiting = null;
    const send = (line) => sock.write(line + '\r\n');
    const expect = (codes, next) => { awaiting = { codes, next }; };

    const onReply = (code, lines) => {
      if (!awaiting) return;
      const { codes, next } = awaiting;
      if (!codes.includes(code)) return finish(new Error(`smtp ${code}: ${lines.join(' ').slice(0, 200)}`));
      awaiting = null;
      next(lines);
    };

    const attach = () => {
      sock.setEncoding('utf8');
      sock.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          steps.push(line);
          // `250-EXTENSION` continues; `250 OK` terminates. Treating every line
          // as final is the classic way to desynchronise a session.
          if (/^\d{3} /.test(line)) {
            const code = Number(line.slice(0, 3));
            const lines = steps;
            steps = [];
            onReply(code, lines);
          }
        }
      });
      sock.on('error', finish);
      sock.on('close', () => finish(done ? null : new Error('smtp closed early')));
    };
    attach();

    const sendMessage = () => {
      send(`MAIL FROM:<${bareAddr(from)}>`);
      expect([250], () => {
        send(`RCPT TO:<${bareAddr(to)}>`);
        expect([250, 251], () => {
          send('DATA');
          expect([354], () => {
            const body = String(text)
              .replace(/\r?\n/g, '\r\n')
              .replace(/^\./gm, '..'); // dot-stuffing
            const headers = [
              `From: ${from}`,
              `To: ${to}`,
              `Subject: ${encodeHeader(subject)}`,
              `Date: ${new Date().toUTCString()}`,
              `Message-ID: <${crypto.randomUUID()}@${bareAddr(from).split('@')[1] || 'ninja-portal.com'}>`,
              'MIME-Version: 1.0',
              'Content-Type: text/plain; charset=UTF-8',
              'Content-Transfer-Encoding: 8bit',
            ].join('\r\n');
            sock.write(headers + '\r\n\r\n' + body + '\r\n.\r\n');
            expect([250], () => { send('QUIT'); clearTimeout(timer); finish(null); });
          });
        });
      });
    };

    const authenticate = () => {
      if (!user) return sendMessage();
      // AUTH PLAIN in one shot: \0user\0pass, base64. LOGIN is the fallback for
      // servers that advertise only it.
      send('AUTH PLAIN ' + Buffer.from(`\0${user}\0${pass}`).toString('base64'));
      awaiting = {
        codes: [235, 334, 500, 502, 504, 535],
        next: (lines) => {
          const code = Number(String(lines[lines.length - 1]).slice(0, 3));
          if (code === 235) return sendMessage();
          if (code === 535) return finish(new Error('smtp auth rejected (535)'));
          send('AUTH LOGIN');
          expect([334], () => {
            send(Buffer.from(user).toString('base64'));
            expect([334], () => {
              send(Buffer.from(pass).toString('base64'));
              expect([235], sendMessage);
            });
          });
        },
      };
    };

    const greet = () => {
      send('EHLO radio.ninja-portal.com');
      expect([250], (lines) => {
        if (implicitTls) return authenticate();
        const offersStartTls = lines.some((l) => /STARTTLS/i.test(l));
        if (!offersStartTls) {
          // Refuse rather than send a password in clear. A relay that cannot do
          // TLS is a misconfiguration, not a fallback.
          if (user) return finish(new Error('smtp server does not offer STARTTLS; refusing to send credentials in clear'));
          return authenticate();
        }
        send('STARTTLS');
        expect([220], () => {
          const plain = sock;
          plain.removeAllListeners('data');
          plain.removeAllListeners('error');
          plain.removeAllListeners('close');
          sock = tls.connect({ socket: plain, servername: host }, () => {
            buf = ''; steps = []; awaiting = null;
            attach();
            send('EHLO radio.ninja-portal.com');
            expect([250], authenticate);
          });
          sock.on('error', finish);
        });
      });
    };

    // The server speaks first.
    expect([220], greet);
  });
}

class Mailer {
  /**
   * @param {object} opts
   * @param {object} [opts.env]  environment to read config from (injectable for tests)
   * @param {Function} [opts.send]  transport override — ({from,to,subject,text}) => Promise
   * @param {Function} [opts.logger]
   */
  constructor(opts = {}) {
    const env = opts.env || process.env;
    this.host = env.SMTP_HOST || null;
    this.port = env.SMTP_PORT || 587;
    this.user = env.SMTP_USER || null;
    this.pass = env.SMTP_PASS || null;
    this.from = env.MAIL_FROM || 'Kannaka Radio <nick@spacechild.love>';
    this.operator = env.RADIO_OPERATOR_EMAIL || null;
    this.siteOrigin = env.RADIO_SITE_ORIGIN || 'https://radio.ninja-portal.com';
    this.kaxOrigin = env.KAX_LEDGER_BASE || 'https://kax.ninja-portal.com';
    this.resendKey = env.RESEND_API_KEY || null;
    this._sendOverride = opts.send || null;
    this._log = opts.logger || ((msg) => console.log(msg));
    this._fetch = opts.fetch || ((...a) => fetch(...a));
    this._smtp = opts.smtp || smtpSend; // injectable so tests need no socket
    this.sent = []; // last-N record, for /api/ads/health style introspection
  }

  configured() { return !!(this._sendOverride || this.resendKey || this.host); }

  /**
   * The transports to try, in order, each as { name, send }.
   *
   * Resend goes FIRST when it is configured. That is not a preference, it is
   * evidence: on 2026-08-23/24 the Zoho relay answered `250 Message received`
   * for every message and delivered none of them — they landed in its Sent
   * folder and never reached the recipient. A transport that reports success
   * and drops the mail is worse than one that fails loudly, so the API path
   * (which returns an id we could chase) leads, and SMTP stands behind it.
   */
  _transports() {
    const t = [];
    if (this._sendOverride) t.push({ name: 'override', send: (m) => this._sendOverride(m) });
    if (this.resendKey) t.push({ name: 'resend', send: (m) => this._resendSend(m) });
    if (this.host) {
      t.push({
        name: 'smtp',
        send: (m) => this._smtp({ host: this.host, port: this.port, user: this.user, pass: this.pass, ...m }),
      });
    }
    return t;
  }

  /** Resend's HTTPS API. No SDK, same as the Stripe client in this codebase. */
  async _resendSend({ from, to, subject, text }) {
    const r = await this._fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.resendKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text }),
    });
    if (!r || !r.ok) {
      const body = r && r.text ? await r.text().catch(() => '') : '';
      throw new Error(`resend ${r && r.status}${body ? ': ' + String(body).slice(0, 200) : ''}`);
    }
    return r.json ? r.json().catch(() => ({})) : {};
  }

  /**
   * Deliver one message, trying each configured transport until one works.
   * NEVER throws — returns true/false. Mail is a courtesy layer over a money
   * path; a dead relay must not roll back a recorded payment or block an
   * airing. Which transport actually carried it is LOGGED, because "did it
   * send?" turned out to be unanswerable after the fact and that is how a
   * silent relay went unnoticed for weeks.
   */
  async send({ to, subject, text }) {
    if (!to || !this.configured()) return false;
    const msg = { from: this.from, to, subject, text };
    const errors = [];
    for (const t of this._transports()) {
      try {
        await t.send(msg);
        this.sent.push({ to, subject, via: t.name, at: new Date().toISOString() });
        if (this.sent.length > 50) this.sent.shift();
        this._log(`[mail] sent "${subject}" to ${to} via ${t.name}`);
        return true;
      } catch (e) {
        errors.push(`${t.name}: ${e && e.message}`);
        // Keep going — the next transport may be healthy. Only report failure
        // once every one of them has been tried.
      }
    }
    this._log(`[mail] could not send "${subject}" to ${to} — ${errors.join('; ') || 'no transport configured'}`);
    return false;
  }

  // ── The four moments a radio advertiser should hear from us ──

  /** Paid. The spot is bought but NOT yet airing — say so plainly, because the
   *  gap between paying and hearing yourself on air is where a buyer starts to
   *  wonder whether anything happened at all. */
  async adPurchased(to, { adId, band, runDays }) {
    return this.send({
      to,
      subject: 'Your Kannaka Radio spot is booked',
      text:
        `Thanks — your spot is paid for and booked.\n\n` +
        `  Reference:  ${adId}\n` +
        `  Time slot:  ${bandLabel(band)}\n` +
        `  Run:        once a day for ${runDays} days\n\n` +
        `What happens next: a human listens to it before it airs, usually within\n` +
        `a day. You'll get another note the moment it's approved and scheduled.\n\n` +
        `If it isn't approved you're refunded in full. Once it's approved, your\n` +
        `free month of Ghost Signals Analytics unlocks:\n` +
        `  ${this.siteOrigin}/analytics\n\n` +
        `Listen live: ${this.siteOrigin}\n`,
    });
  }

  /** Approved and scheduled. */
  async adApproved(to, { adId, band, runDays, startDate }) {
    return this.send({
      to,
      subject: "Your spot is approved and scheduled",
      text:
        `Your spot has been approved and is scheduled.\n\n` +
        `  Reference:  ${adId}\n` +
        `  Time slot:  ${bandLabel(band)}\n` +
        `  Starting:   ${startDate || 'today'}\n` +
        `  Run:        once a day for ${runDays} days\n\n` +
        `Kannaka reads it herself, in the slot you picked. Tune in:\n` +
        `  ${this.siteOrigin}\n\n` +
        `Your free month of Ghost Signals Analytics is ready too — bring us a\n` +
        `CSV and we'll tell you what's actually moving in it. This link opens it\n` +
        `already unlocked:\n` +
        `  ${this.siteOrigin}/analytics?ad=${encodeURIComponent(adId)}\n\n` +
        `(If you ever need to unlock it by hand, the reference above IS the ad id\n` +
        `the page asks for.)\n`,
    });
  }

  /** Rejected → refunded in full. Say the money is already moving; that is the
   *  only sentence that matters to someone being told no. */
  async adRejected(to, { adId, reason }) {
    return this.send({
      to,
      subject: 'Your Kannaka Radio spot — refunded in full',
      text:
        `We couldn't run this one, so you've been refunded in full. Nothing is\n` +
        `owed and nothing aired.\n\n` +
        `  Reference:  ${adId}\n` +
        (reason ? `  Reason:     ${reason}\n` : '') +
        `\nThe refund goes back to the card you paid with; banks usually post it\n` +
        `within a few days.\n\n` +
        `If you'd like to try a different spot, just write another one — happy to\n` +
        `look at it.\n`,
    });
  }

  /** The operator (Nick) — a paid spot is waiting for review. This is the
   *  notification whose absence let the first real sale sit unnoticed. The ad
   *  copy is UNTRUSTED customer text, so it stays in the body and never in the
   *  subject. */
  async operatorReviewNeeded({ adId, band, amountCents, runDays, text }) {
    if (!this.operator) return false;
    return this.send({
      to: this.operator,
      subject: 'Kannaka Radio: a paid spot needs your review',
      text:
        `Someone bought air time and it's waiting on you.\n\n` +
        `  Reference:  ${adId}\n` +
        `  Time slot:  ${bandLabel(band)}\n` +
        `  Paid:       $${((amountCents || 0) / 100).toFixed(2)}\n` +
        `  Run:        once a day for ${runDays} days\n\n` +
        `The spot, as Kannaka will read it:\n\n` +
        indent(String(text || '').trim()) + `\n\n` +
        `Approve or reject it here:\n  ${this.kaxOrigin}/dashboard\n\n` +
        `Rejecting refunds the buyer in full, automatically.\n`,
    });
  }
}

const BAND_LABELS = {
  morning: 'Morning · 6a–12p',
  afternoon: 'Afternoon · 12p–6p',
  evening: 'Evening · 6p–12a',
  late_night: 'Late night · 12a–6a',
};
function bandLabel(band) { return BAND_LABELS[band] || band || 'unscheduled'; }

function indent(s) { return s.split('\n').map((l) => '  | ' + l).join('\n'); }

module.exports = { Mailer, smtpSend, bareAddr, encodeHeader, bandLabel };
