'use strict';
/**
 * Track requests — the pure half.
 *
 * A request is the one write the station deliberately leaves open to the
 * public: anybody listening may ask for a song. What made it a problem was
 * not that it was open, it was that it was unexamined. `POST /api/request`
 * accepted an empty body, answered 200, wrote `Track request from undefined:
 * "undefined"` into the journal, and — the part that matters — **broadcast
 * whatever strings it was handed to every connected listener**, unbounded and
 * unfiltered, over the same websocket the player uses.
 *
 * So this module decides what a request has to look like before any of that
 * happens. No I/O, no state, no clock: the rules can be tested without a
 * station, and both doors into the station (HTTP and the websocket bus) go
 * through the same check rather than each having its own opinion.
 *
 * The rules, and why each exists:
 *   • a request must actually ask for something — a title or a message, not
 *     an empty object that logs as "undefined" and teaches the operator to
 *     ignore the request log;
 *   • every field is length-capped, because these strings are pushed to every
 *     listener's UI and stored in a 500-entry in-memory log that a flood can
 *     otherwise roll clean of genuine requests;
 *   • control characters are stripped rather than trimmed around, because the
 *     destination is somebody else's screen and a newline in a "from" field is
 *     a line of forged UI;
 *   • `from` is bounded and defaulted in ONE place, so the stored record and
 *     the journal line can never again disagree about who asked.
 */

/** Longest a requester name may be. Long enough for an agent id. */
const MAX_FROM = 64;
/** Longest track title we will look up or repeat back. */
const MAX_TITLE = 200;
/** Longest free-text message. Roughly a post, not an essay. */
const MAX_MESSAGE = 280;

const DEFAULT_FROM = 'unknown-agent';

/**
 * Strip anything that is not printable text.
 *
 * C0 and C7 control characters, plus the Unicode line/paragraph separators
 * and the bidi overrides — all of which survive JSON.parse happily and none
 * of which belong in a field that is rendered in a listener's browser.
 */
function clean(value) {
  if (typeof value !== 'string') return '';
  return value
    // C0 and C7 controls, and DEL
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    // line and paragraph separators, which JSON.parse passes through happily
    .replace(/[\u2028\u2029]/g, ' ')
    // bidi overrides and isolates: a listener's screen is the destination
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, ' ')
    .trim();
}

class RequestRejected extends Error {}

/**
 * Validate and normalise one track request.
 *
 * @param {object} request raw, straight off the wire
 * @returns {{from: string, trackTitle: string|null, message: string|null}}
 * @throws {RequestRejected} with a message safe to hand back to the caller
 */
function sanitizeTrackRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new RequestRejected('a request must be a JSON object');
  }

  const from = clean(request.from) || DEFAULT_FROM;
  const trackTitle = clean(request.trackTitle);
  const message = clean(request.message);

  if (!trackTitle && !message) {
    throw new RequestRejected('a request needs a trackTitle or a message');
  }
  if (from.length > MAX_FROM) {
    throw new RequestRejected(`from is longer than ${MAX_FROM} characters`);
  }
  if (trackTitle.length > MAX_TITLE) {
    throw new RequestRejected(`trackTitle is longer than ${MAX_TITLE} characters`);
  }
  if (message.length > MAX_MESSAGE) {
    throw new RequestRejected(`message is longer than ${MAX_MESSAGE} characters`);
  }

  return {
    from,
    trackTitle: trackTitle || null,
    message: message || null,
  };
}

module.exports = {
  sanitizeTrackRequest,
  RequestRejected,
  clean,
  MAX_FROM,
  MAX_TITLE,
  MAX_MESSAGE,
  DEFAULT_FROM,
};
