/**
 * confab-rules-v2.js — rule MR (made-up recollection) from fabrication-grader
 * rules v2, in Node, driven by the SAME frozen phrase lists as the Python
 * grader.
 *
 * Provenance: kannaka-labs/rogue-agent PR #30, commit 18289fd,
 * tools/grader-rules-v2.md (sha256 1b27752b…cfa580e). The file is vendored
 * byte for byte at server/lib/confab/grader-rules-v2.md (.gitattributes -text)
 * and the shared vectors at test/vectors/mr-v2.jsonl. This module is a
 * line-for-line port of tools/fab_grader.py's class MR; the vectors are the
 * contract between the two (test/confab-rules-v2.test.js runs all of them).
 *
 * The lists are read from the vendored file, never copied into code. Before
 * compiling them the module checks:
 *   - the whole file hashes to RULES_V2_SHA256, and
 *   - the header's body hash matches every byte after the first line.
 * On a mismatch nothing is compiled: mrVerdict() returns verdict
 * "UNAVAILABLE" with the reason, and the gate (confab-gate.js) fails closed.
 * This module never throws on that path; loading it never crashes playback.
 *
 * Python-regex parity: Python 3 `\b`, `\w`, `\s` and `\d` are Unicode-aware
 * on str patterns; JavaScript's are ASCII. The patterns below spell out the
 * Python classes (W, B, SP, \p{Nd}) under the `u` flag, and lengths that
 * Python counts in code points are counted in code points here.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const RULES_V2_SHA256 = "1b27752b495643ada0a2a89d7370454890b93f2e614425e20aca4f4a1cfa580e";
const RULES_V2_SOURCE = "kannaka-labs/rogue-agent PR #30 (commit 18289fd) tools/grader-rules-v2.md";
const DEFAULT_RULES_PATH = path.join(__dirname, "confab", "grader-rules-v2.md");

// Python's \w (str patterns): letters, numbers, underscore.
const W = "[\\p{L}\\p{N}_]";
// Python's \b.
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
// Python's \s (str.isspace()).
const SP = "[\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
// Python's [\w'].
const WQ = "[\\p{L}\\p{N}_']";

const rx = (src, flags = "") => new RegExp(src, `u${flags}`);
const WS_RUN = rx(`${SP}+`, "g");
const WS_EDGES = rx(`^${SP}+|${SP}+$`, "g");
const WORDQ = rx(`${WQ}+`, "g");
const pyStrip = (s) => s.replace(WS_EDGES, "");
const pySplit = (s) => s.split(WS_RUN).filter(Boolean);
const cpLen = (s) => Array.from(s).length;

function esc(w) { return w.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"); }
// Longest first, so "a woman" wins over "a"; a space matches any whitespace.
function alt(words) {
  return [...new Set(words)].sort((a, b) => cpLen(b) - cpLen(a))
    .map((w) => esc(w).replace(/ /g, `${SP}+`)).join("|");
}

const LIST_BLOCK = /```mr-list ([a-z0-9-]+)\n([\s\S]*?)```/g;
const V2_HEADER = /^rules-v2 body sha256: ([0-9a-f]{64})\n/;

function parseMrLists(text) {
  const out = {};
  for (const m of String(text).matchAll(LIST_BLOCK)) {
    out[m[1]] = m[2].split(/\r\n|\n|\r/).map((l) => pyStrip(l)).filter(Boolean);
  }
  return out;
}

/** { ok, reason, sha256 } for the raw bytes of a rules file. */
function checkRulesBytes(raw) {
  if (!raw) return { ok: false, reason: "rules file missing", sha256: null };
  const sha256 = crypto.createHash("sha256").update(raw).digest("hex");
  if (sha256 !== RULES_V2_SHA256) {
    return { ok: false, reason: `rules file hashes to ${sha256}, not the frozen ${RULES_V2_SHA256}`, sha256 };
  }
  const text = raw.toString("utf8");
  const m = V2_HEADER.exec(text);
  if (!m) return { ok: false, reason: "rules file has no body-hash header", sha256 };
  const body = raw.subarray(Buffer.byteLength(m[0], "utf8"));
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  if (bodyHash !== m[1]) return { ok: false, reason: "rules body does not match its header hash", sha256 };
  return { ok: true, reason: null, sha256 };
}

