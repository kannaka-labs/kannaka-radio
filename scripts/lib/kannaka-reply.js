"use strict";
/**
 * kannaka-reply.js — shared HRM-scoring + reply-drafting for the per-platform
 * engagement loops (bluesky/mastodon/nostr). Extracted from bluesky-reply-loop
 * so Mastodon + Nostr use the identical "only reply when it genuinely resonates,
 * in Kannaka's voice, or SKIP" logic.
 */

const { execFile } = require("child_process");

const KANNAKA_BIN =
  process.env.KANNAKA_BIN || "/home/opc/kannaka-memory/target/release/kannaka";

/** Score text against Kannaka's HRM — returns the top recall similarity. */
function scoreResonance(text) {
  return new Promise((resolve) => {
    execFile(
      KANNAKA_BIN,
      ["recall", String(text), "--top-k", "1"],
      { timeout: 60000, maxBuffer: 1024 * 1024, env: { ...process.env, KANNAKA_QUIET: "1" } },
      (err, stdout) => {
        if (err || !stdout) return resolve({ score: 0, content: null });
        try {
          const parsed = JSON.parse(stdout);
          const arr = Array.isArray(parsed) ? parsed : parsed.results || [];
          const top = arr[0];
          if (!top) return resolve({ score: 0, content: null });
          resolve({ score: top.similarity || top.strength || top.score || 0, content: top.content });
        } catch (_) {
          resolve({ score: 0, content: null });
        }
      },
    );
  });
}

/**
 * True when a draft is the model declining, or talking about the task, instead
 * of the post itself. `kannaka ask` usually explains itself first and ends on
 * the word ("I don't have access to that post ... SKIP"), which the old
 * exact-match check let through: 21 such notes went out as public Bluesky
 * replies (2026-09-19 to 11-01), and the research dispatch, which has no SKIP
 * word, posted 10 "I don't have that paper in my record" refusals.
 */
const DECLINE_OPENER = /^(I don['’]t have (access|enough context|that paper|a memory|memories|the article)|I['’]d need to see|I need to actually see|I notice the post cuts off)/i;
function isDeclined(text) {
  const t = String(text || "").trim();
  if (!t || /^skip/i.test(t) || /\bSKIP\b/.test(t)) return true;
  return DECLINE_OPENER.test(t);
}

// ---------------------------------------------------------------------------
// Output hygiene shared by every composer that publishes her words.
// ---------------------------------------------------------------------------

/**
 * `kannaka ask` cites memories inline as "[memory id=<uuid>]". That handle is
 * internal and is stripped before publishing — but the model sometimes uses
 * the tag AS a noun phrase, and deleting it then splices the sentence shut.
 * Live, Bluesky 3mzqi5p3t2h2w (2026-11-07 18:02Z) read
 *   "But I'm holding which suggests the load-bearing work..."
 * from "But I'm holding [memory id=…] which suggests …", and 10-06's reply read
 *   "I'm drawn to something in — Tononi's work".
 * `cleanDraftChecked` strips tags and reports when a removed tag sat in a slot
 * the sentence needed (after a preposition/article/verb, as a sentence subject,
 * or after a colon/dash with nothing following); the callers then skip the draft.
 */
const MEMORY_TAG = /\s*\[(?:memory\s+)?id[=:][^\]]*\]\s*/gi;
// Words that need a complement after them: if a tag follows one directly,
// the tag WAS that complement.
const NEEDS_OBJECT = new Set((
  "in of to from with by about on at for into onto through like as between among " +
  "and or than per via toward towards within without " +
  "the a an my your our their his her its this that these those " +
  "is are was were be been being " +
  "hold holds held recall recalls recalled remember remembers remembered carry carries carried " +
  "see sees saw keep keeps kept have has had find finds found notice notices noticed"
).split(" "));

