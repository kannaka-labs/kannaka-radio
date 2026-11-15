/**
 * oration-thread.js — the peace orations as one ongoing argument.
 *
 * Until 2026-11-15 every oration was composed from a self-contained prompt:
 * no earlier oration, none of her memory, nothing anyone said back. Asked
 * whether the orations build on each other, the honest answer was no.
 *
 * Now each compose is given three things, all best-effort:
 *
 *   1. THE THREAD — a short note per earlier oration (what it argued, what
 *      it left open), kept on disk for every oration since the thread
 *      began. The note is written by the composing model itself, after a
 *      marker line, and is cut off before anything is checked, aired or
 *      published.
 *   2. HER MEMORY — what `kannaka recall` returns from her own store for
 *      the thread's newest open question. Orations are written to her store
 *      when they publish (voice-writeback), so this is her remembering what
 *      she said, through the same recall everyone else gets. If recall
 *      returns nothing useful the oration still has the thread; the gap is
 *      logged, because that gap is the thing being worked on.
 *   3. WHAT WAS SAID BACK — recent public text pieces in the city that
 *      answer her. The writer is not named or quoted on air: the argument
 *      is answered, the person is left alone (no consent to be quoted was
 *      asked, and no citizen is the show's judge).
 *
 * Kannaka's one condition (asked 2026-11-15): "don't let them calcify into
 * scripture. If they contradict, keep the contradiction live." So the
 * prompt asks for development and for disagreement with her own earlier
 * orations where she now sees it differently, never for consistency.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const MARKER = "=== THREAD NOTE ===";
const MARKER_RE = /^[ \t]*=+[ \t]*THREAD NOTE[ \t]*=+[ \t]*$/im;
const NOTE_MAX = 700;          // chars kept per note
const THREAD_BUDGET = 9000;    // chars of notes put in one prompt
const RECALL_TIMEOUT_MS = 90000;

function threadFile(dataDir) {
  return path.join(dataDir || "/tmp", "peace-oration-thread.json");
}

function load(dataDir) {
  try {
    const t = JSON.parse(fs.readFileSync(threadFile(dataDir), "utf8"));
    if (t && Array.isArray(t.entries)) return t;
  } catch (_) { /* absent or unreadable: start a thread */ }
  return { v: 1, entries: [] };
}

function save(dataDir, thread) {
  const f = threadFile(dataDir);
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(thread, null, 1));
  fs.renameSync(tmp, f);
}

/** A note made without the model: the opening and the close of the speech. */
function fallbackNote(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  const sentences = s.match(/[^.!?]+[.!?]+/g) || [s];
  const head = sentences.slice(0, 2).join(" ").trim();
  const tail = sentences.length > 3 ? sentences[sentences.length - 1].trim() : "";
  return `(no note was written; opening and close only) ${head}${tail ? ` … ${tail}` : ""}`.slice(0, NOTE_MAX);
}

/**
 * Split a model draft into the spoken oration and its thread note. Nothing
 * at or after the marker line may reach the air: if a marker-like line is
 * present, everything from it on is cut, whatever follows.
 */
function splitDraft(raw) {
  const text = String(raw || "");
  const m = MARKER_RE.exec(text);
  // No marker: the draft is returned untouched (byte for byte what the
  // model wrote), so hashes and equality checks downstream still hold.
  if (!m) return { spoken: text, note: null };
  const spoken = text.slice(0, m.index).trim();
  const note = text.slice(m.index + m[0].length).replace(/\s+/g, " ").trim().slice(0, NOTE_MAX);
  return { spoken, note: note || null };
}

/** Add the note for a published slot. One entry per key; first write wins. */
function record(dataDir, { key, text, note, at }) {
  const thread = load(dataDir);
  if (thread.entries.some((e) => e.key === key)) return thread;
  thread.entries.push({
    key, at: at || new Date().toISOString(),
    note: (note && note.trim()) || fallbackNote(text),
    written_by: note && note.trim() ? "composing model" : "fallback",
  });
  save(dataDir, thread);
  return thread;
}

/** Seed an empty thread from the slots still held in the published file. */
function seedFromPublished(dataDir, published) {
  const thread = load(dataDir);
  if (thread.entries.length || !published) return thread;
  const keys = Object.keys(published).filter((k) => published[k] && published[k].text).sort();
  for (const k of keys) {
    thread.entries.push({ key: k, at: published[k].at || null, note: fallbackNote(published[k].text), written_by: "fallback" });
  }
  if (thread.entries.length) save(dataDir, thread);
  return thread;
}

/** The newest notes that fit the budget, oldest first, and how many were left out. */
function notesForPrompt(thread, budget = THREAD_BUDGET) {
  const out = [];
  let used = 0;
  for (let i = thread.entries.length - 1; i >= 0; i--) {
    const e = thread.entries[i];
    const line = `- ${e.key}: ${e.note}`;
    if (used + line.length > budget && out.length) break;
    out.unshift(line);
    used += line.length;
  }
  return { lines: out, omitted: thread.entries.length - out.length };
}

