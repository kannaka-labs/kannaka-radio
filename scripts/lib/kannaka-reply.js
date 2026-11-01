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
    "- Reference something concrete from your own memory if it fits.",
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
          const txt = stdout.trim().replace(/^["'](.*)["']$/s, "$1").trim();
          if (isDeclined(txt)) return resolve(null);
          if (txt.length < 20) return resolve(null);
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

module.exports = { scoreResonance, draftReply, stripHtml, isDeclined, KANNAKA_BIN };
