'use strict';

/**
 * radio-ad-payments.js — Stripe checkout + webhook + refund for self-serve
 * radio ads (radio-ads design v2, slice 3). Talks to the Stripe REST API over
 * https (no SDK dependency → nothing new to install on O1). The pure logic
 * (signature verify, event classification, form encoding) is in
 * radio-ad-payments-core.js; this file is the I/O + orchestration.
 *
 * Inert until keys are set: with no STRIPE_SECRET_KEY the checkout/refund paths
 * report unconfigured (route → 503) and the station is unaffected; with no
 * STRIPE_WEBHOOK_SECRET the webhook returns 503. Keys live on O1 (slice 6).
 */

const https = require('https');
const {
  PRICE_CENTS, CURRENCY, RUN_DAYS, SIGNATURE_TOLERANCE_SEC,
  checkoutIdempotencyKey, refundIdempotencyKey,
  verifyStripeSignature, classifyWebhookEvent, stripeFormEncode, checkoutSessionParams,
} = require('./radio-ad-payments-core');

/** A minimal Stripe REST client over https. Injectable (see RadioAdPayments
 *  opts.api) so tests never touch the network. */
function makeStripeApi(secretKey) {
  function post(apiPath, params, idempotencyKey) { return request('POST', apiPath, params, idempotencyKey); }
  function request(method, apiPath, params, idempotencyKey) {
    const body = method === 'GET' ? '' : stripeFormEncode(params || {});
    return new Promise((resolve, reject) => {
      const req = https.request({
        method,
        hostname: 'api.stripe.com',
        path: apiPath,
        headers: {
          'Authorization': `Bearer ${secretKey}`,
          ...(method === 'GET' ? {} : {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
          }),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
      }, (res) => {
        let data = '';
        res.on('data', (d) => { data += d; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch { /* non-JSON error body */ }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json || {});
          const msg = (json && json.error && json.error.message) || `stripe ${res.statusCode}`;
          const e = new Error(msg);
          e.statusCode = res.statusCode;
          e.stripeCode = json && json.error && json.error.code;
          reject(e);
        });
      });
      req.on('error', reject);
      req.setTimeout(20000, () => req.destroy(new Error('stripe request timed out')));
      if (body) req.write(body);
      req.end();
    });
  }
  return {
    createCheckoutSession(params, idempotencyKey) { return post('/v1/checkout/sessions', params, idempotencyKey); },
    retrieveCheckoutSession(id) { return request('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}`); },
    expireCheckoutSession(id) { return post(`/v1/checkout/sessions/${encodeURIComponent(id)}/expire`, {}); },
    createRefund(params, idempotencyKey) { return post('/v1/refunds', params, idempotencyKey); },
    // Setting receipt_email on a succeeded PaymentIntent makes Stripe send the
    // buyer its own receipt. No idempotency key: this is a last-write-wins
    // field update, and a replayed webhook writes the same address.
    updatePaymentIntent(id, params) { return post(`/v1/payment_intents/${encodeURIComponent(id)}`, params); },
  };
}

// A checkout untouched this long is treated as abandoned when another buyer
// wants its band (Stripe's own session expiry is 60 min).
const ABANDONED_AFTER_MS = 15 * 60 * 1000;

class RadioAdPayments {
  constructor(opts = {}) {
    this.store = opts.store;
    this._secretKey = opts.secretKey || process.env.STRIPE_SECRET_KEY || null;
    this._webhookSecret = opts.webhookSecret || process.env.STRIPE_WEBHOOK_SECRET || null;
    // Return the buyer to /player, NOT to /. The Air Time widget, the paid/
    // cancelled banner and the analytics unlock all live on the player page;
    // `/` serves door.html, which has none of them. Sending buyers to `/`
    // meant the confirmation was never once shown to a real customer — the
    // page they landed on looked exactly as it had before they paid.
    this.successUrl = opts.successUrl || 'https://radio.ninja-portal.com/player?ad=paid';
    this.cancelUrl = opts.cancelUrl || 'https://radio.ninja-portal.com/player?ad=cancelled';
    this._api = opts.api || null; // injectable Stripe client (tests / DI)
    this._now = opts.now || (() => Date.now());
    // Sponsor slots deliverable per band per day. K=1 (safe/low, review M6): one
    // active ad per band at a time — 4 bands ≈ 4 concurrent slots. Raise only
    // when more daily commercial slots per band are provably deliverable.
    this.bandCapacity = opts.bandCapacity ?? 1;
    // Optional Mailer. Absent (or unconfigured) simply means no mail is sent —
    // the money path never depends on it.
    this.mailer = opts.mailer || null;
  }

  /** True once a secret key is present — the checkout/refund paths are live. */
  configured() { return !!(this._api || this._secretKey); }
  /** True once the webhook secret is present — the webhook can verify. */
  webhookConfigured() { return !!this._webhookSecret; }

  _stripe() {
    if (this._api) return this._api;
    if (!this._secretKey) return null;
    this._api = makeStripeApi(this._secretKey);
    return this._api;
  }

  /**
   * Create a draft ad + a Stripe Checkout Session for it. The draft validates
   * the text/band (throws InvalidAdText). Returns { adId, checkoutUrl }.
   */
  async createCheckout({ text, band, requestedBy = null, runDays = RUN_DAYS } = {}) {
    const api = this._stripe();
    if (!api) { const e = new Error('payments unavailable'); e.code = 'payments_unconfigured'; throw e; }
    const draft = await this.store.createDraft({ text, band, requestedBy, runDays }); // validates
    // Capacity gate (review M6): atomically reserve a band slot or refuse —
    // never sell a spot the band can't deliver. Released on kill/reject/dispute/
    // completion, or swept if never paid.
    let cap = await this.store.reserveBandHold(draft.id, draft.band, this.bandCapacity);
    // An abandoned checkout used to hold the band for up to 90 minutes, so a
    // buyer who backed out of Stripe and pressed Buy again was told their own
    // slot was full. Reclaim holds whose checkout is provably dead, then try once more.
    if (!cap.reserved && await this._reclaimAbandonedHolds(draft)) {
      cap = await this.store.reserveBandHold(draft.id, draft.band, this.bandCapacity);
    }
    if (!cap.reserved) { const e = new Error(`the ${draft.band} slot is full right now — please pick another time slot`); e.code = 'band_full'; throw e; }
    try {
      // 60-min session expiry: bounds how long an abandoned checkout holds the
      // band slot and guarantees no payment lands after the capacity sweep frees
      // it (the sweep grace is 90 min, review M1).
      const expiresAt = Math.floor(this._now() / 1000) + 60 * 60;
      // Carry the ad id back with the buyer. It is their reference for support
      // AND the key that unlocks the free month of analytics, and until this
      // was added the only place it appeared was our own database — so the
      // analytics page asked returning customers for an "ad id" they had never
      // once been shown.
      const successUrl = this.successUrl + (this.successUrl.includes('?') ? '&' : '?') + 'ref=' + encodeURIComponent(draft.id);
      const params = checkoutSessionParams({ adId: draft.id, band: draft.band, successUrl, cancelUrl: this.cancelUrl, runDays, expiresAt });
      const session = await api.createCheckoutSession(params, checkoutIdempotencyKey(draft.id));
      if (session && session.id) await this.store.attachCheckout(draft.id, session.id);
      return { adId: draft.id, checkoutUrl: session && session.url, sessionId: session && session.id };
    } catch (e) {
      await this.store.releaseBandHold(draft.id).catch(() => {}); // Stripe failed → free the slot
      throw e;
    }
  }

  /**
   * Free unpaid holds in this draft's band whose checkout can no longer pay:
   * the same spot text (the same buyer pressing Buy again), or a checkout idle
   * past ABANDONED_AFTER_MS. Each is released only once Stripe shows its
   * session can't complete: already expired, or open and expired by us now.
   * A 'complete' session means a payment is landing, so that hold stays.
   * Returns true if anything was freed.
   */
  async _reclaimAbandonedHolds(draft) {
    const api = this._stripe();
    if (!api || !api.retrieveCheckoutSession || !this.store.unpaidHoldsInBand) return false;
    let freed = false;
    const rows = await this.store.unpaidHoldsInBand(draft.band).catch(() => []);
    for (const h of rows) {
      if (h.ad_id === draft.id) continue;
      const createdMs = Date.parse(String(h.created_at).replace(' ', 'T') + 'Z');
      const idle = Number.isFinite(createdMs) && this._now() - createdMs > ABANDONED_AFTER_MS;
      if (h.content_hash !== draft.contentHash && !idle) continue;
      try {
        if (h.stripe_session_id) {
          const s = await api.retrieveCheckoutSession(h.stripe_session_id);
          if (s.status === 'complete') continue;
          if (s.status === 'open') await api.expireCheckoutSession(h.stripe_session_id);
        } else if (!idle) {
          // No session yet: a concurrent click still creating one. Freeing it
          // now could leave two payable checkouts for one slot.
          continue;
        }
        await this.store.releaseBandHold(h.ad_id);
        console.log(`[ads] reclaimed abandoned ${draft.band} hold ${h.ad_id} for ${draft.id}`);
        freed = true;
      } catch (e) {
        console.warn(`[ads] could not reclaim hold ${h.ad_id}: ${e.message}`);
      }
    }
    return freed;
  }

  /**
   * Handle a raw Stripe webhook. Verifies the signature over the RAW body (never
   * the parsed JSON), then marks the ad paid — idempotently, so a duplicate
   * delivery or the 2nd settlement path (both event types) can't double-apply.
   * Returns { status, body } for the route to send.
   */
  async handleWebhook(rawBody, sigHeader) {
    if (!this._webhookSecret) return { status: 503, body: { error: 'webhook unconfigured' } };
    const nowSec = Math.floor(this._now() / 1000);
    if (!verifyStripeSignature(rawBody, sigHeader, this._webhookSecret, nowSec, SIGNATURE_TOLERANCE_SEC)) {
      return { status: 400, body: { error: 'invalid signature' } };
    }
    let event;
    try { event = JSON.parse(rawBody); } catch { return { status: 400, body: { error: 'bad json' } }; }
    const c = classifyWebhookEvent(event);
    if (c.kind === 'paid' && c.adId) {
      // Amount + currency MUST match our server-set price before we honor a
      // paid event — the sole guard against a mispriced/foreign-currency charge.
      // A mismatch is definitive (retrying won't change it): acknowledge (200)
      // so Stripe stops redelivering, but do NOT mark paid.
      if (c.amountCents !== PRICE_CENTS || c.currency !== CURRENCY) {
        // A real customer may have been charged for nothing: never quietly.
        console.error(`[ads] PAID EVENT IGNORED for ${c.adId}: ${c.amountCents} ${c.currency} != ${PRICE_CENTS} ${CURRENCY} — charged but not booked; refund or book by hand`);
        return { status: 200, body: { received: true, ignored: 'amount_or_currency_mismatch' } };
      }
      // Whether this event brings the buyer's address for the first time
      // (payment_intent.succeeded carries none and may land first).
      const before = await this.store.getAd(c.adId).catch(() => null);
      const emailIsNew = !!(c.customerEmail && before && !before.customer_email);
      let r;
      try {
        r = await this.store.markPaid(c.adId, { sessionId: c.sessionId, paymentIntent: c.paymentIntent, amountCents: c.amountCents, customerEmail: c.customerEmail });
      } catch (e) {
        // Transient store error → 500 so Stripe RETRIES; a dropped paid signal
        // would be an unrecorded charge.
        return { status: 500, body: { error: 'could not record payment' } };
      }
      // A paid event for an ad we can't find yet → 500 so Stripe redelivers
      // (this slice has no reconciliation sweep to recover a dropped signal).
      // A terminal-state no-op (already refunded/killed/completed) → 200.
      if (!r.ok && r.reason === 'not_found') return { status: 500, body: { error: 'ad not found — will retry' } };
      // Hand Stripe the buyer's address so it sends its own receipt — the only
      // confirmation the buyer gets at this point, since the spot is still
      // awaiting operator review and nothing has aired yet. STRICTLY
      // best-effort: a receipt is cosmetic, the payment is already recorded,
      // and throwing here would turn a missing email into an endless Stripe
      // webhook retry against an idempotent markPaid.
      if (c.customerEmail && c.paymentIntent) {
        try {
          const api = this._stripe();
          if (api && api.updatePaymentIntent) {
            await api.updatePaymentIntent(c.paymentIntent, { receipt_email: c.customerEmail });
          }
        } catch (e) { /* no receipt — the money path is unaffected */ }
      }
      // Tell both humans. Only on the FIRST application of this payment
      // (`r.already` means a replayed webhook), so Stripe redelivering an event
      // can't mail the same person twice. Both sends swallow their own errors.
      if (this.mailer && r && r.ok && !r.already) {
        const ad = await this.store.getAd(c.adId).catch(() => null);
        if (ad) {
          if (ad.customer_email) {
            await this.mailer.adPurchased(ad.customer_email, { adId: ad.id, band: ad.band, runDays: ad.run_days });
          }
          await this.mailer.operatorReviewNeeded({ adId: ad.id, band: ad.band, amountCents: ad.amount_cents, runDays: ad.run_days, text: ad.text });
        }
      } else if (this.mailer && r && r.ok && r.already && emailIsNew) {
        // The payment was first recorded from an event with no address, so
        // the buyer's booking mail was skipped then. This event brings the
        // address: send it now (once — the address is write-once).
        const ad = await this.store.getAd(c.adId).catch(() => null);
        if (ad && ad.customer_email) {
          await this.mailer.adPurchased(ad.customer_email, { adId: ad.id, band: ad.band, runDays: ad.run_days });
        }
      }
    }
    if (c.kind === 'disputed' && c.paymentIntent) {
      // A chargeback: stop airing, mark disputed. Issue NO refund (the dispute
      // moves the funds; review B2). Idempotent via disputed_at.
      try {
        await this.store.markDisputed(c.paymentIntent, c.disputeId);
      } catch (e) {
        return { status: 500, body: { error: 'could not record dispute' } };
      }
    }
    return { status: 200, body: { received: true } };
  }

  /**
   * Refund an ad's charge — confirmed-BEFORE-marked: create the Stripe refund
   * first, mark the row refunded only after Stripe confirms, so a failed refund
   * never shows the customer as refunded when they were not. Idempotent via the
   * refund idempotency key + the row's refunded_at guard.
   */
  async refundAd(adId) {
    const ad = await this.store.getAd(adId);
    if (!ad) return { ok: false, error: 'not_found' };
    if (ad.refunded_at) return { ok: true, alreadyRefunded: true, refundId: ad.stripe_refund_id };
    // NEVER refund a disputed charge — the dispute process moves the funds, so
    // refunding on top is a double-pay (review B2). Belt-and-suspenders with the
    // status guards below.
    if (ad.disputed_at) return { ok: false, error: 'disputed' };
    if (!ad.stripe_payment_intent) return { ok: false, error: 'no_payment_to_refund' };
    // Guard the refundable STATE before touching Stripe: a stray/replayed enact
    // on a live ad must not issue a real refund while it keeps airing.
    if (!['paid', 'rejected', 'killed'].includes(ad.status)) {
      return { ok: false, error: `not_refundable_from:${ad.status}` };
    }
    const api = this._stripe();
    if (!api) return { ok: false, error: 'payments_unconfigured' };
    if (ad.status === 'killed') {
      // PARTIAL (pro-rata) refund of the amount FROZEN at kill time (review
      // B1/B3): same idempotency key + same amount on a re-drive = a true Stripe
      // idempotent replay. Status stays 'killed' (it aired part of the run).
      const amount = ad.refund_amount_cents == null ? 0 : ad.refund_amount_cents;
      if (amount > 0) {
        let refund;
        try {
          refund = await api.createRefund({ payment_intent: ad.stripe_payment_intent, amount }, refundIdempotencyKey(adId));
        } catch (e) {
          // Returned, not thrown: the bridge answers 409 so KAX retries. A
          // throw became a silent 500 with the customer's refund unissued.
          console.error(`[ads] partial refund FAILED for ${adId} (${amount}c): ${e.message} — will retry on re-drive`);
          return { ok: false, error: 'refund_failed' };
        }
        await this.store.markKillRefunded(adId, refund && refund.id);
        return { ok: true, refundId: refund && refund.id, amountCents: amount, partial: true };
      }
      // Fully aired → nothing to refund (Stripe rejects a 0-cent refund); record
      // it so the enact doesn't 409-loop.
      await this.store.markKillRefunded(adId, null);
      return { ok: true, refundId: null, amountCents: 0, partial: true };
    }
    // paid / rejected → FULL refund (the ad never aired).
    let refund;
    try {
      refund = await api.createRefund({ payment_intent: ad.stripe_payment_intent }, refundIdempotencyKey(adId));
    } catch (e) {
      console.error(`[ads] refund FAILED for ${adId}: ${e.message} — will retry on re-drive`);
      return { ok: false, error: 'refund_failed' };
    }
    await this.store.markRefunded(adId, refund && refund.id);
    return { ok: true, refundId: refund && refund.id };
  }
}

module.exports = { RadioAdPayments, makeStripeApi, PRICE_CENTS, CURRENCY };
