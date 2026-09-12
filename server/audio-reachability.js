'use strict';

/**
 * What is on this station that nothing will ever play?
 *
 * Two separate ways audio goes silent here, and the first audit I wrote only
 * looked for the second one and got the answer badly wrong:
 *
 *   1. UNREACHED — the file is present and resolvable, but no curated album
 *      names it, so the `dj` channel never selects it. Measured 2026-08-24:
 *      260 of 678 files, 246 of them loose at the top level.
 *
 *   2. UNREACHABLE FOLDER — a directory no channel opens at all. This is the
 *      one that hid all eight episodes of The Story of Flaukowski for four
 *      days in August.
 *
 * I first reported (1) as (2) — 127 files across 19 album folders — by checking
 * which folder NAMES appeared in the source rather than asking the resolver
 * what it could actually find. `utils.refreshFileCache` walks one level of
 * subdirectories, so those album folders were reachable all along. The lesson
 * is baked into the shape of this module: it asks the real resolver, and it
 * reports the two conditions separately instead of collapsing them.
 */

const fs = require('fs');
const path = require('path');
const { CHANNEL_OWNED, topFolder } = require('./deep-cuts');

const AUDIO_RE = /\.(mp3|wav|flac|m4a|ogg)$/i;

/**
 * Files present and resolvable that no curated album names. Pure.
 * @param {string[]} allFiles   library-relative paths, as the resolver sees them
 * @param {Iterable<string>} referenced  paths some album resolved to
 */
function unreachedFiles(allFiles, referenced, owned = CHANNEL_OWNED) {
  const ref = new Set(referenced);
  return allFiles.filter((f) => {
    if (ref.has(f)) return false;
    const d = topFolder(f);
    return !(d && owned.has(d));
  });
}

/** Group a file list by top-level folder for a readable report. */
function byFolder(files) {
  const out = {};
  for (const f of files) {
    const key = topFolder(f) || '(root level)';
    out[key] = (out[key] || 0) + 1;
  }
  return Object.entries(out).sort((a, b) => b[1] - a[1]).map(([folder, files_]) => ({ folder, files: files_ }));
}

/**
 * Folders holding audio that the file resolver never even lists — the TSOF
 * failure. Distinct from "unreached": these are invisible, not merely unnamed.
 */
function invisibleFolders(musicDir, resolverFiles) {
  const seen = new Set();
  for (const f of resolverFiles) { const d = topFolder(f); if (d) seen.add(d); }
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(musicDir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || seen.has(e.name) || CHANNEL_OWNED.has(e.name)) continue;
    let n = 0;
    try { n = fs.readdirSync(path.join(musicDir, e.name)).filter((f) => AUDIO_RE.test(f)).length; } catch { continue; }
    if (n > 0) out.push({ folder: e.name, files: n });
  }
  return out.sort((a, b) => a.folder.localeCompare(b.folder));
}

/**
 * The full report. `resolverFiles` and `referenced` are passed in rather than
 * computed here, so this never re-derives what the DJ believes — it asks it.
 */
function auditReachability({ musicDir, resolverFiles = [], referenced = [], ledger = null } = {}) {
  const unreached = unreachedFiles(resolverFiles, referenced);
  return {
    checkedAt: new Date().toISOString(),
    musicDir,
    libraryFiles: resolverFiles.length,
    namedByAnAlbum: new Set(referenced).size,
    unreached: {
      total: unreached.length,
      neverPlayed: ledger ? ledger.neverPlayedCount(unreached) : null,
      byFolder: byFolder(unreached),
      note: 'Present and resolvable, but no curated album names them. Deep Cuts airs these, most-neglected first.',
    },
    invisibleFolders: {
      folders: invisibleFolders(musicDir, resolverFiles),
      note: 'Directories the file resolver never lists. This is the condition that silenced The Story of Flaukowski.',
    },
  };
}

module.exports = { auditReachability, unreachedFiles, invisibleFolders, byFolder, AUDIO_RE };