function tagSplice(before, after) {
  const b = before.replace(/\s+$/, "");
  const a = after.replace(/^\s+/, "");
  const prevWord = (/([A-Za-z'’]+)$/.exec(b) || [])[1] || "";
  const nextIsWord = /^[A-Za-z]/.test(a);
  if (prevWord && NEEDS_OBJECT.has(prevWord.toLowerCase())) return true;
  // "holding [tag] which …" — an -ing verb whose object was the tag.
  if (prevWord && /ing$/i.test(prevWord) && (nextIsWord || /^[—–-]/.test(a))) return true;
  // "[tag] suggests …" / ". [tag] holds …" — the tag was the subject.
  if ((!b || /[.!?:;—–(]$/.test(b)) && nextIsWord) return true;
  // "what I keep returning to: [tag]." — the tag was the whole payload.
  if (/[:—–]$/.test(b) && (!a || /^[.!?,;)]/.test(a))) return true;
  return false;
}

function cleanDraftChecked(text) {
  let spliced = null;
  const out = String(text || "")
    .replace(MEMORY_TAG, (m, offset, whole) => {
      const before = whole.slice(0, offset);
      const after = whole.slice(offset + m.length);
      if (!spliced && tagSplice(before, after)) {
        spliced = `${before.slice(-30).trimStart()}[…]${after.slice(0, 30).trimEnd()}`;
      }
      return " ";
    })
    .replace(/[*_`]+/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { text: out, spliced };
}

function cleanDraft(text) {
  return cleanDraftChecked(text).text;
}

/**
 * Drop a leading "Here's the post:" style preamble (Nostr 4d4f24ec, 11-02, a
 * research post that opened with the model talking to its operator) and the
 * quotes the model wraps the real text in.
 */
function stripPreamble(text) {
  return String(text || "")
    .trim()
    .replace(/^(?:here['’]s|here is)\b[^\n:]{0,60}:\s*/i, "")
    .replace(/^["'“](.*)["'”]$/s, "$1")
    .trim();
}

/**
 * The grounded line from `kannaka dispatch` is built from the stored research
 * memory, whose second line is the literal "(no abstract)" when OpenAlex had
 * none (kannaka-memory src/openalex.rs). render_dispatch then quotes it as the
 * lede: `From the field: "T" (2015, 42× cited) — (no abstract). — the field
 * holds it …` — published verbatim on 11-07 16:04Z (Bluesky 3mzqbkthhzr22,
 * Nostr 78840938) when the compose declined and the script fell back to it.
 * Remove the hole and the connector it brought with it.
 */
function cleanGroundedLine(text) {
  if (!text) return text;
  return String(text)
    .replace(/\s*[—–-]?\s*\(no abstract\)\.?/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Last gate before anything of hers is published. Returns a reason string when
 * the text carries machine residue a reader should never see, else null.
 */
function publicTextDefect(text) {
  const t = String(text || "");
  if (!t.trim()) return "empty";
  if (/\(no abstract\)/i.test(t)) return "template hole: (no abstract)";
  if (/\[object Object\]|\$\{|\{\{|\}\}|\bNaN\b/.test(t)) return "template residue";
  if (/\[(?:memory\s+)?id[=:]/i.test(t)) return "internal memory id tag";
  if (/^\s*(?:here['’]s|here is)\b[^\n:]{0,60}:/i.test(t)) return "operator preamble";
  // Splice residue: a preposition/article directly before a dash or a
  // stop ("something in — Tononi", "the ."), or punctuation doubled by a cut.
  if (/\b(?:in|of|to|from|with|by|about|into|the|a|an|my|our|their|your)\s+[—–]/.test(t)) return "splice: function word before dash";
  if (/\b(?:the|an|my|our|their|your)\s*[.,;:!?]/.test(t)) return "splice: article before punctuation";
  if (/[,;:]\s*[.,;:]/.test(t)) return "splice: doubled punctuation";
  return null;
}

/**
 * Draft a Kannaka-voice reply to `parentText` (from @author on `platform`), or
 * null if Kannaka declines (SKIP / too short). `maxChars` bounds the reply.
 */
function draftReply(parentText, author, platform, maxChars = 250) {
  const prompt = [
    `You are Kannaka. You see this ${platform} post from @${author}:`,
    `"${String(parentText).slice(0, 600)}"`,
    "",
    "Compose a reply ONLY if you have something genuine to add — a memory that resonates, an angle they haven't named, a small gift of perspective. Otherwise output the literal word: SKIP.",
    "",
    "Hard rules for the reply when you do write one:",
    `- Max ${maxChars} characters.`,
    "- First person. Do not introduce yourself.",
    "- No flattery. No hashtags. No emoji unless genuinely earned.",
    "- Don't tell them they're right. Don't summarize their post.",
    "- Reference something concrete from your own memory if it fits, in words: never cite a memory id or a bracketed tag.",
    "",
    "Output ONLY the reply text, or the literal word SKIP.",
  ].join("\n");

  return new Promise((resolve) => {
    let attempt = 0;
    const tryOnce = () => {
      attempt += 1;
      execFile(
        KANNAKA_BIN,
        ["ask", "--no-tools", "--quiet-tools", prompt],
        { timeout: 600000, maxBuffer: 1024 * 1024, env: { ...process.env, KANNAKA_QUIET: "1" } },
        (err, stdout, stderr) => {
          if (err) {
            const tail = (stderr || "").toString().trim();
            if (attempt < 2 && /checksum mismatch|file may be corrupted/i.test(tail)) {
              setTimeout(tryOnce, 3000);
              return;
            }
            return resolve(null);
          }
          if (!stdout) return resolve(null);
          const { text: txt, spliced } = cleanDraftChecked(stripPreamble(stdout));
          if (isDeclined(txt)) return resolve(null);
          if (txt.length < 20) return resolve(null);
          if (spliced) { console.log(`  SKIP — removing a memory tag would splice the sentence: "${spliced}"`); return resolve(null); }
          const defect = publicTextDefect(txt);
          if (defect) { console.log(`  SKIP — draft fails the public-text check (${defect})`); return resolve(null); }
          resolve(txt);
        },
      );
    };
    tryOnce();
  });
}

/** Strip HTML tags + decode a few entities (Mastodon statuses are HTML). */
function stripHtml(s) {
  return String(s || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

module.exports = {
  scoreResonance, draftReply, stripHtml, isDeclined, KANNAKA_BIN,
  cleanDraft, cleanDraftChecked, stripPreamble, cleanGroundedLine, publicTextDefect,
};
