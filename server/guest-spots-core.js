'use strict';
/**
 * Guest spots — the pure half.
 *
 * Ghost Signals Records sells a record and throws in one airing. This module
 * decides WHICH queued spot may go on next and what its playlist entry looks
 * like. No I/O, no clock of its own, no station state: everything it needs is
 * an argument, so the policy can be tested without a station.
 *
 * The rules it encodes, and why each exists:
 *   • one airing per record, ever — the offer says once, so an order already
 *     in the aired ledger is never chosen again even if the studio re-queues it;
 *   • a cooldown between spots — the station is Kannaka's, not a guest channel,
 *     so guests arrive at most once every COOLDOWN;
 *   • oldest first — a queue people wait in should be fair;
 *   • a spot must name a real, readable file — a slot that cannot play is worse
 *     than no slot, because the engine would advance past it and count it aired.
 */

/** Seconds a staged reservation may sit before the poller lets it go. */
const RESERVATION_TTL_MS = 9 * 60 * 1000; // longer than any one track

/** Default gap between guest spots. */
const DEFAULT_COOLDOWN_MS = 45 * 60 * 1000;

/**
 * Choose the next spot to stage, or null.
 *
 * @param {Array} queue        rows from the studio: { orderId, publicId, album, track, title, file, requestedAt }
 * @param {object} o
 * @param {Set<string>} o.airedIds     orders this station has already aired
 * @param {number} o.now               ms
 * @param {number} [o.lastAiredAt]     ms of the last guest spot that aired here
 * @param {number} [o.cooldownMs]
 * @param {function} [o.playable]      (file) => boolean; defaults to "has a path"
 */
function chooseNext(queue, o) {
  const cooldown = o.cooldownMs === undefined ? DEFAULT_COOLDOWN_MS : o.cooldownMs;
  if (o.lastAiredAt && o.now - o.lastAiredAt < cooldown) return null;
  const playable = o.playable || ((f) => Boolean(f));
  const rows = (Array.isArray(queue) ? queue : [])
    .filter((r) => r && r.orderId && r.file && Number.isInteger(r.track))
    .filter((r) => !o.airedIds.has(r.orderId))
    .filter((r) => playable(r.file))
    .sort((a, b) => String(a.requestedAt || '').localeCompare(String(b.requestedAt || '')));
  return rows[0] || null;
}

/** How the spot is named on air and in the stream's metadata. */
function titleFor(spot) {
  return `${spot.title} — ${spot.album}`;
}

/**
 * The playlist entry the engine overlays onto one music slot. It keeps the
 * slot's own shape (so history, metadata and the no-repeat logic all still
 * read it as a track) and adds the two fields the confirm path needs.
 *
 * `commercial` is deliberately NOT set: a guest spot is a song, and a song is
 * what the slot it borrows was going to be.
 */
function spotEntry(current, spot, stagedFile) {
  return {
    ...current,
    file: stagedFile,
    title: titleFor(spot),
    album: 'Ghost Signals Records',
    theme: `A guest spot: one airing of a record made at Ghost Signals Records for its owner.`,
    guestSpot: true,
    guestOrderId: spot.orderId,
    guestAlbum: spot.album,
    guestTrack: spot.title,
  };
}

module.exports = { chooseNext, titleFor, spotEntry, RESERVATION_TTL_MS, DEFAULT_COOLDOWN_MS };
