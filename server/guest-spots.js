'use strict';
/**
 * Guest spots — the half that touches the world.
 *
 * Talks to Ghost Signals Records over localhost, copies the chosen track into
 * the station's own music tree, remembers what has aired, and tells the studio
 * once a spot has actually gone out.
 *
 * Inert unless GSR_ADMIN_TOKEN is set: every method answers empty or false and
 * the station never notices. Nothing here may throw into the live advance —
 * the callers wrap, and so does this.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const SUBDIR = 'guest-spots';
const MIN_BYTES = 100 * 1024; // a track this small is a failed download, not a song

class GuestSpots {
  /**
   * @param {object} o
   * @param {string} o.base        the studio's base URL
   * @param {string} o.token       its admin token
   * @param {function} o.getMusicDir
   * @param {string} o.ledgerPath  where the aired ids live
   * @param {function} [o.log]
   */
  constructor(o) {
    this.base = String(o.base || '').replace(/\/+$/, '');
    this.token = o.token || '';
    this.getMusicDir = o.getMusicDir;
    this.ledgerPath = o.ledgerPath;
    this.log = o.log || (() => {});
    this._ledger = null;
    // Records staged but not yet aired. A spot stays here for its whole life
    // on air so the poller cannot pick it a second time while it is playing.
    this._inFlight = new Map(); // orderId -> staged at (ms)
  }

  /** Orders that are staged or on air right now. */
  inFlight() { return new Set(this._inFlight.keys()); }
  markInFlight(orderId) { this._inFlight.set(orderId, Date.now()); }
  clearInFlight(orderId) { this._inFlight.delete(orderId); }

  /** Let go of anything that was staged but never reached a slot, so a
   *  released reservation can be picked up again later. */
  releaseStale(maxAgeMs) {
    for (const [id, at] of this._inFlight) {
      if (Date.now() - at > maxAgeMs) this._inFlight.delete(id);
    }
  }

  enabled() { return Boolean(this.base && this.token); }

  // ---- the ledger: what this station has aired -------------------------
  ledger() {
    if (this._ledger) return this._ledger;
    let data = { aired: {}, lastAiredAt: 0 };
    try {
      const raw = fs.readFileSync(this.ledgerPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') data = { aired: parsed.aired || {}, lastAiredAt: parsed.lastAiredAt || 0 };
    } catch (_) { /* first run, or unreadable: start clean */ }
    this._ledger = data;
    return data;
  }

  airedIds() { return new Set(Object.keys(this.ledger().aired)); }
  lastAiredAt() { return this.ledger().lastAiredAt || 0; }

  /** Write the ledger before telling the studio: if the process dies between
   *  the two, the spot is never re-aired here, and the studio's own
   *  markRadioAired is idempotent anyway. */
  recordAired(orderId, at) {
    const l = this.ledger();
    l.aired[orderId] = new Date(at || Date.now()).toISOString();
    l.lastAiredAt = at || Date.now();
    try {
      fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
      fs.writeFileSync(this.ledgerPath, JSON.stringify(l, null, 2));
    } catch (e) { this.log(`[guest-spots] ledger write failed: ${e.message}`); }
  }

  // ---- the studio ------------------------------------------------------
  _request(method, pathname, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(this.base + pathname); } catch (e) { return reject(e); }
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.request({
        method, hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        headers: { authorization: `Bearer ${this.token}`, accept: 'application/json', 'content-length': 0 },
        timeout: timeoutMs,
      }, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) return reject(new Error(`${method} ${pathname}: ${res.statusCode} ${body.slice(0, 120)}`));
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      });
      req.on('timeout', () => req.destroy(new Error(`timeout ${method} ${pathname}`)));
      req.on('error', reject);
      req.end();
    });
  }

  async queue() {
    if (!this.enabled()) return [];
    const j = await this._request('GET', '/admin/radio/queue');
    return Array.isArray(j.queue) ? j.queue : [];
  }

  async tellStudioAired(orderId) {
    if (!this.enabled()) return false;
    await this._request('POST', `/admin/orders/${encodeURIComponent(orderId)}/radio/aired`);
    return true;
  }

  // ---- staging ---------------------------------------------------------
  /** Is this path a file the station can actually stream? */
  playable(file) {
    try {
      const st = fs.statSync(file);
      return st.isFile() && st.size >= MIN_BYTES;
    } catch (_) { return false; }
  }

  /**
   * Copy the guest's track into the station's own tree. The studio may rebuild
   * or delete its copy; what goes on air must not move under the stream.
   * Returns the staged absolute path.
   */
  stage(spot) {
    const dir = path.join(this.getMusicDir(), SUBDIR);
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(spot.file) || '.mp3';
    const dest = path.join(dir, `${spot.publicId}-${spot.track}${ext}`);
    if (!fs.existsSync(dest) || fs.statSync(dest).size !== fs.statSync(spot.file).size) {
      fs.copyFileSync(spot.file, dest);
    }
    return dest;
  }

  /**
   * A spot finished on air. The file must still be there: the station's
   * missing-file path advances with the same filename, which looks exactly
   * like a clean finish to the confirm test, so a vanished file means the
   * record did NOT play and must come back around.
   *
   * The ledger is written before the studio is told, so a crash between the
   * two can never air a record twice; the studio's own mark is idempotent.
   */
  async confirmAired(orderId, stagedFile) {
    if (!this.playable(stagedFile)) {
      this.clearInFlight(orderId);
      return { ok: false, reason: 'the staged file was gone at confirm — an airing nobody heard is not an airing' };
    }
    this.recordAired(orderId, Date.now());
    this.clearInFlight(orderId);
    try {
      await this.tellStudioAired(orderId);
      return { ok: true, told: true };
    } catch (e) {
      return { ok: true, told: false, reason: e.message };
    }
  }

  /** Staged files are left alone while anything might still read them, and
   *  swept a day later. Deleting at confirm raced the stream and cost a
   *  false airing the first time this ran. */
  sweepStaged(maxAgeMs = 24 * 60 * 60 * 1000) {
    let gone = 0;
    try {
      const dir = path.join(this.getMusicDir(), SUBDIR);
      for (const name of fs.readdirSync(dir)) {
        const f = path.join(dir, name);
        try {
          if (Date.now() - fs.statSync(f).mtimeMs > maxAgeMs) { fs.unlinkSync(f); gone++; }
        } catch (_) { /* next */ }
      }
    } catch (_) { /* no staging dir yet */ }
    return gone;
  }
}

module.exports = { GuestSpots, SUBDIR, MIN_BYTES };