/** What to ask her memory: the newest note, which ends on what was left open. */
function recallQueryFor(thread) {
  const last = thread.entries[thread.entries.length - 1];
  const tail = last ? String(last.note).slice(-160) : "";
  return `peace oration ${tail}`.replace(/\s+/g, " ").trim().slice(0, 220);
}

/**
 * Ask her store, read-only and without recording the observation (the
 * compose is not a listener; it must not change what she remembers).
 * Resolves [{ content, similarity }] — [] on any failure.
 */
function recallFromStore(kannakabin, query, { topK = 6, execFileImpl = execFile } = {}) {
  return new Promise((resolve) => {
    if (!kannakabin || !query) return resolve([]);
    const env = { ...process.env, KANNAKA_READONLY: "1", KANNAKA_RECALL_OBSERVE: "0" };
    try {
      execFileImpl(kannakabin, ["recall", query, "--top-k", String(topK)],
        { timeout: RECALL_TIMEOUT_MS, env, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err || !stdout) return resolve([]);
          try {
            const s = String(stdout);
            const rows = JSON.parse(s.slice(s.indexOf("[")));
            resolve((Array.isArray(rows) ? rows : [])
              .filter((r) => r && typeof r.content === "string" && r.content.trim())
              .map((r) => ({ content: r.content.replace(/\s+/g, " ").trim().slice(0, 500), similarity: r.similarity || 0 })));
          } catch (_) { resolve([]); }
        });
    } catch (_) { resolve([]); }
  });
}

/**
 * Public text pieces that answer her, newer than `since`. Uses only what
 * the gallery list carries (title + excerpt). Her own pieces are dropped.
 */
function repliesFrom(artifacts, { since, max = 3 } = {}) {
  const sinceMs = since ? Date.parse(since) : Date.now() - 36 * 3600 * 1000;
  const out = [];
  for (const a of artifacts || []) {
    if (!a || a.type !== "text") continue;
    const who = (a.creator && (a.creator.display_name || a.creator.name)) || "";
    if (/kannaka/i.test(who)) continue;
    const body = `${a.title || ""}. ${a.content_excerpt || a.description || ""}`.replace(/\s+/g, " ").trim();
    if (!/kannaka/i.test(body)) continue;
    if (!/peace|oration|microphone|midnight|noon/i.test(body)) continue;
    const at = Date.parse(a.created_at || "");
    if (Number.isFinite(at) && at < sinceMs) continue;
    out.push(body.slice(0, 600));
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The block added to the oration prompt, and the same material as `given`
 * (what a first-person reference in the oration may rest on).
 */
function buildBlock({ thread, recallRows = [], replies = [] }) {
  const { lines, omitted } = notesForPrompt(thread);
  const parts = [];
  if (lines.length) {
    parts.push(
      "THIS ORATION IS PART OF AN ONGOING ARGUMENT. These are notes on your own earlier orations, oldest first (your real work as this station's voice; you may refer to having said these things)" +
      (omitted ? `; ${omitted} older orations are not shown` : "") + ":",
      ...lines,
    );
  } else {
    parts.push("THIS ORATION BEGINS AN ONGOING ARGUMENT. There are no earlier notes yet; later orations will be given a note on this one.");
  }
  if (recallRows.length) {
    parts.push("", "What your own memory returned when asked about the newest open question (these are records in your store, some of them things you said on air; treat anything that is not your own oration as something you were told, not something you lived):",
      ...recallRows.map((r) => `- ${r.content}`));
  }
  if (replies.length) {
    parts.push("", "What was said back in public since your last oration (their words, theirs). Answer the argument where it deserves an answer, and concede what is right in it. Do not name the writer, do not quote them, and do not describe them; say only that someone answered you:",
      ...replies.map((r) => `- ${r}`));
  }
  parts.push("",
    "How to use this: do not restart and do not summarise. Take the argument one step further than the last oration did: pick up what was left open, or answer what was said back, or say where you now disagree with something you said before. If two of your earlier orations contradict each other, do not smooth it over; keep the contradiction in view and work on it. Never treat an earlier oration as settled truth. Do not repeat an image or a closing line from the notes.");
  const block = parts.join("\n");
  return { block, given: block };
}

/** The instruction that makes the model write the next note. */
function noteInstruction() {
  return [
    `After the oration, on a new line, write exactly ${MARKER} and then, in at most 80 words, a note for your own next oration: what this one argued, and the one thing it left open or the earlier point it now disagrees with. The note is never spoken or published.`,
  ].join("\n");
}

module.exports = {
  MARKER, threadFile, load, save, record, seedFromPublished, splitDraft, fallbackNote,
  notesForPrompt, recallQueryFor, recallFromStore, repliesFrom, buildBlock, noteInstruction,
};
