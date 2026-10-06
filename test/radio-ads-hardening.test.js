'use strict';

// radio-ads-hardening.test.js — the 2026-10-06 ads audit, before the first
// real customer. Fake Stripe API, real RadioAdStore on a temp DB.
//   1. an abandoned checkout no longer locks its band for 90 minutes
//   2. the booking mail survives payment_intent.succeeded arriving first
//   3. a failed Stripe refund is returned (409 → KAX retries), not thrown
//   4. an unplayed spot is not confirmed as aired
//   5. listeners are told what /stream plays, not what is queued next

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RadioAdStore } = require('../server/radio-ads');
const { RadioAdPayments } = require('../server/radio-ad-payments');
const { onAirView } = require('../server/lib/on-air-view');

const WHSEC = 'whsec_test_hardening';
const NOWMS = 1_800_000_000_000;
const NOWSEC = Math.floor(NOWMS / 1000);

function fakeApi({ sessionStatus = 'open', refundThrows = false } = {}) {
  const calls = { checkout: [], expire: [], refund: [] };
  const status = {};
  return {
    calls, status,
    async createCheckoutSession(params, idem) {
      const id = 'cs_' + (calls.checkout.length + 1);
      calls.checkout.push({ params, idem });
      status[id] = sessionStatus;
      return { id, url: 'https://checkout.stripe/' + id };
    },
    async retrieveCheckoutSession(id) { return { id, status: status[id] || 'open' }; },
    async expireCheckoutSession(id) { calls.expire.push(id); status[id] = 'expired'; return { id, status: 'expired' }; },
    async createRefund(params, idem) {
      calls.refund.push({ params, idem });
      if (refundThrows) throw new Error('stripe 503');
      return { id: 're_' + calls.refund.length };
    },
    async updatePaymentIntent(id) { return { id }; },
  };
}

function signed(event) {
  const body = JSON.stringify(event);
  const sig = crypto.createHmac('sha256', WHSEC).update(`${NOWSEC}.${body}`, 'utf8').digest('hex');
  return { body, header: `t=${NOWSEC},v1=${sig}` };
}

let failed = 0;
async function run(name, fn) { try { await fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; } }

async function freshStore(tag) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-hard-' + tag + '-'));
  const store = new RadioAdStore({ dbPath: path.join(tmp, 'radio-ads.db'), assetDir: path.join(tmp, 'ads') });
  await store.init();
  return store;
}

