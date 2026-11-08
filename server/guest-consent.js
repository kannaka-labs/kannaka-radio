'use strict';
/**
 * Guest consent gate — nothing a guest made airs until they have said yes.
 *
 * Two show folders hold other people's work that is staged before its
 * creator has agreed to it airing: "Guest Reading" (a text by someone else,
 * voiced by the station, aired once after a peace oration) and
 * "Guest Showcase" (a guest's own audio, a late-night showcase). Everything
 * in those folders is gated, and the gate defaults to closed:
 *
 *   • each audio file needs a sidecar "<stem>.guest.json" naming its guest
 *     and what must be settled first (no sidecar → never airs);
 *   • the consent file (workspace/guest-consent.json, or GUEST_CONSENT_FILE)
 *     must say `"consent": true` for that guest — the boolean, not a string;
 *     a missing, empty or unreadable file means no consent for anyone;
 *   • every item the sidecar `requires` (a fact the writer must confirm, the
 *     credit line, "the operator has listened") must be listed in that
 *     guest's `resolved` array;
 *   • `maxAirings` caps how many times the file may air (ledger:
 *     workspace/guest-airings.json); `hours` limits the Chicago hours it may
 *     start in; `explicit: true` adds the night window (22:00–05:59);
 *   • a spoken sidecar of the file (".intro*.txt", ".before.txt", ".after.txt") that still
 *     holds a "[[…]]" placeholder holds it too.
 *
 * The consent file is read at schedule time, every time, so flipping a
 * guest on or off needs no restart and no deploy.
 *
 * Gated folders are also kept out of the library index (utils.getFiles), so
 * no listener request, vote, Deep Cuts set or album lookup can reach them,
 * and /audio/ refuses a gated file until its guest has consented.
 */

const fs = require('fs');
const path = require('path');

/** Show folders whose every file is gated. */
const GUEST_FOLDERS = Object.freeze(['Guest Reading', 'Guest Showcase']);

const SIDECAR_SUFFIX = '.guest.json';

function isNightHour(h) { return h >= 22 || h < 6; }

/** Default file locations under the radio's data dir (BASE_DIR/workspace). */
function defaultPaths(baseDir, env = process.env) {
  const ws = path.join(baseDir || '.', 'workspace');
  return {
    consentFile: env.GUEST_CONSENT_FILE || path.join(ws, 'guest-consent.json'),
    ledgerFile: env.GUEST_AIRINGS_FILE || path.join(ws, 'guest-airings.json'),
  };
}

/** The top-level folder of a library-relative path ("a/b.mp3" or "a\\b.mp3"). */
function topFolder(rel) {
  const s = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const i = s.indexOf('/');
  return i === -1 ? null : s.slice(0, i);
}

/** True for a library-relative path inside a gated guest folder. */
function isGuestPath(rel) {
  const top = topFolder(rel);
  return !!top && GUEST_FOLDERS.some((f) => f.toLowerCase() === top.toLowerCase());
}

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch (_) {
    return null;
  }
}

/** { guests: { id: { consent, resolved[] } } }; anything unreadable → no guests. */
function readConsent(file) {
  const v = readJson(file);
  const guests = v && v.guests && typeof v.guests === 'object' ? v.guests : {};
  return { guests };
}

/** The sidecar beside an audio file, or null. */
function readSidecar(dir, fileName) {
  const stem = String(fileName).replace(/\.[^.]+$/, '');
  const v = readJson(path.join(dir, stem + SIDECAR_SUFFIX));
  return v && typeof v.guest === 'string' && v.guest ? v : null;
}

/** { "<folder>/<file>": ["iso", …] } */
function readAirings(file) {
  const v = readJson(file);
  return v && typeof v === 'object' ? v : {};
}

function ledgerKey(folder, fileName) { return `${folder}/${fileName}`; }

/** Spoken sidecars of a file (".intro*.txt", ".before.txt", ".after.txt") that still hold a "[[…]]" placeholder. */
function placeholderSidecars(dir, fileName) {
  const stem = String(fileName).replace(/\.[^.]+$/, '');
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  return names
    .filter((n) => n.startsWith(`${stem}.`) && /\.(intro(\.\d+)?|before|after)\.txt$/.test(n))
    .filter((n) => {
      try { return /\[\[[^\]]*\]\]/.test(fs.readFileSync(path.join(dir, n), 'utf8')); } catch (_) { return false; }
    });
}

