/**
 * onair-state.js — the scheduled show the stream is airing, kept on disk.
 *
 * A restart (deploy, crash, a hand-typed `systemctl restart`) wiped the
 * scheduler's in-memory "a show is airing" state, and the station came
 * back up on a song: the show was simply gone, mid-episode. The stream
 * now records each scheduled show when it starts streaming and clears it
 * when the show finishes; a scheduler starting up reads the record and
 * resumes its show where the restart cut it.
 *
 * The record is one small JSON file:
 *   { file, folder, startedAtMs }
 * startedAtMs is when the show's audio began on air (back-dated by any
 * resume offset), so after any number of restarts `now - startedAtMs` is
 * still how far into the show the listener is.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_FILE = path.join(os.homedir(), ".kannaka", "radio-onair.json");
// Don't resume into the last few seconds of a show, and never resume a
// record older than this: the station was down long enough that the
// slot is over.
const END_MARGIN_MS = 30 * 1000;
const MAX_AGE_MS = 4 * 60 * 60 * 1000;

function stateFile() {
  return process.env.KANNAKA_RADIO_ONAIR_FILE || DEFAULT_FILE;
}

function read(file = stateFile()) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    if (s && typeof s.file === "string" && typeof s.folder === "string" && Number.isFinite(s.startedAtMs)) return s;
  } catch (_) { /* missing or unreadable: nothing on air */ }
  return null;
}

/** Record a scheduled show starting on air (offsetMs into it, if resumed). */
function record(track, nowMs = Date.now(), file = stateFile()) {
  if (!track || !track.isPodcastScheduled || !track.file) return;
  const s = {
    file: track.file,
    folder: track.album || path.dirname(track.file),
    startedAtMs: nowMs - (track.resumeAtMs || 0),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.warn(`[onair-state] could not record ${track.file}: ${e.message}`);
  }
}

/** Clear the record once the show it names has finished. */
function clear(trackFile, file = stateFile()) {
  const s = read(file);
  if (!s || s.file !== trackFile) return;
  try { fs.unlinkSync(file); } catch (_) {}
}

/**
 * Should a scheduler for `folder` resume an interrupted show, and where?
 * @returns {{file: string, offsetMs: number}|null}
 */
function resumePlan(state, folder, nowMs, durationMs) {
  if (!state || state.folder !== folder) return null;
  const offsetMs = nowMs - state.startedAtMs;
  if (!(offsetMs > 0) || offsetMs > MAX_AGE_MS) return null;
  if (!(durationMs > 0) || offsetMs >= durationMs - END_MARGIN_MS) return null;
  return { file: state.file, offsetMs };
}

module.exports = { read, record, clear, resumePlan, stateFile, END_MARGIN_MS, MAX_AGE_MS };