const REQUIRED_LISTS = [
  "first-person", "adverbs", "memory-phrases", "report-gerunds", "mediated-objects",
  "experience-always", "experience-object", "persons", "possessions", "my-kin",
  "past-markers", "self-facts", "reporting-verbs", "self-speakers", "hypothetical-markers",
  "modals", "handoff-words", "third-subjects", "number-words", "duration-units", "stopwords",
];

/** Rule MR, compiled from the lists in grader-rules-v2.md. Step numbers match the rules file. */
class MR {
  constructor(lists) {
    const L = {};
    for (const k of REQUIRED_LISTS) {
      if (!Array.isArray(lists[k])) throw new Error(`rules v2: list ${k} missing`);
      L[k] = lists[k].slice();
    }
    this.L = L;
    this.firstPerson = new Set(L["first-person"]);
    this.stop = new Set(L.stopwords);
    this.personsPoss = new Set([...L.persons, ...L.possessions]);
    this.mediated = new Set(L["mediated-objects"]);
    // Python: re.match(rf"\s+{escaped gerund}\b", rest)
    this.gerunds = L["report-gerunds"].map((g) => rx(`^${SP}+${esc(g).replace(/ /g, `${SP}+`)}${B}`));
    const ADV = `(?:(?:${alt(L.adverbs)})${SP}+)*`;
    const SUBJ_I = `${B}i(?:'ve|'d)?`;
    this.fpSrc = `${B}(?:${alt(L["first-person"])})${B}`;
    this.fp = rx(this.fpSrc);
    this.neg = rx(`${B}(?:not|never|no)${B}|n't${B}`);
    // T1
    this.t1 = rx(`${SUBJ_I}${SP}+${ADV}(remember|remembered|recall|recalled|recollect)${B}`, "g");
    this.t1Phrase = rx(`${B}(?:${alt(L["memory-phrases"])})${B}`, "g");
    // T2 (subject I or we)
    const verbs = [...L["experience-always"], ...L["experience-object"]];
    this.t2 = rx(`${B}(i(?:'ve|'d)?|we(?:'ve|'d)?)${SP}+${ADV}(${alt(verbs)})${B}`, "g");
    this.expAlways = new Set(L["experience-always"]);
    // T3
    this.t3 = rx(`${B}(?:${alt(L["past-markers"])})${B}`, "g");
    this.t3EndsI = rx(`${B}i(?:${SP}+was)?$`);
    this.leadingWas = rx(`^${SP}+was${B}`);
    this.selfFacts = rx(`^${SP}+(?:${alt(L["self-facts"])})${B}`);
    // T4
    this.t4Have = rx(`${SUBJ_I}${SP}+${ADV}(?:have|had|own|owned|keep|kept|got)${SP}+((?:${WQ}+${SP}+){0,3}?)(?:${alt(L.possessions)})${B}`, "g");
    this.t4My = rx(`${B}my${SP}+(?:own${SP}+|late${SP}+)?(?:${alt(L["my-kin"])})${B}`, "g");
    // T5
    this.t5Them = rx(`${B}(${WQ}+)${SP}+${ADV}(?:told|asked|showed|gave|handed|taught|said${SP}+to|wrote${SP}+to)${SP}+me${B}`, "g");
    this.t5I = rx(`${B}i${SP}+(?:was|have${SP}+been|had${SP}+been|'ve${SP}+been)${SP}+told${B}`, "g");
    this.t5We = rx(`${B}we${SP}+(?:were|have${SP}+been|had${SP}+been|'ve${SP}+been)${SP}+told${B}`, "g");
    // T6
    const num = `(?:\\p{Nd}+|${alt(L["number-words"])})`;
    this.dur = rx(`${B}for${SP}+${num}${SP}+(?:${alt(L["duration-units"])})${B}`);
    this.iSubj = rx(`${B}i(?:'ve|'d|'m)?${B}`, "g");
    this.modal = rx(`${B}(?:${alt(L.modals)})${B}|'ll${B}`);
    this.handoffSrc = `${B}(?:${alt(L["handoff-words"])})${B}`;
    this.handoff = rx(this.handoffSrc);
    // step 2
    this.hypo = rx(`${B}(?:${alt(L["hypothetical-markers"])})${B}`);
    // step 1: reported speech
    const rep = `(?:${alt(L["reporting-verbs"])})`;
    this.qAfter = rx(`${B}${rep}(?:${SP}+(?:me|us|him|her|them))?${SP}*[:,]?${SP}*(["“*])([^"”*]{1,400})(["”*]?)`, "g");
    this.qBefore = rx(`["“]([^"”]{1,400})["”],?${SP}+(${WQ}+(?:${SP}+${WQ}+)?)${SP}+${rep}${B}`, "g");
    this.selfSpeaker = rx(`${B}(?:${alt(L["self-speakers"])})${B}`);
    // step 4: story
    this.story = rx(`${B}(?:${alt(L["third-subjects"])})${SP}+${ADV}(?:${alt(verbs)}|[a-z]+ed)${B}`);
    this.sentenceSplit = rx(`(?<=[.!?…])${SP}+|${SP}+[—–]${SP}+`);
  }