/**
 * Pure: may this file air now? Returns { ok, reasons[] } — reasons name
 * every unmet condition, so the log can say exactly what is still owed.
 *
 * @param {object|null} sidecar
 * @param {object} consent        readConsent() result
 * @param {object} o
 * @param {number} [o.airedCount] times it has already aired
 * @param {number} [o.chicagoHour] 0–23; omitted → hour rules not checked
 * @param {boolean} [o.ignoreAirings] a resume of an airing already counted
 */
function clearance(sidecar, consent, o = {}) {
  const reasons = [];
  if (!sidecar) return { ok: false, reasons: ['no guest sidecar (<stem>.guest.json)'] };
  const entry = (consent && consent.guests && consent.guests[sidecar.guest]) || null;
  if (!entry || entry.consent !== true) reasons.push(`no consent from "${sidecar.guest}"`);
  const resolved = new Set(entry && Array.isArray(entry.resolved) ? entry.resolved : []);
  for (const req of Array.isArray(sidecar.requires) ? sidecar.requires : []) {
    if (!resolved.has(req)) reasons.push(`unresolved: ${req}`);
  }
  if (!o.ignoreAirings && Number.isInteger(sidecar.maxAirings)
      && (o.airedCount || 0) >= sidecar.maxAirings) {
    reasons.push(`already aired ${o.airedCount}/${sidecar.maxAirings}`);
  }
  if (Number.isInteger(o.chicagoHour)) {
    if (Array.isArray(sidecar.hours) && sidecar.hours.length && !sidecar.hours.includes(o.chicagoHour)) {
      reasons.push(`hour ${o.chicagoHour} not in [${sidecar.hours.join(',')}]`);
    }
    if (sidecar.explicit === true && !isNightHour(o.chicagoHour)) {
      reasons.push(`explicit: night only (22:00–05:59), now ${o.chicagoHour}:00`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * The I/O half for one show folder: a gate function for PodcastScheduler and
 * the airing recorder. Reads the consent file and the ledger on every call.
 */
function createGate({ musicDir, folder, consentFile, ledgerFile, log = console }) {
  const getDir = () => path.join(typeof musicDir === 'function' ? musicDir() : musicDir, folder);
  const lastLogged = new Map();
  function check(fileName, o = {}) {
    const sidecar = readSidecar(getDir(), fileName);
    const airings = readAirings(ledgerFile)[ledgerKey(folder, fileName)];
    const res = clearance(sidecar, readConsent(consentFile), {
      airedCount: Array.isArray(airings) ? airings.length : 0,
      chicagoHour: o.chicagoHour,
      ignoreAirings: o.ignoreAirings,
    });
    // A staged spoken line still holding a placeholder ("[[CREDIT]]") would
    // be read out literally; it holds the file like any unmet condition.
    for (const p of placeholderSidecars(getDir(), fileName)) {
      res.ok = false;
      res.reasons.push(`placeholder left in ${p}`);
    }
    // Say why a file is held, once per change of reason, not every tick.
    const msg = res.reasons.join('; ');
    if (!res.ok && lastLogged.get(fileName) !== msg) {
      lastLogged.set(fileName, msg);
      if (log && log.log) log.log(`[guest-consent] ${folder}/${fileName} held: ${msg}`);
    }
    if (res.ok) lastLogged.delete(fileName);
    return res;
  }
  function recordAiring(fileName, now = new Date()) {
    const all = readAirings(ledgerFile);
    const key = ledgerKey(folder, fileName);
    all[key] = (Array.isArray(all[key]) ? all[key] : []).concat(now.toISOString());
    try {
      fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
      const tmp = `${ledgerFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n');
      fs.renameSync(tmp, ledgerFile);
    } catch (e) {
      if (log && log.warn) log.warn(`[guest-consent] could not record airing of ${key}: ${e && e.message}`);
    }
  }
  return { check, recordAiring, folder };
}

/**
 * For /audio/: has this gated file's guest consented, with everything it
 * requires resolved? Hours and airing caps are not applied here — a player
 * fetching the file a minute into the hour must still get it.
 */
function servable(musicDir, rel, consentFile) {
  if (!isGuestPath(rel)) return true;
  const norm = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  const dir = path.join(musicDir, path.dirname(norm));
  const res = clearance(readSidecar(dir, path.basename(norm)), readConsent(consentFile), {});
  return res.ok;
}

module.exports = {
  GUEST_FOLDERS,
  SIDECAR_SUFFIX,
  isNightHour,
  defaultPaths,
  isGuestPath,
  readConsent,
  readSidecar,
  readAirings,
  clearance,
  createGate,
  servable,
};
