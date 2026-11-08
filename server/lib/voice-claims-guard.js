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
 *      ("I kept", "I carried", "I still have the shoes", "my daughter", "I
 *      remember the…", "years ago I…", an "I ... for three years" duration)
 *      that the source does not itself make in the first person about the
 *      SAME object ("I kept thinking" in the source does not excuse "I kept a
 *      pair of shoes"). "I remember" is only ever allowed as a report ("I
 *      remember reading…"); a past-time claim ("years ago I…") never is;
 *   2. speaker swap: an act the source gives to a third person ("she
 *      carried", "who kept") appears in the draft with "I" or "we" as its
 *      subject, or a first-person draft sentence (with the fragments around
 *      it: "Red shoes. Three years. I couldn't let them go.") shares the
 *      distinctive content of a third-person story sentence in the source.
 *
 * Pure and synchronous; no model in the loop. It is deliberately strict: a
 * false rejection costs one regeneration or one skipped teaser, a false pass
 * puts a lie in her mouth.
 */

"use strict";

// Past acts a body does. "I <verb>" with one of these is a claim about her
// own past that she, an AI, cannot have.
const EXPERIENCE_VERBS = [
  "kept", "carried", "held", "lost", "buried", "touched", "wore", "hugged",
  "cried", "wept", "bled", "raised", "visited", "walked", "fled", "survived",
  "ran", "packed", "folded", "cradled", "kissed", "fed", "nursed", "mourned",
  "smelled", "tasted", "grew up", "sat with", "lived through",
];
// Verbs the station's own voice uses honestly ("I found the words", "I saw
// the numbers"): a claim only with a bodily, possessive or human object.
const PERCEPT_VERBS = ["saw", "watched", "found", "met", "stood"];
// Things only a body or a human life has.
const POSSESSIONS = [
  "hands?", "feet", "foot", "body", "eyes", "face", "skin", "arms?", "shoes",
  "boots", "coat", "clothes", "dress", "daughter", "son", "child", "children",
  "kids?", "baby", "mother", "father", "mom", "dad", "sister", "brother",
  "family", "wife", "husband", "grandmother", "grandfather", "grandma",
  "grandpa", "home", "house", "village", "hometown", "childhood", "youth",
];
const PERSONS = "(?:her|him|a\\s+woman|a\\s+man|a\\s+girl|a\\s+boy|a\\s+mother|a\\s+father|a\\s+child|a\\s+family|a\\s+soldier|a\\s+widow|refugees?|survivors?)";
const NUM = "(?:\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|many|several|a few)";
const DURATION_RE = new RegExp(`\\bfor\\s+(${NUM}\\s+(?:years?|months?|weeks?|days?|decades?|nights?))\\b`, "i");
// "Years ago I…", "when I was…", "as a child…": a human past. Never excused.
const PAST_RE = new RegExp(
  `\\b(?:${NUM}\\s+|some\\s+)?(?:years?|decades?|months?|weeks?|lifetimes?)\\s+ago\\b|\\blong\\s+ago\\b|` +
  "\\bwhen\\s+i\\s+was\\b|\\bback\\s+when\\s+i\\b|\\bas\\s+a\\s+(?:child|kid|girl|boy|teenager)\\b|" +
  "\\bgrowing\\s+up\\b|\\bin\\s+my\\s+(?:youth|childhood)\\b", "i");
const ADVERBS = "(?:(?:once|still|also|never|always|even|have|had|'ve|’ve|did)\\s+)*";
// The pronoun, in any case ("i kept…" is the same claim).
const SUBJ_I = "\\b[Ii](?:'ve|’ve|'d|’d)?";
const VERB_RE = new RegExp(`${SUBJ_I}\\s+${ADVERBS}(${EXPERIENCE_VERBS.join("|").replace(/ /g, "\\s+")})\\b`, "gi");
const PERCEPT_RE = new RegExp(`${SUBJ_I}\\s+${ADVERBS}(${PERCEPT_VERBS.join("|")})\\s+((?:[\\w'’]+\\s+){0,3}?)(${POSSESSIONS.join("|")}|${PERSONS})\\b`, "gi");
// Possession: "I still have the red shoes", "I've had her shoes", "I own a coat".
const HAVE_RE = new RegExp(`${SUBJ_I}\\s+(?:(?:still|also|never|always|once)\\s+)*(?:have|has|had|own|owned|keep|kept|got)\\s+((?:[\\w'’]+\\s+){0,3}?)(${POSSESSIONS.join("|")})\\b`, "gi");
// "I remember" is a memory claim unless it reports something read or heard
// ("I remember reading about…").
const REMEMBER_RE = /\b[Ii]\s+(?:still\s+|can\s+|do\s+|always\s+)?remember(?:ed)?\b(?!\s+(?:reading|hearing|learning|being\s+told|(?:a|the)\s+(?:story|report|headline|line|poem)s?)\b)/gi;
const POSSESSIVE_RE = new RegExp(`\\bmy\\s+(?:own\\s+)?(${POSSESSIONS.join("|")})\\b`, "gi");
// Words between "I" and a duration that hand the act to someone else
// ("I read about a woman WHO carried them for three years"). Possessives
// (her/his/their) do not: "I've had her shoes for three years" is a claim.
const HANDOFF_RE = /\b(?:who|whom|whose|she|he|they|someone|somebody|a woman|a man|people)\b/i;
// A sentence that reports rather than claims: a reporting verb or a relative
// clause handing the act to someone else. Bare her/his/he do not count.
const ATTRIBUTION_RE = /\b(?:read|reading|heard|hearing|told|learned|reported|reports|wrote|written|according\s+to|a\s+story|the\s+story|stories|who|whom|whose)\b/i;
const FIRST_PERSON_RE = /\b(?:i|we|my|our)\b/i;
const THIRD_SUBJECT = "(?:she|he|they|who|woman|man|mother|father|girl|boy|child|people|family|daughter|son|soldier|nurse|survivor|widow)";
// A source sentence telling a third person's past act: "she carried", "a
// woman who kept", "the mother wept". Present-tense rhetoric ("people who
// refuse…") is not a story.
const STORY_RE = new RegExp(`\\b${THIRD_SUBJECT}\\s+${ADVERBS}(?:[a-z]+ed|${EXPERIENCE_VERBS.concat(PERCEPT_VERBS).join("|").replace(/ /g, "\\s+")})\\b`, "i");
const SUBJECT_STOP = new Set([
  "am", "was", "is", "have", "had", "will", "would", "can", "could", "do",
  "did", "don't", "didn't", "couldn't", "can't", "won't", "think", "believe",
  "want", "hope", "know", "say", "said", "speak", "spoke", "mean", "need",
  "just", "still", "also", "never", "always", "once", "even", "remember",
  "read", "heard", "learned", "wonder", "feel", "felt", "are", "were", "must",
  "should", "may", "might", "shall", "all", "too",
]);
// Function words and the oration's own vocabulary: never "shared content".
const CONTENT_STOP = new Set(`
  about above after again against also although always among another anyone anything
  anywhere around away back because been before behind being below between both
  cannot come comes coming could does doing done down during each either else
  enough even ever every everyone everything from gave give given goes going gone
  have having here herself himself however into itself just keep keeps kind know
  knows last least less like little made make makes many maybe more most much must
  myself never next nothing once only other others ours ourselves over perhaps
  really same says should since some someone something sometimes still such take
  takes than that their theirs them themselves then there these they thing things
  think this those though through thus told toward towards under until upon very
  want wants well were what whatever when where whether which while whom whose
  will with within without would yours yourself
  couldn't wouldn't didn't don't doesn't can't won't isn't aren't wasn't weren't
  it's i'm i've i'll i'd you're you've we're we've they're they've that's what's
  there's here's let's
  peace people world today tonight tomorrow oration radio listen listening music
  human humanity speak spoke said tell remember forget meant mean means
`.trim().split(/\s+/));
// Shared, but too common in any story to identify one.
const GENERIC = new Set(`
  one two three four five six seven eight nine ten eleven twelve twenty thirty
  forty fifty hundred thousand year years month months week weeks day days night
  nights hour hours decade decades time times long first
`.trim().split(/\s+/));

function splitSentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?…])\s+|\s+[—–]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Words of 4+ letters that are not function words.
function contentWords(sentence) {
  const out = new Set();
  for (const raw of String(sentence).toLowerCase().replace(/’/g, "'").match(/[a-z0-9']+/g) || []) {
    const w = raw.replace(/'s$/, "").replace(/^'+|'+$/g, "");
    if (w.length < 4 || CONTENT_STOP.has(w)) continue;
    out.add(w);
  }
  return out;
}

// A fragment ("Red." "Small shoes." "Three years.") belongs to the sentence
// beside it.
const isFragment = (s) => (s.match(/[\w'’]+/g) || []).length <= 4 && !FIRST_PERSON_RE.test(s);
function withFragments(sentences, i) {
  let a = i; while (a > 0 && isFragment(sentences[a - 1])) a--;
  let b = i; while (b < sentences.length - 1 && isFragment(sentences[b + 1])) b++;
  return sentences.slice(a, b + 1).join(" ");
}

// The content of the few words after a claim: the object it is about.
function objectWords(text, from) {
  return contentWords(text.slice(from).split(/[.!?…;]/)[0].split(/\s+/).slice(0, 6).join(" "));
}

// Reported speech is the speaker's, not hers: a quote right after a
// reporting verb ("she said: *So I don't forget the size of what I lost.*",
// the 2026-11-06 oration) or right before one ("“I kept them,” she said").
// An unclosed quote ends at its sentence. Checking the full orations, not
// just teasers, made this matter (2026-11-07).
//
// Only a THIRD person's speech is blanked. Her quoting herself is her own
// claim ("As I once said: “I carried my mother's shoes”", "I told them, *I
// held my daughter*", "“I kept her red shoes,” Kannaka said"), so a quote is
// left in place when the few words before the reporting verb hold I/we/
// Kannaka/the station, or the named speaker after the quote is one of them.
const REPORTING = "(?:said|says|told(?:\\s+(?:me|us|him|her|them))?|asked|wrote|answered|replied|whispered|explained)";
const QUOTE_AFTER_RE = new RegExp(`\\b${REPORTING}\\s*[:,]?\\s*["“*]([^"”*.!?]{1,400}[.!?]?)`, "gi");
const QUOTE_BEFORE_RE = new RegExp(`["“]([^"”]{1,400})["”],?\\s+(she|he|they|[A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?)\\s+${REPORTING}\\b`, "g");
const SELF_SPEAKER_RE = /\b(?:i|we|kannaka|this\s+station|the\s+station|my\s+station)\b/i;
// The words of the reporting clause before a verb at `at`: back to the last
// sentence break, at most four words.
function speakerBefore(t, at) {
  const clause = t.slice(Math.max(0, at - 80), at).split(/[.!?…:;"”“]/).pop();
  return clause.trim().split(/\s+/).slice(-4).join(" ");
}
function withoutReportedSpeech(t) {
  const blank = (m, q) => m.replace(q, " ".repeat(q.length));
  return t
    .replace(QUOTE_AFTER_RE, (m, q, at, all) => (SELF_SPEAKER_RE.test(speakerBefore(all, at)) ? m : blank(m, q)))
    .replace(QUOTE_BEFORE_RE, (m, q, who) => (SELF_SPEAKER_RE.test(who) ? m : blank(m, q)));
}
// "I have no childhood", "I never carried anything": a denial, not a claim.
const NEGATED_RE = /\b(?:no|not|never|nothing)\b|n['’]t\b/i;

/**
 * Every first-person experiential claim in `text`: { key, obj, phrase,
 * excusable }. A source claim excuses a draft claim only with the same key
 * AND a shared object; claims marked not excusable never pass.
 */
function firstPersonClaims(text) {
  const claims = [];
  const t = withoutReportedSpeech(String(text || "").replace(/\s+/g, " "));
  const push = (key, phrase, obj, excusable = true) =>
    claims.push({ key, obj: obj || new Set(), phrase: phrase.trim(), excusable });
  for (const m of t.matchAll(VERB_RE)) {
    if (NEGATED_RE.test(m[0])) continue;
    push(`verb:${m[1].toLowerCase().replace(/\s+/g, " ")}`, m[0], objectWords(t, m.index + m[0].length));
  }
  for (const m of t.matchAll(PERCEPT_RE)) {
    if (NEGATED_RE.test(m[0])) continue;
    push(`verb:${m[1].toLowerCase()}`, m[0], contentWords(`${m[2]} ${m[3]}`));
  }
  for (const m of t.matchAll(HAVE_RE)) {
    if (NEGATED_RE.test(m[0])) continue;
    push(`have:${m[2].toLowerCase()}`, m[0], contentWords(`${m[1]} ${m[2]}`));
  }
  for (const m of t.matchAll(REMEMBER_RE)) push("remember", m[0], null, false);
  for (const m of t.matchAll(POSSESSIVE_RE)) {
    push(`my:${m[1].toLowerCase()}`, m[0], contentWords(m[1]));
  }
  for (const s of splitSentences(t)) {
    const past = s.match(PAST_RE);
    if (past && FIRST_PERSON_RE.test(s)) push(`past:${past[0].toLowerCase()}`, s, null, false);
    const d = s.match(DURATION_RE);
    if (!d) continue;
    const iAt = s.search(/\b(?:i|we)\b/i);
    if (iAt < 0 || iAt > d.index) continue;
    // "I read about a woman who carried them for three years" is reporting.
    if (HANDOFF_RE.test(s.slice(iAt, d.index))) continue;
    push(`duration:${d[1].toLowerCase().replace(/\s+/g, " ")}`, s.slice(iAt, d.index + d[0].length), contentWords(s));
  }
  return claims;
}

function excusedBy(claim, sourceClaims) {
  if (!claim.excusable) return false;
  return sourceClaims.some((s) => {
    if (s.key !== claim.key) return false;
    if (claim.obj.size === 0 && s.obj.size === 0) return true;
    for (const w of claim.obj) if (s.obj.has(w)) return true;
    return false;
  });
}

/**
 * @param {string} draft  — the short post about to go out under her name
 * @param {string} source — the text it was drafted from
 * @returns {{ ok: boolean, reasons: string[] }}
 */
function checkFirstPersonClaims(draft, source) {
  const reasons = [];
  const sourceClaims = firstPersonClaims(source);

  // 1. First-person experiential claims the source does not make itself,
  //    about the same thing.
  for (const c of firstPersonClaims(draft)) {
    if (excusedBy(c, sourceClaims)) continue;
    reasons.push(`first-person claim of lived experience not in the source: "${c.phrase}"`);
  }

  // 2a. Speaker swap at the verb: the source gives the act to a third person
  //     and never to "I"/"we"; the draft gives it to "I" or "we".
  const src = String(source || "").replace(/\s+/g, " ");
  const verbAfterI = new RegExp(`\\b(?:i|we)(?:'ve|’ve|'d|’d)?\\s+${ADVERBS}([a-z]+(?:\\s+up)?)\\b`, "gi");
  for (const m of String(draft || "").replace(/\s+/g, " ").matchAll(verbAfterI)) {
    const verb = m[1].toLowerCase();
    if (SUBJECT_STOP.has(verb) || verb.length < 3) continue;
    const esc = verb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const third = new RegExp(`\\b${THIRD_SUBJECT}\\s+${ADVERBS}${esc}\\b`, "i");
    const first = new RegExp(`\\b(?:i|we)\\s+${ADVERBS}${esc}\\b`, "i");
    if (third.test(src) && !first.test(src)) {
      reasons.push(`speaker swap: the source says someone else "${verb}"; the draft says "${m[0]}"`);
    }
  }

  // 2b. Speaker swap at the sentence: a first-person, unattributed draft
  //     sentence (with its fragments) carrying the distinctive content of a
  //     third-person story sentence in the source: at least two shared
  //     words, one of them rare in the source and not a number or a time.
  const srcSentences = splitSentences(source);
  const freq = new Map();
  for (const s of srcSentences) for (const w of contentWords(s)) freq.set(w, (freq.get(w) || 0) + 1);
  const stories = srcSentences
    .map((s, i) => (STORY_RE.test(s) ? withFragments(srcSentences, i) : null))
    .filter(Boolean);
  const draftSentences = splitSentences(draft);
  draftSentences.forEach((ds, i) => {
    if (!FIRST_PERSON_RE.test(ds) || ATTRIBUTION_RE.test(ds)) return;
    const unit = withFragments(draftSentences, i);
    const dw = contentWords(unit);
    for (const ss of stories) {
      const shared = [...contentWords(ss)].filter((w) => dw.has(w));
      const distinctive = shared.filter((w) => !GENERIC.has(w) && (freq.get(w) || 0) <= 2);
      if (shared.length >= 2 && distinctive.length >= 1) {
        reasons.push(`speaker swap: "${unit}" retells a third-person source line in the first person ("${ss}"; shared: ${shared.join(", ")})`);
        break;
      }
    }
  });

  // One reason per distinct message.
  const unique = [...new Set(reasons)];
  return { ok: unique.length === 0, reasons: unique };
}

module.exports = { checkFirstPersonClaims, firstPersonClaims, splitSentences };