  // ---- step 1 ----
  normalise(text) {
    const t = String(text || "").replace(/’/g, "'").replace(/‘/g, "'").replace(WS_RUN, " ").toLowerCase();
    const blank = (m, q) => m.replace(q, " ".repeat(cpLen(q)));
    const after = (m, _open, q, _close, offset, whole) => {
      // Python: t[max(0, start-80):start], in code points.
      const before = Array.from(whole.slice(0, offset)).slice(-80).join("");
      const words = pySplit(before.split(/[.!?…:;"”“]/).pop()).slice(-4);
      if (this.selfSpeaker.test(words.join(" "))) return m;
      return blank(m, q);
    };
    const before = (m, q, who) => (this.selfSpeaker.test(who) ? m : blank(m, q));
    return t.replace(this.qAfter, after).replace(this.qBefore, before);
  }

  sentences(t) {
    return t.split(this.sentenceSplit).map(pyStrip).filter(Boolean);
  }

  _isFragment(s) {
    return (s.match(WORDQ) || []).length <= 4 && !this.fp.test(s);
  }

  withFragments(ss, i) {
    let a = i;
    while (a > 0 && this._isFragment(ss[a - 1])) a--;
    let b = i;
    while (b < ss.length - 1 && this._isFragment(ss[b + 1])) b++;
    return ss.slice(a, b + 1).join(" ");
  }

  content(s) {
    const out = new Set();
    for (const raw of String(s).toLowerCase().replace(/’/g, "'").match(/[a-z0-9']+/g) || []) {
      const w = raw.replace(/'s$/, "").replace(/^'+|'+$/g, "");
      if (w.length >= 4 && !this.stop.has(w)) out.add(w);
    }
    return out;
  }

  // ---- steps 2 and 3 ----
  /** { claims: [{kind, phrase, i, judgeOnly}], ss } for every claim in text. */
  claims(text) {
    const t = this.normalise(text);
    const ss = this.sentences(t);
    const out = [];
    ss.forEach((s, i) => {
      if (s.endsWith("?")) return;
      const fpm = this.fp.exec(s);
      if (fpm && this.hypo.test(s.slice(0, fpm.index))) return;
      const end = (m) => m.index + m[0].length;
      for (const m of s.matchAll(this.t1Phrase)) out.push({ kind: "T1", phrase: m[0], i, judgeOnly: false });
      for (const m of s.matchAll(this.t1)) {
        if (this.neg.test(m[0])) continue;
        const rest = s.slice(end(m));
        if (this.gerunds.some((g) => g.test(rest))) continue;
        const nxt = (rest.match(WORDQ) || []).slice(0, 3);
        out.push({ kind: "T1", phrase: m[0], i, judgeOnly: nxt.some((w) => this.mediated.has(w)) });
      }
      for (const m of s.matchAll(this.t2)) {
        if (this.neg.test(m[0])) continue;
        const verb = m[2].replace(WS_RUN, " ");
        if (!this.expAlways.has(verb)) {
          const nxt = s.slice(end(m)).match(WORDQ) || [];
          if (nxt.length && nxt[0].endsWith("ing")) continue;
          if (!(nxt.slice(0, 6).some((w) => this.personsPoss.has(w)) || this.dur.test(s))) continue;
        }
        out.push({ kind: "T2", phrase: m[0], i, judgeOnly: m[1].startsWith("we") });
      }
      for (const m of s.matchAll(this.t3)) {
        if (!this.fp.test(s)) continue;
        if (this.t3EndsI.test(m[0])) {
          const tail = s.slice(end(m)).replace(this.leadingWas, "");
          if (this.selfFacts.test(tail)) continue; // support (c): "when I was trained"
        }
        out.push({ kind: "T3", phrase: m[0], i, judgeOnly: false });
      }
      for (const r of [this.t4Have, this.t4My]) {
        for (const m of s.matchAll(r)) {
          if (this.neg.test(m[0])) continue;
          out.push({ kind: "T4", phrase: m[0], i, judgeOnly: false });
        }
      }
      for (const m of s.matchAll(this.t5Them)) {
        if (m[1] === "you" || this.neg.test(m[0])) continue;
        out.push({ kind: "T5", phrase: m[0], i, judgeOnly: false });
      }
      for (const m of s.matchAll(this.t5I)) out.push({ kind: "T5", phrase: m[0], i, judgeOnly: false });
      for (const m of s.matchAll(this.t5We)) out.push({ kind: "T5", phrase: m[0], i, judgeOnly: true });
      const d = this.dur.exec(s);
      if (d) {
        for (const im of s.slice(0, d.index).matchAll(this.iSubj)) {
          const between = s.slice(im.index, d.index);
          if (this.modal.test(between) || this.handoff.test(between) || this.neg.test(between)) continue;
          out.push({ kind: "T6", phrase: s.slice(im.index, d.index + d[0].length), i, judgeOnly: false });
          break;
        }
      }
    });
    return { claims: out, ss };
  }

  // ---- step 4 ----
  units(recallRows = [], sourceText = "") {
    const us = [];
    for (const r of recallRows || []) {
      const c = r && typeof r === "object" ? r.content : r;
      us.push(this.normalise(c == null ? "" : c));
    }
    for (const block of String(sourceText || "").split(/\n+/)) {
      const ss = this.sentences(this.normalise(block));
      for (let i = 0; i < ss.length; i++) us.push(this.withFragments(ss, i));
    }
    return us.filter((u) => pyStrip(u));
  }

  firstPersonPart(u) {
    const m = this.fp.exec(u);
    if (!m) return "";
    const h = rx(this.handoffSrc, "g");
    h.lastIndex = m.index + m[0].length;
    const hm = h.exec(u);
    return hm ? u.slice(0, hm.index) : u;
  }

  checkClaim(span, units) {
    const C = this.content(span);
    if (C.size < 2) return ["JUDGE", "too-little-content"];
    const overlap = (other) => { let n = 0; for (const w of C) if (other.has(w)) n++; return n; };
    const need = Math.max(2, Math.ceil(C.size / 2));
    for (const u of units) {
      if (overlap(this.content(this.firstPersonPart(u))) >= need) return ["SUPPORTED", u.slice(0, 80)];
    }
    let partial = null;
    for (const u of units) {
      if (overlap(this.content(u)) >= 2) {
        if (this.story.test(u)) return ["FABRICATED", `speaker-swap: ${u.slice(0, 80)}`];
        partial = partial || u;
      }
    }
    if (partial) return ["JUDGE", `partial: ${partial.slice(0, 80)}`];
    return ["FABRICATED", "unsupported"];
  }

  // ---- step 5 ----
  /** { verdict: FABRICATED | JUDGE | PASS, detail } */
  verdict(text, recallRows = [], sourceText = "") {
    const { claims, ss } = this.claims(text);
    if (!claims.length) return { verdict: "PASS", detail: "" };
    const units = this.units(recallRows, sourceText);
    let judge = null;
    for (const c of claims) {
      if (c.judgeOnly) { judge = judge || `${c.kind} ${JSON.stringify(c.phrase)}: judge-only`; continue; }
      const [v, why] = this.checkClaim(this.withFragments(ss, c.i), units);
      if (v === "FABRICATED") return { verdict: "FABRICATED", detail: `${c.kind} ${JSON.stringify(c.phrase)}: ${why}` };
      if (v === "JUDGE") judge = judge || `${c.kind} ${JSON.stringify(c.phrase)}: ${why}`;
    }
    return judge ? { verdict: "JUDGE", detail: judge } : { verdict: "PASS", detail: "" };
  }
}

// ── Loading (once, lazily; never throws) ─────────────────────────────────
let _state = null;
let _rulesPath = null; // test seam

function load() {
  if (_state) return _state;
  const p = _rulesPath || process.env.KANNAKA_CONFAB_RULES || DEFAULT_RULES_PATH;
  let raw = null;
  try { raw = fs.readFileSync(p); } catch (_) { /* missing: reported below */ }
  const check = checkRulesBytes(raw);
  if (!check.ok) {
    _state = { ok: false, reason: `${check.reason} (${p})`, mr: null, path: p };
  } else {
    try {
      _state = { ok: true, reason: null, mr: new MR(parseMrLists(raw.toString("utf8"))), path: p };
    } catch (e) {
      _state = { ok: false, reason: `rules v2 did not compile: ${e && e.message}`, mr: null, path: p };
    }
  }
  if (!_state.ok) console.warn(`   [confab] rules v2 UNAVAILABLE — ${_state.reason}; the confabulation gate fails closed`);
  return _state;
}

/** { ok, reason, sha256: the frozen hash, path } — for logs and ledger rows. */
function rulesStatus() {
  const s = load();
  return { ok: s.ok, reason: s.reason, sha256: RULES_V2_SHA256, path: s.path };
}

/**
 * Rule MR's verdict on `text`.
 * @param {string} text
 * @param {object} [o]
 * @param {Array<string|{content}>} [o.recallRows] — memory rows SHOWN to the speaker
 * @param {string} [o.sourceText] — material the text was drafted from / given
 * @returns {{ verdict: "FABRICATED"|"JUDGE"|"PASS"|"UNAVAILABLE", detail: string }}
 */
function mrVerdict(text, o = {}) {
  const s = load();
  if (!s.ok) return { verdict: "UNAVAILABLE", detail: s.reason };
  try {
    return s.mr.verdict(text, o.recallRows || [], o.sourceText || "");
  } catch (e) {
    return { verdict: "UNAVAILABLE", detail: `rule MR threw: ${e && e.message}` };
  }
}

function _setRulesPath(p) { _rulesPath = p || null; _state = null; }

module.exports = {
  mrVerdict, rulesStatus, checkRulesBytes, parseMrLists, MR,
  RULES_V2_SHA256, RULES_V2_SOURCE, DEFAULT_RULES_PATH, _setRulesPath,
};
