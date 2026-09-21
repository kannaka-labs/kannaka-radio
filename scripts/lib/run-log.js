'use strict';

/**
 * run-log.js — put a UTC timestamp on every line the research crons emit.
 *
 * The research scripts append to a single long-lived log file per cron
 * (`~/.kannaka/research-dispatch.log` and friends) and print nothing to mark
 * where one run stops and the next begins. A skipped run writes ONE line; a
 * successful run writes five. Read back later, the last line of a skipped run
 * sits directly above the first line of the next day's successful run:
 *
 *     [research-dispatch] no research grounding yet (...) — skipping
 *     [research-dispatch] bluesky ok: https://bsky.app/...
 *
 * That is two runs a day apart, and it reads as one run that announced it had
 * no grounding and then published anyway. kannaka-memory#940 was filed on
 * exactly that reading — a correct gate reported as a live defect posting
 * ungrounded research to five networks. The gate was never wrong; the log was
 * unreadable.
 *
 * A timestamp on each line makes run boundaries self-evident without anyone
 * having to reconstruct the cron schedule.
 *
 * Usage, once, before anything logs:
 *
 *     require("./lib/run-log").stampConsole();
 */

function stamp(now) {
  // Second resolution is enough to separate daily cron runs, and keeps the
  // prefix narrow. `toISOString` is already UTC.
  return `${(now || new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z')} `;
}

/**
 * Wrap console.log/error/warn so each call is prefixed with a UTC timestamp.
 * Multi-line payloads (a composed draft, say) are stamped on their first line
 * only — the point is to date the event, not to gutter the text.
 *
 * Idempotent: calling it twice does not double-stamp.
 */
function stampConsole(target) {
  const c = target || console;
  if (c.__runLogStamped) return c;
  for (const level of ['log', 'error', 'warn']) {
    const original = c[level].bind(c);
    c[level] = (...parts) => {
      if (parts.length === 0) return original();
      const [first, ...rest] = parts;
      return typeof first === 'string'
        ? original(stamp() + first, ...rest)
        : original(stamp().trimEnd(), first, ...rest);
    };
  }
  Object.defineProperty(c, '__runLogStamped', { value: true, enumerable: false });
  return c;
}

module.exports = { stampConsole, stamp };
