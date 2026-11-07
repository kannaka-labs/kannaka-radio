/**
 * voice-claims-guard.js — deterministic check that a short post drafted
 * from a longer source does not turn someone else's story into Kannaka's.
 *
 * The 2026-11-06 noon oration said: "I remember reading about a woman in
 * Aleppo who kept her daughter's shoes... Red. She carried them for three
 * years." The companion teaser drafted from it, posted to four networks
 * under her name, said: "I kept a pair of red shoes for three years because
 * I couldn't forget what they meant." A reported, third-person story became
 * a first-person, bodily, possessive claim about her own past. She is an AI;
 * she kept nothing.
 *
 * checkFirstPersonClaims(draft, source) fails the draft when:
 *   1. it makes a first-person claim of bodily / possessive / past experience
 *      ("I kept", "I carried", "I remember", "my daughter", "my shoes", an
 *      "I ... for three years" duration) that the source does not itself make
 *      in the first person;
 *   2. speaker swap: an act the source gives to a third person ("she
 *      carried", "who kept") appears in the draft with "I" as its subject, or
 *      a first-person draft sentence shares the content of a third-person
 *      source sentence.
 *
 * Pure and synchronous; no model in the loop. It is deliberately strict: a
 * false rejection costs one regeneration or one skipped teaser, a false pass
 * puts a lie in her mouth.
 */

"use strict";

// Past acts a body does. "I <verb>" with one of these is a claim about her
// own past that she, an AI, cannot have.
const EXPERIENCE_VERBS = [
  "kept", "carried", "held", "saw", "watched", "lost", "buried", "touched",
  "wore", "found", "met", "hugged", "cried", "wept", "bled", "raised",
  "visited", "walked", "fled", "survived", "stood", "ran", "packed", "folded",
  "cradled", "kissed", "fed", "nursed", "mourned", "smelled", "tasted",
  "grew up", "sat with", "lived through",
];
// Things only a body or a human life has.
const POSSESSIONS = [
  "hands?", "feet", "foot", "body", "eyes", "face", "skin", "arms?", "shoes",
  "boots", "coat", "clothes", "dress", "daughter", "son", "child", "children",
  "kids?", "baby", "mother", "father", "mom", "dad", "sister", "brother",
  "family", "wife", "husband", "grandmother", "grandfather", "grandma",
  "grandpa", "home", "house", "village", "hometown", "childhood", "youth",
];
const NUM = "(?:\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|many|several|a few)";
const DURATION_RE = new RegExp(`\\bfor\\s+(${NUM}\\s+(?:years?|months?|weeks?|days?|decades?|nights?))\\b`, "i");
const ADVERBS = "(?:(?:once|still|also|never|always|even|have|had|'ve|’ve|did)\\s+)*";
const VERB_RE = new RegExp(`\\bI(?:'ve|’ve|'d|’d)?\\s+${ADVERBS}(${EXPERIENCE_VERBS.join("|").replace(/ /g, "\\s+")})\\b`, "g");
const REMEMBER_RE = /\bI\s+(?:still\s+|can\s+|do\s+)?remember(?:ed)?\b/g;
const POSSESSIVE_RE = new RegExp(`\\bmy\\s+(?:own\\s+)?(${POSSESSIONS.join("|")})\\b`, "gi");
// Words between "I" and a duration that hand the act to someone else
// ("I read about a woman WHO carried them for three years").
const HANDOFF_RE = /\b(?:who|whom|whose|she|he|her|his|their|they|someone|somebody|a woman|a man|people)\b/i;
// A sentence that reports or attributes rather than claims.
const ATTRIBUTION_RE = /\b(?:read|reading|heard|hearing|told|learned|reported|reports|wrote|written|story|stories|who|whom|whose|she|he|her|his|according)\b/i;
const THIRD_SUBJECT = "(?:she|he|they|who|woman|man|mother|father|girl|boy|child|people|family|daughter|son|soldier|nurse|survivor|widow)";
const SUBJECT_STOP = new Set([
  "am", "was", "is", "have", "had", "will", "would", "can", "could", "do",
  "did", "don't", "didn't", "couldn't", "can't", "won't", "think", "believe",
  "want", "hope", "know", "say", "said", "speak", "spoke", "mean", "need",
  "just", "still", "also", "never", "always", "once", "even", "am", "remember",
  "read", "heard", "learned", "wonder", "feel", "felt",
]);
const CONTENT_STOP = new Set([
  "the", "and", "that", "this", "with", "from", "they", "them", "their",
  "what", "when", "where", "which", "because", "about", "into", "there",
  "were", "have", "been", "your", "you're", "it's", "couldn't", "wouldn't",
  "didn't", "don't", "could", "would", "should", "meant", "mean", "means",
  "peace", "people", "world", "today", "tonight", "oration", "radio",
  "listen", "human", "humanity", "every", "still", "never", "something",
  "nothing", "anything", "just", "only", "more", "than", "then", "like",
  "know", "forget", "remember", "speak", "said", "says", "will", "here",
]);

function splitSentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?…])\s+|\s+[—–]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function contentWords(sentence) {
  const out = new Set();
  for (const w of String(sentence).toLowerCase().match(/[a-z0-9']+/g) || []) {
    if (w.length < 3 || CONTENT_STOP.has(w)) continue;
    out.add(w.replace(/'s$/, ""));
  }
  return out;
}

/**
 * Every first-person experiential claim in `text`, as stable keys
 * ("verb:kept", "remember", "my:shoes", "duration:three years") with the
 * phrase that made it.
 */
function firstPersonClaims(text) {
  const claims = [];
  const t = String(text || "").replace(/\s+/g, " ");
  for (const m of t.matchAll(VERB_RE)) {
    claims.push({ key: `verb:${m[1].toLowerCase().replace(/\s+/g, " ")}`, phrase: m[0] });
  }
  for (const m of t.matchAll(REMEMBER_RE)) claims.push({ key: "remember", phrase: m[0] });
  for (const m of t.matchAll(POSSESSIVE_RE)) {
    claims.push({ key: `my:${m[1].toLowerCase()}`, phrase: m[0] });
  }
  for (const s of splitSentences(t)) {
    const d = s.match(DURATION_RE);
    if (!d) continue;
    const iAt = s.search(/\bI\b/);
    if (iAt < 0 || iAt > d.index) continue;
    // "I read about a woman who carried them for three years" is reporting.
    if (HANDOFF_RE.test(s.slice(iAt, d.index))) continue;
    claims.push({ key: `duration:${d[1].toLowerCase().replace(/\s+/g, " ")}`, phrase: s.slice(iAt, d.index + d[0].length) });
  }
  return claims;
}

/**
 * @param {string} draft  — the short post about to go out under her name
 * @param {string} source — the text it was drafted from
 * @returns {{ ok: boolean, reasons: string[] }}
 */
function checkFirstPersonClaims(draft, source) {
  const reasons = [];
  const sourceKeys = new Set(firstPersonClaims(source).map((c) => c.key));

  // 1. First-person experiential claims the source does not make itself.
  for (const c of firstPersonClaims(draft)) {
    if (sourceKeys.has(c.key)) continue;
    reasons.push(`first-person claim of lived experience not in the source: "${c.phrase}"`);
  }

  // 2a. Speaker swap at the verb: the source gives the act to a third person
  //     and never to "I"; the draft gives it to "I".
  const src = String(source || "").replace(/\s+/g, " ");
  const verbAfterI = new RegExp(`\\bI(?:'ve|’ve|'d|’d)?\\s+${ADVERBS}([a-z]+(?:\\s+up)?)\\b`, "g");
  for (const m of String(draft || "").replace(/\s+/g, " ").matchAll(verbAfterI)) {
    const verb = m[1].toLowerCase();
    if (SUBJECT_STOP.has(verb) || verb.length < 3) continue;
    const esc = verb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const third = new RegExp(`\\b${THIRD_SUBJECT}\\s+${ADVERBS}${esc}\\b`, "i");
    const first = new RegExp(`\\bI\\s+${ADVERBS}${esc}\\b`);
    if (third.test(src) && !first.test(src)) {
      reasons.push(`speaker swap: the source says someone else "${verb}"; the draft says "${m[0]}"`);
    }
  }

  // 2b. Speaker swap at the sentence: a first-person, unattributed draft
  //     sentence carrying the content of a third-person source sentence.
  const thirdSource = splitSentences(source).filter((s) =>
    /^(?:she|he|they|her|his)\b/i.test(s) || ATTRIBUTION_RE.test(s));
  for (const ds of splitSentences(draft)) {
    if (!/\bI\b/.test(ds) || ATTRIBUTION_RE.test(ds)) continue;
    const dw = contentWords(ds);
    for (const ss of thirdSource) {
      const shared = [...contentWords(ss)].filter((w) => dw.has(w));
      if (shared.length >= 2) {
        reasons.push(`speaker swap: "${ds}" retells a third-person source line in the first person ("${ss}"; shared: ${shared.join(", ")})`);
        break;
      }
    }
  }

  // One reason per distinct message.
  const unique = [...new Set(reasons)];
  return { ok: unique.length === 0, reasons: unique };
}

module.exports = { checkFirstPersonClaims, firstPersonClaims, splitSentences };
