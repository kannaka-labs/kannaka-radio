'use strict';

/**
 * Deep Cuts — the part of the library the DJ never reaches.
 *
 * The `dj` channel plays curated ALBUMS, and an album is a list of TITLES that
 * `findAudioFile` resolves against the library. Anything no album names is
 * therefore never selected, however long it has sat on the disk. Measured on
 * 2026-08-24: of 678 files, 349 were named by an album and 69 belong to other
 * channels, leaving **260 the DJ could not reach** — 246 of them loose at the
 * top level rather than in album folders.
 *
 * Those files are not lost and they are not rejected. Nothing names them.
 *
 * This module turns that residue into a playable set, ordered so the most
 * neglected go first: never-played before long-unplayed, oldest before newer.
 *
 * It is deliberately DERIVED, not a hand-maintained list — a curated list of
 * the uncurated would need updating every time a file lands, which is the
 * failure it exists to correct.
 */

const path = require('path');

/** Folders another channel already owns. Their contents are not neglected;
 *  they are somebody else's programme. */
const CHANNEL_OWNED = new Set([
  'Ghost Signals Podcast',
  'The Story of Flaukowski',
  'commercials',
  'radio-ads',
  'generated',
  'live',
  'retired',
  'gsa',
]);

/** The top-level folder of a library-relative path, or null for a root file. */
function topFolder(rel) {
  const native = rel.indexOf(path.sep);
  const i = native >= 0 ? native : rel.indexOf('/');
  return i === -1 ? null : rel.slice(0, i);
}

/**
 * Files no curated album names and no other channel owns. Pure.
 *
 * @param {string[]} allFiles      library-relative paths (root + one level)
 * @param {Iterable<string>} referenced  paths some album resolved to
 * @param {Set<string>} [owned]    channel-owned folder names
 */
function unreachedFiles(allFiles, referenced, owned = CHANNEL_OWNED) {
  const ref = new Set(referenced);
  return allFiles.filter((f) => {
    if (ref.has(f)) return false;
    const dir = topFolder(f);
    return !(dir && owned.has(dir));
  });
}

/**
 * Resolve every curated album's titles to files, so we know what IS reached.
 * Takes the resolver as an argument rather than importing it, so this stays
 * testable without a music directory.
 */
function referencedFiles(albums, musicDir, findAudioFile) {
  const out = new Set();
  for (const album of Object.values(albums || {})) {
    for (const title of album.tracks || []) {
      const f = findAudioFile(title, musicDir);
      if (f) out.add(f);
    }
  }
  return out;
}

/**
 * Build the Deep Cuts track list: the unreached files, most-neglected first,
 * capped so one build does not queue the entire residue in a single sitting.
 *
 * Returns `{ tracks, total, neverPlayed }` — the counts are for the log line
 * and the audit endpoint, because "how much of the library has still never
 * played" is the number worth watching over time.
 */
function buildDeepCuts({ allFiles, referenced, ledger, limit = 12, owned = CHANNEL_OWNED }) {
  const unreached = unreachedFiles(allFiles, referenced, owned);
  const ranked = ledger ? ledger.rankByNeglect(unreached) : unreached;
  const neverPlayed = ledger ? ledger.neverPlayedCount(unreached) : unreached.length;
  return {
    tracks: ranked.slice(0, Math.max(1, limit)),
    total: unreached.length,
    neverPlayed,
  };
}

/** A title for the now-playing strip. Filenames here are the only name these
 *  tracks have — nothing curated them, so nothing gave them one. */
function titleFor(rel) {
  return path.basename(rel).replace(/\.[^.]+$/, '');
}

module.exports = { buildDeepCuts, unreachedFiles, referencedFiles, titleFor, topFolder, CHANNEL_OWNED };
