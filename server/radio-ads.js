'use strict';

/**
 * radio-ads.js — durable store + airing ledger for self-serve radio ads
 * (KAX radio-ads design v2, slice 2).
 *
 * SQLite (async sqlite3, the same lib the GhostSignals hub uses), its own
 * file under KANNAKA_DATA_DIR. Two tables:
 *   - radio_ads: the ad + its run state (band, run days, airings_done, …).
 *   - radio_ad_airings: a per-(ad, station-day) ledger row, UNIQUE(ad_id,
 *     air_date). Inserting it BEFORE the audio plays is the atomic
 *     check-and-set that makes "once per day" survive a restart: a re-air on
 *     a day already aired fails the unique constraint and is skipped.
 *
 * Callbacks are load-bearing on every db.run (a callback-less run that errors
 * emits an unhandled 'error' that crashes the shared radio process — see the
 * hub). Every write is a single statement; no BEGIN/COMMIT, so the nested-tx
 * crash class (radio #234) can't arise here.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');
const {
  isValidBand, currentBand, stationDay, normalizeAdText, contentHash, airEligible, canTransition,
  sqliteTimestamp,
} = require('./radio-ads-core');

class RadioAdStore {
  constructor(opts = {}) {
    this.dbPath = opts.dbPath || path.join(
      process.env.KANNAKA_DATA_DIR || path.join(os.homedir(), '.kannaka'),
      'radio-ads.db',
    );
    // Where frozen TTS renders live — a subdir of the music dir so the DJ
    // engine can reference them by a music-relative path like commercials.
    this.assetDir = opts.assetDir || null; // set by init() caller
    this.db = null;
  }

  init() {
    return new Promise((resolve, reject) => {
      // Inside the executor so a mkdir failure REJECTS rather than throwing
      // synchronously — index.js only .catch()es a rejection, and a store
      // init failure must never take the station down (issue #155).
      try {
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      } catch (e) { return reject(e); }
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) return reject(err);
        // this.db is set — run the schema/migration/reconcile sequence with the
        // promisified helpers (each await serializes, so no db.serialize needed).
        this._migrate().then(() => resolve(this)).catch(reject);
      });
    });
  }

  /**
   * Create/upgrade the schema, then reconcile the airing ledger.
   *
   * radio_ad_airings is a RESERVE/CONFIRM ledger (the airing-hook design's core
   * money invariant). `aired_at` is NULLABLE:
   *   - NULL      → RESERVED: holds the UNIQUE(ad_id,air_date) once-per-day lock,
   *                 but has NOT aired and advances NO run counter.
   *   - timestamp → CONFIRMED: the spot actually finished on the live stream.
   * Counting at reserve time would let a restart between reserve and broadcast
   * silently burn a paid day; splitting reserve from confirm makes an unaired
   * reservation fully recoverable (boot reconcile below).
   */
  async _migrate() {
    await this._run(`CREATE TABLE IF NOT EXISTS radio_ads (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'draft',
      text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      tts_file TEXT,
      band TEXT NOT NULL,
      run_days INTEGER NOT NULL DEFAULT 7,
      run_start_date TEXT,
      airings_done INTEGER NOT NULL DEFAULT 0,
      last_aired_date TEXT,
      requested_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    // Payment columns (slice 3, Stripe) — added incrementally so an existing DB
    // upgrades in place. ALTER ADD COLUMN is idempotent behind the presence check.
    const adCols = await this._all(`PRAGMA table_info(radio_ads)`);
    const haveCol = new Set(adCols.map((c) => c.name));
    const addCol = async (name, decl) => { if (!haveCol.has(name)) await this._run(`ALTER TABLE radio_ads ADD COLUMN ${name} ${decl}`); };
    await addCol('stripe_session_id', 'TEXT');
    await addCol('stripe_payment_intent', 'TEXT');
    await addCol('amount_cents', 'INTEGER');
    await addCol('paid_at', 'TEXT');
    await addCol('refunded_at', 'TEXT');
    await addCol('stripe_refund_id', 'TEXT');
    // Slice 5: the pro-rata kill refund amount, FROZEN at kill time (write-once)
    // so a re-driven refund is a true Stripe idempotent replay (same key AND
    // same amount) — never a same-key/different-amount 400 (review B1). And the
    // dispute is ORTHOGONAL to status (a dispute can hit any state; review M4).
    await addCol('refund_amount_cents', 'INTEGER');
    await addCol('disputed_at', 'TEXT');
    await addCol('stripe_dispute_id', 'TEXT');
    // The buyer's address, as typed into Stripe Checkout. Stored because the
    // moments worth telling them about — approved, rejected-and-refunded —
    // happen HOURS after checkout, long after the session object is out of
    // reach. Write-once (COALESCE), and never used for anything but mail about
    // this ad.
    await addCol('customer_email', 'TEXT');
    // Fresh DBs get the reserve/confirm shape directly.
    await this._run(`CREATE TABLE IF NOT EXISTS radio_ad_airings (
      ad_id TEXT NOT NULL,
      air_date TEXT NOT NULL,
      reserved_at TEXT NOT NULL DEFAULT (datetime('now')),
      aired_at TEXT,
      PRIMARY KEY (ad_id, air_date)
    )`);
    // Upgrade a pre-reserve/confirm table (aired_at NOT NULL, no reserved_at).
    // sqlite can't drop NOT NULL via ALTER, so rebuild + backfill existing rows
    // as CONFIRMED (they aired under the old count-at-claim model, so aired_at
    // carries their real air time). Idempotent: once reserved_at exists, skip.
    const cols = await this._all(`PRAGMA table_info(radio_ad_airings)`);
    if (!cols.some((c) => c.name === 'reserved_at')) {
      await this._run(`CREATE TABLE radio_ad_airings_new (
        ad_id TEXT NOT NULL, air_date TEXT NOT NULL,
        reserved_at TEXT NOT NULL DEFAULT (datetime('now')),
        aired_at TEXT, PRIMARY KEY (ad_id, air_date))`);
      await this._run(`INSERT INTO radio_ad_airings_new (ad_id, air_date, reserved_at, aired_at)
        SELECT ad_id, air_date, aired_at, aired_at FROM radio_ad_airings`);
      await this._run(`DROP TABLE radio_ad_airings`);
      await this._run(`ALTER TABLE radio_ad_airings_new RENAME TO radio_ad_airings`);
    }
    // Boot reconcile: an unconfirmed reservation is a claim that never became a
    // broadcast (restart between reserve and air). Reserve advanced no counter,
    // so deleting it perfectly restores claimability — no silent lost paid day.
    // Runs before any poller/airing begins.
    await this._run(`DELETE FROM radio_ad_airings WHERE aired_at IS NULL`);

    // Outbox for the radio→KAX approval RAISE (slice 4). UNIQUE(ad_id,kind) is
    // the exactly-once-enqueue backstop: enqueueRaise is an idempotent
    // ON CONFLICT DO NOTHING fired on every paid signal, and a reconcile sweep
    // re-enqueues any paid ad missing its row (review B3). Delivery is
    // at-least-once; KAX dedupes the raise by ad id across all statuses (B4).
    await this._run(`CREATE TABLE IF NOT EXISTS radio_ad_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ad_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error TEXT,
      UNIQUE (ad_id, kind)
    )`);

    // Slice 5 — band capacity holds. A band can air only K sponsor spots/day
    // (the airing hook airs one ad per commercial slot); selling more than the
    // band can deliver starves the newer ad (a paid run that never completes =
    // goods not delivered, review M6). A hold is taken atomically at checkout
    // (a conditional INSERT SQLite serializes) and released on
    // kill/reject/dispute/completion, or swept if never paid.
    await this._run(`CREATE TABLE IF NOT EXISTS radio_ad_band_holds (
      ad_id TEXT PRIMARY KEY,
      band TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      released_at TEXT
    )`);
    // Slice 5 — GSA free-month entitlement, granted on APPROVAL (not payment;
    // a rejected/refunded ad gets no perk), idempotent per ad (review M7).
    await this._run(`CREATE TABLE IF NOT EXISTS radio_ad_gsa_entitlements (
      ad_id TEXT PRIMARY KEY,
      granted_at TEXT NOT NULL DEFAULT (datetime('now')),
      redeem_by TEXT,
      revoked_at TEXT
    )`);
  }

  _run(sql, params = []) { return new Promise((res, rej) => this.db.run(sql, params, function (e) { e ? rej(e) : res(this); })); }
  _get(sql, params = []) { return new Promise((res, rej) => this.db.get(sql, params, (e, row) => (e ? rej(e) : res(row)))); }
  _all(sql, params = []) { return new Promise((res, rej) => this.db.all(sql, params, (e, rows) => (e ? rej(e) : res(rows)))); }

  /**
   * Freeze a rendered temp file to its content-hashed final path ATOMICALLY:
   * copy to a unique .part in the same dir, then rename into place. A rename
   * within one dir is atomic, so a concurrent /audio/ GET never reads a
   * half-written mp3, and a crash mid-copy leaves only a .part (never a
   * partial file that existsSync would then treat as a permanent cache hit).
   * If a concurrent render of the same hash won the race (rename-over-existing
   * throws on Windows; on POSIX it silently replaces with identical bytes),
   * we treat an already-present target as success and drop our copy.
   */
  _freezeAtomic(tmpPath, absPath) {
    const part = `${absPath}.part-${process.pid}-${Date.now()}`;
    fs.copyFileSync(tmpPath, part);
    try {
      fs.renameSync(part, absPath);
    } catch (e) {
      if (fs.existsSync(absPath)) { try { fs.unlinkSync(part); } catch { /* best-effort */ } }
      else { try { fs.unlinkSync(part); } catch { /* best-effort */ } throw e; }
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────

  /** Create a draft ad. Validates + freezes the content hash. Money and the
   *  approval linkage attach in later slices; slice 2 stops at draft. */
  async createDraft({ text, band, requestedBy = null, runDays = 7 }) {
    const clean = normalizeAdText(text); // throws InvalidAdText
    if (!isValidBand(band)) throw new Error(`invalid band "${band}"`);
    const id = 'ad_' + crypto.randomBytes(9).toString('base64url');
    const hash = contentHash(clean);
    await this._run(
      `INSERT INTO radio_ads (id, status, text, content_hash, band, run_days, requested_by) VALUES (?, 'draft', ?, ?, ?, ?, ?)`,
      [id, clean, hash, band, runDays, requestedBy ? String(requestedBy).slice(0, 200) : null],
    );
    return { id, contentHash: hash, text: clean, band };
  }

  getAd(id) { return this._get(`SELECT * FROM radio_ads WHERE id = ?`, [id]); }

  // ── Payments (slice 3) ─────────────────────────────────────

  /** Record the Stripe Checkout Session id on a draft (idempotent). */
  async attachCheckout(id, sessionId) {
    await this._run(
      `UPDATE radio_ads SET stripe_session_id = COALESCE(stripe_session_id, ?), updated_at = datetime('now') WHERE id = ?`,
      [sessionId, id],
    );
  }

  /**
   * Mark an ad PAID from a verified Stripe webhook. Idempotent + race-safe: the
   * draft→paid transition is a CAS (`WHERE status='draft' AND paid_at IS NULL`),
   * so a duplicate delivery or the 2nd settlement path (both event types) can
   * only apply once. Identifiers are backfilled regardless of arrival order
   * (payment_intent.succeeded may land before checkout.session.completed).
   */
  async markPaid(id, { sessionId = null, paymentIntent = null, amountCents = null, customerEmail = null } = {}) {
    const ad = await this.getAd(id);
    if (!ad) return { ok: false, reason: 'not_found' };
    // Backfill whatever identifiers this event carries (either may arrive first).
    // The address is write-once: a replayed webhook must not be able to
    // re-point a paid ad's mail at a different recipient.
    if (customerEmail) await this._run(`UPDATE radio_ads SET customer_email = COALESCE(customer_email, ?) WHERE id = ?`, [customerEmail, id]);
    if (sessionId && !ad.stripe_session_id) await this._run(`UPDATE radio_ads SET stripe_session_id = ? WHERE id = ? AND stripe_session_id IS NULL`, [sessionId, id]);
    if (paymentIntent && !ad.stripe_payment_intent) await this._run(`UPDATE radio_ads SET stripe_payment_intent = ? WHERE id = ? AND stripe_payment_intent IS NULL`, [paymentIntent, id]);
    if (amountCents != null && ad.amount_cents == null) await this._run(`UPDATE radio_ads SET amount_cents = ? WHERE id = ? AND amount_cents IS NULL`, [amountCents, id]);
    if (ad.paid_at) return { ok: true, already: true };
    if (!canTransition(ad.status, 'paid')) return { ok: false, reason: `cannot pay from ${ad.status}` };
    const upd = await this._run(
      `UPDATE radio_ads SET status = 'paid', paid_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'draft' AND paid_at IS NULL`,
      [id],
    );
    return { ok: true, already: !(upd && upd.changes) };
  }

  /**
   * Mark an ad REFUNDED — called only AFTER Stripe confirms the refund
   * (confirmed-before-marked, in radio-ad-payments.js). Idempotent via the
   * refunded_at guard; only a paid/pending/rejected/killed ad is refundable.
   */
  async markRefunded(id, refundId = null) {
    const ad = await this.getAd(id);
    if (!ad) return { ok: false, reason: 'not_found' };
    if (ad.refunded_at) return { ok: true, already: true };
    // Refundable states per AD_TRANSITIONS: paid→refunded, rejected→refunded,
    // killed→refunded. A 'pending' ad (raised for approval) is refunded by
    // first being rejected (pending→rejected→refunded), so it's not listed here.
    const upd = await this._run(
      `UPDATE radio_ads SET status = 'refunded', refunded_at = datetime('now'), stripe_refund_id = COALESCE(?, stripe_refund_id), updated_at = datetime('now') WHERE id = ? AND refunded_at IS NULL AND status IN ('paid','rejected','killed')`,
      [refundId, id],
    );
    if (upd && upd.changes) {
      // A fully-refunded ad loses the GSA free-month perk. (A PARTIAL kill
      // refund — markKillRefunded — deliberately keeps it: they aired.)
      await this._run(`UPDATE radio_ad_gsa_entitlements SET revoked_at = datetime('now') WHERE ad_id = ? AND revoked_at IS NULL`, [id]);
    }
    return { ok: true, already: !(upd && upd.changes) };
  }

  /**
   * Freeze the ad's TTS render and reuse it as BOTH the preview and the
   * airing asset — keyed by content hash so identical text renders once and
   * what airs is exactly what was previewed. Idempotent: an existing file for
   * the hash is reused, never re-rendered.
   *
   * @param voiceDJ shared VoiceDJ (generateTTS(text, cb))
   */
  async renderAd(id, voiceDJ) {
    if (!this.assetDir) throw new Error('radio-ads asset dir not configured');
    const ad = await this.getAd(id);
    if (!ad) throw new Error(`ad ${id} not found`);
    const relPrefix = path.basename(this.assetDir);
    const fileName = `ad_${ad.content_hash}.mp3`;
    const absPath = path.join(this.assetDir, fileName);
    const relFile = path.join(relPrefix, fileName);
    if (fs.existsSync(absPath)) {
      await this._run(`UPDATE radio_ads SET tts_file = ?, updated_at = datetime('now') WHERE id = ?`, [relFile, id]);
      return { file: relFile, cached: true };
    }
    if (!fs.existsSync(this.assetDir)) fs.mkdirSync(this.assetDir, { recursive: true });
    const tmpPath = await new Promise((resolve, reject) => {
      voiceDJ.generateTTS(ad.text, (err, p) => (err || !p ? reject(err || new Error('tts produced no file')) : resolve(p)));
    });
    this._freezeAtomic(tmpPath, absPath);
    try { fs.unlinkSync(tmpPath); } catch { /* tmp cleanup best-effort */ }
    await this._run(`UPDATE radio_ads SET tts_file = ?, updated_at = datetime('now') WHERE id = ?`, [relFile, id]);
    return { file: relFile, cached: false };
  }

  /**
   * Move an approved ad into the scheduled run (this is what the KAX approval
   * handler will call in a later slice; exposed now for the airing tests and
   * the eventual enact callback). Requires a frozen render — an unrendered ad
   * must never be scheduled. Sets run_start_date to today.
   */
  async scheduleAd(id, now = new Date()) {
    const ad = await this.getAd(id);
    if (!ad) throw new Error(`ad ${id} not found`);
    if (!ad.tts_file) throw new Error(`ad ${id} has no rendered audio — render before scheduling`);
    // Idempotent: already scheduled is a no-op success (the enact callback is
    // at-least-once).
    if (ad.status === 'scheduled') return { id, status: 'scheduled', already: true };
    // CHECK upd.changes — an ad not in a schedulable state must NOT report a
    // false success (review B1: the old code returned success unconditionally,
    // so a 'pending'/refunded ad "scheduled" while nothing changed).
    const upd = await this._run(
      `UPDATE radio_ads SET status = 'scheduled', run_start_date = COALESCE(run_start_date, ?), updated_at = datetime('now') WHERE id = ? AND status = 'approved'`,
      [stationDay(now), id],
    );
    if (!upd || upd.changes === 0) throw new Error(`ad ${id} not schedulable from status '${ad.status}'`);
    return { id, status: 'scheduled', already: false };
  }

  /**
   * Enact an operator APPROVAL: drive a paid/pending/approved ad all the way to
   * 'scheduled', idempotently. This is what the KAX enact call invokes. State-
   * tolerant (review M2 — the paid→pending marker is best-effort), and refuses
   * to schedule a terminal (refunded/killed/rejected) ad or an unrendered one.
   * Render happens at PAID time (the bridge reconcile), so by here tts_file is set.
   *
   * Returns { ok, reason?, already? }: ok:false with reason 'terminal'/'not_rendered'
   * → the enact endpoint 409s so the KAX keystone keeps it as needs-action.
   */
  async approveAndSchedule(id, now = new Date()) {
    const ad = await this.getAd(id);
    if (!ad) return { ok: false, reason: 'not_found' };
    if (['scheduled', 'airing', 'completed'].includes(ad.status)) return { ok: true, already: true };
    if (['refunded', 'killed', 'rejected', 'disputed'].includes(ad.status)) return { ok: false, reason: `terminal:${ad.status}` };
    if (!ad.tts_file) return { ok: false, reason: 'not_rendered' }; // render-at-paid hasn't landed yet → retry
    // paid|pending → approved → scheduled (two guarded steps to honor
    // AD_TRANSITIONS; each is idempotent under re-drive).
    await this._run(`UPDATE radio_ads SET status = 'approved', updated_at = datetime('now') WHERE id = ? AND status IN ('paid','pending')`, [id]);
    const upd = await this._run(
      `UPDATE radio_ads SET status = 'scheduled', run_start_date = COALESCE(run_start_date, ?), updated_at = datetime('now') WHERE id = ? AND status = 'approved'`,
      [stationDay(now), id],
    );
    if (upd && upd.changes) return { ok: true, scheduled: true };
    const after = await this.getAd(id);
    if (after && after.status === 'scheduled') return { ok: true, already: true };
    return { ok: false, reason: `race:${after ? after.status : 'gone'}` };
  }

  /**
   * Enact an operator REJECTION: move a paid/pending/approved ad to 'rejected'
   * (the refund itself is confirmed-before-marked in radio-ad-payments.refundAd,
   * which the enact endpoint calls next). Refuses a live ad (scheduled/airing) —
   * that is a mid-run kill, not a rejection. Idempotent.
   */
  async rejectAd(id) {
    const ad = await this.getAd(id);
    if (!ad) return { ok: false, reason: 'not_found' };
    if (['rejected', 'refunded'].includes(ad.status)) return { ok: true, already: true };
    if (['killed'].includes(ad.status)) return { ok: true, already: true };
    if (['scheduled', 'airing', 'completed', 'disputed'].includes(ad.status)) return { ok: false, reason: `already_live:${ad.status}` };
    const upd = await this._run(`UPDATE radio_ads SET status = 'rejected', updated_at = datetime('now') WHERE id = ? AND status IN ('paid','pending','approved')`, [id]);
    if (upd && upd.changes) { await this.releaseBandHold(id); return { ok: true, rejected: true }; }
    const after = await this.getAd(id);
    if (after && ['rejected', 'refunded'].includes(after.status)) return { ok: true, already: true };
    return { ok: false, reason: `race:${after ? after.status : 'gone'}` };
  }

  /** Best-effort marker that a paid ad's raise reached KAX (paid→pending). The
   *  enact path is state-tolerant and does NOT depend on this (review M2). */
  async markRaised(id) {
    await this._run(`UPDATE radio_ads SET status = 'pending', updated_at = datetime('now') WHERE id = ? AND status = 'paid'`, [id]);
  }

  // ── Raise outbox (slice 4) ─────────────────────────────────

  /** Idempotently enqueue a raise for an ad. ON CONFLICT(ad_id,kind) DO NOTHING
   *  is the exactly-once backstop — safe to call on every paid signal AND from
   *  the reconcile sweep (review B3). */
  async enqueueRaise(id, payload = null) {
    await this._run(
      `INSERT INTO radio_ad_outbox (ad_id, kind, payload) VALUES (?, 'raise', ?) ON CONFLICT(ad_id, kind) DO NOTHING`,
      [id, payload == null ? null : JSON.stringify(payload)],
    );
  }

  /** Undelivered raises whose backoff has elapsed, oldest first. */
  pendingRaises(now = new Date(), limit = 20) {
    return this._all(
      `SELECT * FROM radio_ad_outbox WHERE kind = 'raise' AND delivered_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY id LIMIT ?`,
      [now.toISOString(), limit],
    );
  }

  async markRaiseDelivered(outboxId) {
    await this._run(`UPDATE radio_ad_outbox SET delivered_at = datetime('now'), last_error = NULL WHERE id = ?`, [outboxId]);
  }

  /** Record a failed delivery attempt + schedule the next one. Raises retry
   *  FOREVER (money — never go terminal like a losable chat event, review M5);
   *  the caller supplies the capped-backoff next_attempt_at. */
  async bumpRaiseAttempt(outboxId, err, nextAttemptAt) {
    await this._run(
      `UPDATE radio_ad_outbox SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE id = ?`,
      [nextAttemptAt instanceof Date ? nextAttemptAt.toISOString() : nextAttemptAt, String(err || '').slice(0, 500), outboxId],
    );
  }

  /** Paid ads with no raise row yet — the reconcile target that guarantees a
   *  raise even if a crash landed between the paid commit and the enqueue, or
   *  Stripe gave up before the webhook enqueued one (review B3). */
  paidWithoutRaise(limit = 50) {
    return this._all(
      `SELECT * FROM radio_ads WHERE status = 'paid' AND NOT EXISTS (SELECT 1 FROM radio_ad_outbox o WHERE o.ad_id = radio_ads.id AND o.kind = 'raise') LIMIT ?`,
      [limit],
    );
  }

  /** Ads that are paid/raised but not yet rendered — render early (review M3) so
   *  the enact is instant. Covers 'pending' too (a raise may deliver, moving the
   *  ad paid→pending, before render finishes), so it can never strand unrendered. */
  adsNeedingRender(limit = 50) {
    return this._all(
      `SELECT * FROM radio_ads WHERE status IN ('paid','pending') AND tts_file IS NULL LIMIT ?`,
      [limit],
    );
  }

  /** Register a synchronous kill listener (the DJ engine's evictSponsor). The
   *  sync advance path can't re-read DB status, so kill must PUSH into the
   *  engine's in-memory reservation/override to keep a killed ad off the air. */
  setKillListener(fn) { this._onKill = fn; }

  /** Kill switch: stop airings immediately.
   *  - status='killed' (durable);
   *  - release today's UNCONFIRMED reservation so the day is freed (a confirmed
   *    row is left intact — it already aired);
   *  - fire the sync engine eviction so a killed ad can never air from memory. */
  async killAd(id, now = new Date()) {
    // Freeze the pro-rata refund amount at kill time, WRITE-ONCE (COALESCE), so a
    // re-driven refund replays Stripe with the SAME key AND amount (review B1).
    // Basis is the ad's OWN amount_cents (what the customer actually paid), not a
    // magic constant, so it stays correct if the price ever changes (review M2).
    // Guard disputed_at: never kill-refund a disputed charge — the dispute moves
    // the funds, refunding on top is a double-pay (review B2). No-op on a
    // non-live ad (the WHERE), which keeps kill idempotent under re-drive.
    await this._run(
      `UPDATE radio_ads SET status = 'killed',
         refund_amount_cents = COALESCE(refund_amount_cents,
           CASE WHEN run_days > 0 THEN CAST(ROUND(COALESCE(amount_cents, 0) * (run_days - airings_done) / (run_days * 1.0)) AS INTEGER) ELSE 0 END),
         updated_at = datetime('now')
       WHERE id = ? AND status IN ('scheduled','airing') AND disputed_at IS NULL`,
      [id],
    );
    await this.releaseReservation(id, stationDay(now));
    await this.releaseBandHold(id);
    if (this._onKill) { try { this._onKill(id); } catch { /* engine eviction best-effort */ } }
    return { id, status: 'killed' };
  }

  /** Look an ad up by its Stripe payment_intent — the dispute event carries the
   *  PI, not our metadata.radio_ad_id (review M4). */
  getByPaymentIntent(pi) { return this._get(`SELECT * FROM radio_ads WHERE stripe_payment_intent = ?`, [pi]); }

  /**
   * Mark an ad DISPUTED (chargeback) — orthogonal to status (a dispute can hit
   * any state; review M4). Stops airing: releases today's reservation + band
   * hold and synchronously evicts from the engine (review M5). Issues NO refund
   * (the dispute process moves the funds). Idempotent via disputed_at IS NULL.
   */
  async markDisputed(paymentIntent, disputeId = null, now = new Date()) {
    const ad = await this.getByPaymentIntent(paymentIntent);
    if (!ad) return { ok: false, reason: 'not_found' };
    if (ad.disputed_at) return { ok: true, already: true, adId: ad.id };
    await this._run(
      `UPDATE radio_ads SET disputed_at = datetime('now'), stripe_dispute_id = COALESCE(?, stripe_dispute_id), updated_at = datetime('now') WHERE id = ? AND disputed_at IS NULL`,
      [disputeId, ad.id],
    );
    // A charged-back ad loses the GSA free-month perk (GSA auth re-checks
    // revoked_at live, so an active analytics session ends immediately).
    await this._run(`UPDATE radio_ad_gsa_entitlements SET revoked_at = datetime('now') WHERE ad_id = ? AND revoked_at IS NULL`, [ad.id]);
    await this.releaseReservation(ad.id, stationDay(now));
    await this.releaseBandHold(ad.id);
    if (this._onKill) { try { this._onKill(ad.id); } catch { /* engine eviction best-effort */ } }
    return { ok: true, adId: ad.id };
  }

  /**
   * Record a kill refund WITHOUT flipping status away from 'killed' (a partial
   * kill refund is not a full refund; review B3). refunded_at is the
   * at-most-once guard, shared with markRefunded.
   */
  async markKillRefunded(id, refundId = null) {
    const upd = await this._run(
      `UPDATE radio_ads SET refunded_at = datetime('now'), stripe_refund_id = COALESCE(?, stripe_refund_id), updated_at = datetime('now') WHERE id = ? AND refunded_at IS NULL AND status = 'killed'`,
      [refundId, id],
    );
    return { ok: true, already: !(upd && upd.changes) };
  }

  // ── Band capacity (slice 5) ────────────────────────────────

  /** Atomically reserve one of a band's K daily sponsor slots. The conditional
   *  INSERT sees prior holds because SQLite serializes writers, so two
   *  concurrent checkouts can't both pass (review M6). Returns { reserved }. */
  async reserveBandHold(adId, band, capacity = 1) {
    const upd = await this._run(
      `INSERT INTO radio_ad_band_holds (ad_id, band)
         SELECT ?, ? WHERE (SELECT COUNT(*) FROM radio_ad_band_holds WHERE band = ? AND released_at IS NULL) < ?`,
      [adId, band, band, capacity],
    );
    return { reserved: !!(upd && upd.changes) };
  }

  /** Live holds in a band whose ad was never paid, with what a reclaim needs
   *  to decide whether the checkout behind it is abandoned. */
  unpaidHoldsInBand(band) {
    return this._all(
      `SELECT h.ad_id, h.created_at, a.content_hash, a.stripe_session_id
         FROM radio_ad_band_holds h JOIN radio_ads a ON a.id = h.ad_id
        WHERE h.band = ? AND h.released_at IS NULL AND a.paid_at IS NULL`,
      [band],
    );
  }

  async releaseBandHold(adId) {
    await this._run(`UPDATE radio_ad_band_holds SET released_at = datetime('now') WHERE ad_id = ? AND released_at IS NULL`, [adId]);
  }

  /** Release holds for ads that were never paid within the grace window, so an
   *  abandoned checkout doesn't permanently occupy a band slot.
   *
   *  The cutoff MUST be in SQLite's own TEXT shape. `created_at` is written by
   *  `datetime('now')` as "2026-08-23 19:15:07"; a JS `toISOString()` is
   *  "2026-08-23T17:45:34.123Z". Compared as TEXT those share the date prefix
   *  and then diverge at ' ' (0x20) vs 'T' (0x54) — so every same-day hold
   *  sorted BELOW the cutoff and the grace window was effectively zero. Live on
   *  2026-08-23 that freed a paying customer's band slot 27 seconds into his
   *  checkout, leaving the band sellable twice over. */
  async releaseStaleUnpaidHolds(graceMs = 90 * 60 * 1000, now = new Date()) {
    const cutoff = sqliteTimestamp(new Date(now.getTime() - graceMs));
    await this._run(
      `UPDATE radio_ad_band_holds SET released_at = datetime('now')
         WHERE released_at IS NULL AND created_at < ?
           AND ad_id IN (SELECT id FROM radio_ads WHERE paid_at IS NULL)`,
      [cutoff],
    );
  }

  // ── GSA entitlement (slice 5) ──────────────────────────────

  /** Grant the free-month GSA entitlement — on APPROVAL, idempotent per ad
   *  (review M7). Piece 4 (Ghost Signals Analytics) redeems it later. */
  async grantGsaEntitlement(adId) {
    await this._run(
      `INSERT INTO radio_ad_gsa_entitlements (ad_id, redeem_by) VALUES (?, datetime('now','+30 days')) ON CONFLICT(ad_id) DO NOTHING`,
      [adId],
    );
  }

  // ── The airing ledger ──────────────────────────────────────

  /** Scheduled ads for a band that haven't finished their run — candidates
   *  before the per-day CAS. */
  eligibleForBand(band, now = new Date()) {
    return this._all(
      `SELECT * FROM radio_ads WHERE status = 'scheduled' AND disputed_at IS NULL AND band = ? AND tts_file IS NOT NULL AND airings_done < run_days AND (last_aired_date IS NULL OR last_aired_date != ?) ORDER BY run_start_date, id`,
      [band, stationDay(now)],
    );
  }

  /**
   * RESERVE the next due ad for right now (or null if nothing is due). This is
   * the async half of the sync-advance / async-claim seam: the DJ poller calls
   * it AHEAD of a commercial slot and holds the result in memory until the slot
   * actually airs.
   *
   * Reserve = INSERT the ledger row ONLY. UNIQUE(ad_id, air_date) bounds the ad
   * to <=once/day and survives a restart. `aired_at` stays NULL (not aired yet)
   * and NO run counter moves — so a reservation that never becomes a broadcast
   * (restart, playlist swap, TTL expiry) is fully recoverable (boot reconcile /
   * releaseReservation) and never a silently-charged day. The counter advances
   * only in confirmAiring(), when the spot actually finishes on-air.
   *
   * Returns { adId, file, title, airDate, band, commercial, sponsor } — enough
   * for the engine to overlay the spot and later confirm/release it.
   */
  async pickAiringForNow(now = new Date()) {
    const band = currentBand(now);
    const day = stationDay(now);
    const candidates = await this.eligibleForBand(band, now);
    for (const ad of candidates) {
      if (!airEligible(ad, now)) continue; // status/band/run re-check
      try {
        await this._run(
          `INSERT INTO radio_ad_airings (ad_id, air_date, reserved_at) VALUES (?, ?, datetime('now'))`,
          [ad.id, day],
        );
      } catch (e) {
        if (String(e && e.code).includes('SQLITE_CONSTRAINT')) continue; // already reserved/aired today
        throw e;
      }
      return {
        adId: ad.id,
        file: ad.tts_file,
        title: `[SPONSOR] ${ad.id}`,
        commercial: true,
        sponsor: true,
        airDate: day,
        band,
      };
    }
    return null;
  }

  /**
   * CONFIRM a reservation as aired — the ONLY place the run counter moves.
   * Called (from the async poller) when the spot has actually finished on the
   * live stream. Idempotent: a replay (double advance, restart mid-confirm)
   * finds aired_at already set and is a no-op, so a spot can never be
   * double-counted.
   *
   * airings_done is a DERIVED cache of the confirmed-row count (recomputed here
   * from the ledger, the source of truth) so it can never drift. The run
   * completes only at run_days CONFIRMED airings — a lost/released day slows the
   * run, it does not short-change the customer.
   */
  async confirmAiring(adId, airDate) {
    const upd = await this._run(
      `UPDATE radio_ad_airings SET aired_at = datetime('now') WHERE ad_id = ? AND air_date = ? AND aired_at IS NULL`,
      [adId, airDate],
    );
    if (!upd || upd.changes === 0) return { counted: false, reason: 'already_confirmed_or_missing' };
    const ad = await this.getAd(adId);
    if (!ad || ad.status !== 'scheduled') {
      // Killed/completed between reserve and confirm. It aired once (the row is
      // now confirmed, holding the once-per-day lock) — do NOT advance the run,
      // do NOT delete the row.
      return { counted: false, reason: 'not_scheduled' };
    }
    const row = await this._get(
      `SELECT COUNT(*) AS n FROM radio_ad_airings WHERE ad_id = ? AND aired_at IS NOT NULL`,
      [adId],
    );
    const confirmed = row ? row.n : 0;
    const finished = confirmed >= ad.run_days;
    await this._run(
      `UPDATE radio_ads SET airings_done = ?, last_aired_date = ?, status = ?, updated_at = datetime('now') WHERE id = ? AND status = 'scheduled'`,
      [confirmed, airDate, finished ? 'completed' : 'scheduled', adId],
    );
    if (finished) await this.releaseBandHold(adId); // free the band slot when the run completes
    return { counted: true, airing: confirmed, of: ad.run_days, finished };
  }

  /**
   * Release an UNCONFIRMED reservation (poller TTL, playlist swap, kill). A
   * confirmed (aired) row is immutable, so the once-per-day guarantee can never
   * be reopened. Because reserve advanced no counter, a bare DELETE fully
   * restores state.
   */
  async releaseReservation(adId, airDate) {
    const del = await this._run(
      `DELETE FROM radio_ad_airings WHERE ad_id = ? AND air_date = ? AND aired_at IS NULL`,
      [adId, airDate],
    );
    return { released: !!(del && del.changes) };
  }

  /** Count of days that PHYSICALLY aired (aired_at set) — a diagnostic. NOTE:
   *  this is NOT the refund basis. Use radio_ads.airings_done for refunds: it
   *  equals this in the normal case but is deliberately LOWER by any
   *  kill-in-same-tick "floor" day (aired once but left unbilled, so the
   *  customer stays refundable for it). refund_days = run_days - airings_done. */
  async confirmedAirings(adId) {
    const row = await this._get(
      `SELECT COUNT(*) AS n FROM radio_ad_airings WHERE ad_id = ? AND aired_at IS NOT NULL`,
      [adId],
    );
    return row ? row.n : 0;
  }

  /**
   * Render a PREVIEW of arbitrary ad text — pre-payment, pre-draft. Keyed by
   * content hash into the same asset dir the airing render uses, so when the
   * customer later buys, createDraft(text)+renderAd find this exact file
   * (what they previewed IS what airs). Idempotent: identical text is a cache
   * hit, never a re-render. Validates + normalizes first (throws InvalidAdText).
   */
  async previewRender(rawText, voiceDJ) {
    if (!this.assetDir) throw new Error('radio-ads asset dir not configured');
    const text = normalizeAdText(rawText); // throws InvalidAdText on bad/oversized
    const hash = contentHash(text);
    const relPrefix = path.basename(this.assetDir);
    const fileName = `ad_${hash}.mp3`;
    const absPath = path.join(this.assetDir, fileName);
    const relFile = path.posix.join(relPrefix, fileName); // URL-shaped for /audio/
    if (fs.existsSync(absPath)) return { file: relFile, contentHash: hash, cached: true, text };
    if (!fs.existsSync(this.assetDir)) fs.mkdirSync(this.assetDir, { recursive: true });
    const tmpPath = await new Promise((resolve, reject) => {
      voiceDJ.generateTTS(text, (err, p) => (err || !p ? reject(err || new Error('tts produced no file')) : resolve(p)));
    });
    this._freezeAtomic(tmpPath, absPath);
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
    // A concurrent same-hash render may have won the freeze; either way the
    // final file now exists and is the identical content.
    return { file: relFile, contentHash: hash, cached: false, text };
  }

  /**
   * Sweep abandoned preview renders. A preview writes ad_<hash>.mp3 into the
   * asset dir with NO db row; only a PURCHASED ad's renderAd sets tts_file. So
   * any ad_*.mp3 not referenced by a radio_ads.tts_file AND older than
   * maxAgeMs is an abandoned preview for text nobody bought — delete it.
   * Deleting is always safe: a later purchase of that exact text just
   * re-renders the identical content hash. This is the disk-fill bound the
   * design review required before the preview endpoint is surfaced (O1 runs
   * ~91% full). The age grace keeps a preview alive long enough for the
   * customer to complete a purchase against it.
   */
  async pruneUnreferencedPreviews({ maxAgeMs = 3 * 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
    if (!this.assetDir || !fs.existsSync(this.assetDir)) return { scanned: 0, deleted: 0 };
    const rows = await this._all(`SELECT tts_file FROM radio_ads WHERE tts_file IS NOT NULL`, []);
    const referenced = new Set(rows.map((r) => path.basename(r.tts_file)));
    let scanned = 0;
    let deleted = 0;
    let names;
    try { names = fs.readdirSync(this.assetDir); } catch { return { scanned: 0, deleted: 0 }; }
    for (const name of names) {
      if (!/^ad_[0-9a-f]{16}\.mp3$/.test(name)) continue; // only our preview/airing renders
      scanned += 1;
      if (referenced.has(name)) continue; // a paid ad points at this — keep
      const abs = path.join(this.assetDir, name);
      let mtime;
      try { mtime = fs.statSync(abs).mtimeMs; } catch { continue; }
      if (now - mtime < maxAgeMs) continue; // still inside the purchase grace
      try { fs.unlinkSync(abs); deleted += 1; } catch { /* best-effort */ }
    }
    return { scanned, deleted };
  }

  /**
   * Start a periodic in-process prune of abandoned previews. In-process (not a
   * cron) so a check that lives in the service can't itself be the thing that
   * stopped running — the same reasoning as disk-space.js. Returns the timer,
   * unref'd so it never holds the process open. Runs one sweep on start.
   */
  startPreviewSweeper({ intervalMs = 6 * 60 * 60 * 1000 } = {}) {
    const tick = () => { this.pruneUnreferencedPreviews().catch(() => {}); };
    tick();
    const t = setInterval(tick, intervalMs);
    if (t.unref) t.unref();
    return t;
  }

  /** Operator/debug view of an ad's run. `confirmed` is the actually-aired day
   *  count (refund basis); a row with aired_at NULL is a live reservation, not
   *  an airing. */
  async adStatus(id) {
    const ad = await this.getAd(id);
    if (!ad) return null;
    const airings = await this._all(`SELECT air_date, reserved_at, aired_at FROM radio_ad_airings WHERE ad_id = ? ORDER BY air_date`, [id]);
    const confirmed = airings.filter((a) => a.aired_at).length;
    return { ...ad, airings, confirmed };
  }
}

module.exports = { RadioAdStore };