(async () => {
  console.log('radio-ads-hardening.test.js');
  const TEXT = 'Visit the Cedar Rapids pie shop on Third Street, open late every night';

  await run('same buyer pressing Buy again gets the slot back (old checkout expired)', async () => {
    const store = await freshStore('rebuy');
    const api = fakeApi();
    const pay = new RadioAdPayments({ store, api, webhookSecret: WHSEC, now: () => Date.now(), bandCapacity: 1 });
    await pay.createCheckout({ text: TEXT, band: 'evening' });
    const second = await pay.createCheckout({ text: TEXT, band: 'evening' });
    assert.ok(second.checkoutUrl, 'second checkout created');
    assert.deepStrictEqual(api.calls.expire, ['cs_1'], 'the abandoned session was expired first');
  });

  await run('a different buyer is still refused while the first checkout is fresh', async () => {
    const store = await freshStore('fresh');
    const api = fakeApi();
    const pay = new RadioAdPayments({ store, api, webhookSecret: WHSEC, now: () => Date.now(), bandCapacity: 1 });
    await pay.createCheckout({ text: TEXT, band: 'evening' });
    await assert.rejects(pay.createCheckout({ text: 'A completely different spot about bicycles', band: 'evening' }), /slot is full/);
    assert.deepStrictEqual(api.calls.expire, []);
  });

  await run('a different buyer gets a band whose checkout sat idle 20 minutes', async () => {
    const store = await freshStore('idle');
    const api = fakeApi();
    const pay = new RadioAdPayments({ store, api, webhookSecret: WHSEC, now: () => Date.now(), bandCapacity: 1 });
    await pay.createCheckout({ text: TEXT, band: 'evening' });
    await store._run(`UPDATE radio_ad_band_holds SET created_at = datetime('now', '-20 minutes')`);
    const second = await pay.createCheckout({ text: 'A completely different spot about bicycles', band: 'evening' });
    assert.ok(second.checkoutUrl);
    assert.deepStrictEqual(api.calls.expire, ['cs_1']);
  });

  await run('a hold whose payment completed is never reclaimed', async () => {
    const store = await freshStore('complete');
    const api = fakeApi({ sessionStatus: 'complete' });
    const pay = new RadioAdPayments({ store, api, webhookSecret: WHSEC, now: () => Date.now(), bandCapacity: 1 });
    await pay.createCheckout({ text: TEXT, band: 'evening' });
    await assert.rejects(pay.createCheckout({ text: TEXT, band: 'evening' }), /slot is full/);
    assert.deepStrictEqual(api.calls.expire, []);
  });

  await run('booking mail still goes out when payment_intent.succeeded lands first', async () => {
    const store = await freshStore('order');
    const api = fakeApi();
    const sent = [];
    const mailer = {
      async adPurchased(to, info) { sent.push(['purchased', to, info.adId]); return true; },
      async operatorReviewNeeded(info) { sent.push(['operator', info.adId]); return true; },
    };
    const pay = new RadioAdPayments({ store, api, webhookSecret: WHSEC, now: () => NOWMS, bandCapacity: 10, mailer });
    const { adId } = await pay.createCheckout({ text: TEXT, band: 'morning' });
    const pi = signed({ id: 'evt_pi', type: 'payment_intent.succeeded', data: { object: { id: 'pi_9', amount_received: 500, currency: 'usd', metadata: { radio_ad_id: adId } } } });
    assert.strictEqual((await pay.handleWebhook(pi.body, pi.header)).status, 200);
    const cs = signed({ id: 'evt_cs', type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid', payment_intent: 'pi_9', amount_total: 500, currency: 'usd', customer_details: { email: 'buyer@example.com' }, metadata: { radio_ad_id: adId } } } });
    assert.strictEqual((await pay.handleWebhook(cs.body, cs.header)).status, 200);
    const again = signed({ id: 'evt_cs2', type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid', payment_intent: 'pi_9', amount_total: 500, currency: 'usd', customer_details: { email: 'buyer@example.com' }, metadata: { radio_ad_id: adId } } } });
    await pay.handleWebhook(again.body, again.header);
    assert.deepStrictEqual(sent, [['operator', adId], ['purchased', 'buyer@example.com', adId]], 'operator once, buyer once');
  });

  await run('a refund Stripe refuses comes back as refund_failed, not a throw', async () => {
    const store = await freshStore('refund');
    const api = fakeApi({ refundThrows: true });
    const pay = new RadioAdPayments({ store, api, webhookSecret: WHSEC, now: () => NOWMS, bandCapacity: 10 });
    const { adId } = await pay.createCheckout({ text: TEXT, band: 'morning' });
    const pi = signed({ id: 'evt_r', type: 'payment_intent.succeeded', data: { object: { id: 'pi_r', amount_received: 500, currency: 'usd', metadata: { radio_ad_id: adId } } } });
    await pay.handleWebhook(pi.body, pi.header);
    await store.rejectAd(adId);
    const r = await pay.refundAd(adId);
    assert.deepStrictEqual(r, { ok: false, error: 'refund_failed' });
    assert.ok(!(await store.getAd(adId)).refunded_at, 'not marked refunded');
  });

  await run('an unplayed sponsor spot is not confirmed as aired', () => {
    const { DJEngine } = require('../server/dj-engine');
    const confirmed = [];
    const eng = Object.create(DJEngine.prototype);
    eng.state = { channel: 'dj', playlist: ['radio-ads/ad_x.mp3', 'a.mp3'], playlistMeta: [], history: [], currentTrackIdx: 0 };
    const spot = { file: 'radio-ads/ad_x.mp3', sponsor: true, sponsorAdId: 'ad_x', sponsorAirDate: '2026-10-06' };
    eng.getCurrentTrack = function () { return this.state.currentTrackIdx === 0 ? spot : { file: 'a.mp3' }; };
    eng._confirmSponsor = (id) => confirmed.push(id);
    eng._promoteQueuedRequest = () => {};
    eng._applySponsorIfCommercial = (t) => t;
    eng._applyGuestIfMusic = (t) => t;
    eng._markPlayed = () => {};
    eng._onTrackChange = () => {};
    try { eng.advanceTrack('radio-ads/ad_x.mp3', { aired: false }); } catch (_) { /* later bookkeeping may need more state */ }
    assert.deepStrictEqual(confirmed, [], 'skipped spot not confirmed');
    eng.state.currentTrackIdx = 0;
    try { eng.advanceTrack('radio-ads/ad_x.mp3'); } catch (_) {}
    assert.deepStrictEqual(confirmed, ['ad_x'], 'a played spot still confirms');
  });

  await run('on-air view: a show loaded mid-song is "up next" until it airs', () => {
    const song = { file: 'One More Life/One Shot v2.mp3', title: 'One Shot v2' };
    const show = { file: 'Ghost Signals Podcast/GSP-011.mp3', title: '[PODCAST] GSP-011' };
    assert.deepStrictEqual(onAirView(show, song), { current: song, upNext: show, swapPending: true });
    assert.deepStrictEqual(onAirView(show, show), { current: show, upNext: null, swapPending: false });
    assert.deepStrictEqual(onAirView(show, null), { current: show, upNext: null, swapPending: false });
  });

  if (failed) { console.error(`\n${failed} failing`); process.exit(1); }
  console.log('\nradio-ads-hardening: all passed');
})();
