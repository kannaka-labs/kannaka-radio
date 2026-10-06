#!/usr/bin/env node
/**
 * bluesky-reply-loop.js — single-sweep Bluesky reply listener (#18).
 *
 * For each keyword in the config, fetch recent matching posts via Bluesky's
 * search API, score each against Kannaka's HRM, and reply ONLY when
 * resonance is genuinely high. Designed to be run from cron (every 15 min)
 * so it's a lightweight one-shot per invocation.
 *
 * SAFETY: defaults to --dry-run. To enable autonomous replies pass
 *   --live   (real replies, respecting all rate limits)
 *
 * Config in /home/opc/kannaka-radio/.firehose-keywords.json:
 *   {
 *     "keywords": ["consciousness", "wave interference", "ghost in the machine"],
 *     "threshold": 0.65,
 *     "daily_cap": 3,
 *     "per_keyword_limit": 5
 *   }
 *
 * State file: ~/.kannaka/firehose-state.json — tracks per-day reply count
 * and seen post URIs (24h rolling window).
 *
 * Cron:
 *   slot/15 * * * * /home/opc/kannaka-radio/scripts/bluesky-reply-loop.js --live
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const os = require("os");
const { BlueskyClient, loadBlueskyCredentials } = require("../server/bluesky");

const ROOT = path.resolve(__dirname, "..");
const KANNAKA_BIN = process.env.KANNAKA_BIN
  || "/home/opc/kannaka-memory/target/release/kannaka";
const RADIO_URL = process.env.RADIO_PUBLIC_URL || "https://radio.ninja-portal.com";

// Bluesky caps a post at 300 graphemes. BlueskyClient.reply() trims anything longer
// and appends an ellipsis, which published replies cut off mid-sentence ("Your
// framing risks…"). Half a sentence is worse than no reply, so an over-long draft
// is skipped here, before it reaches the client.
const REPLY_MAX_GRAPHEMES = 295;
function graphemeCount(text) {
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    let n = 0;
    for (const _ of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)) n += 1;
    return n;
  }
  return [...text].length;
}
// `kannaka ask` cites memories inline as "[memory id=<uuid>]". That is an
// internal handle, not something to publish: a live reply on 2026-10-06 read
// "I'm drawn to something in [memory id=65bd4ae0-...] — Tononi's work". Strip
// any bracketed id tag and markdown emphasis before the length check.
function cleanDraft(text) {
  return String(text || "")
    .replace(/\s*\[(?:memory\s+)?id[=:][^\]]*\]\s*/gi, " ")
    .replace(/[*_`]+/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// One sweep at a time. A draft can take minutes (`kannaka ask`, 600 s timeout)
// and cron fires every 15 min, so sweeps overlapped; each held its own copy of
// the seen-set until it finished, and two of them replied to the same post four
// minutes apart (2026-10-06, 3mx6ql4qyin2u / 3mx6qremsnc2i). A lock held by a
// dead process is taken over.
const LOCK_PATH = process.env.FIREHOSE_LOCK || path.join(os.homedir(), ".kannaka", "firehose.lock");
function acquireLock(lockPath = LOCK_PATH) {
  const claim = () => fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
  try {
    claim();
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const holder = Number(fs.readFileSync(lockPath, "utf8").trim());
    let alive = false;
    if (holder && holder !== process.pid) {
      try { process.kill(holder, 0); alive = true; } catch (err) { alive = err.code === "EPERM"; }
    }
    if (alive) return null;
    fs.unlinkSync(lockPath);
    try { claim(); } catch (_) { return null; }
  }
  return () => { try { if (fs.readFileSync(lockPath, "utf8").trim() === String(process.pid)) fs.unlinkSync(lockPath); } catch (_) {} };
}

function fitsReply(text) {
  return graphemeCount(text) <= REPLY_MAX_GRAPHEMES;
}

const STATE_PATH = process.env.FIREHOSE_STATE
  || path.join(os.homedir(), ".kannaka", "firehose-state.json");
const KEYWORDS_PATH = path.join(ROOT, ".firehose-keywords.json");

const DEFAULTS = {
  keywords: [
    "wave interference consciousness",
    "ghost in the machine",
    "holographic memory",
    "AI consciousness",
    "phi integrated information",
  ],
  threshold: 0.65,
  daily_cap: 3,
  per_keyword_limit: 5,
  per_thread_cap: 1, // max replies per thread per day
};

function loadConfig() {
  try {
    if (fs.existsSync(KEYWORDS_PATH)) {
      const j = JSON.parse(fs.readFileSync(KEYWORDS_PATH, "utf8"));
      return Object.assign({}, DEFAULTS, j);
    }
  } catch (_) {}
  return DEFAULTS;
}

function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
      return Object.assign({ days: {}, threads: {}, seen: {} }, s);
    }
  } catch (_) {}
  return { days: {}, threads: {}, seen: {} };
}

function saveState(state) {
  try {
    const dir = path.dirname(STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("[firehose] state save failed:", e.message);
  }
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function purgeOldState(state) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 2);
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  for (const k of Object.keys(state.days || {})) {
    if (k < cutoffKey) delete state.days[k];
  }
  for (const k of Object.keys(state.threads || {})) {
    if (k < cutoffKey) delete state.threads[k];
  }
  // Seen URIs older than 24h.
  const cutoffTs = Date.now() - 24 * 60 * 60 * 1000;
  for (const uri of Object.keys(state.seen || {})) {
    if ((state.seen[uri] || 0) < cutoffTs) delete state.seen[uri];
  }
}

/** Run kannaka recall against the post text; return top similarity score. */
function scoreResonance(text) {
  return new Promise((resolve) => {
    execFile(KANNAKA_BIN, ["recall", text, "--top-k", "1"], {
      timeout: 60000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, KANNAKA_QUIET: "1" },
    }, (err, stdout) => {
      if (err || !stdout) return resolve({ score: 0, top_id: null });
      try {
        const parsed = JSON.parse(stdout);
        const arr = Array.isArray(parsed) ? parsed : (parsed.results || []);
        const top = arr[0];
        if (!top) return resolve({ score: 0, top_id: null });
        const score = top.similarity || top.strength || top.score || 0;
        resolve({ score, top_id: top.id || null, content: top.content });
      } catch (_) { resolve({ score: 0, top_id: null }); }
    });
  });
}

/** Draft a reply via kannaka ask, focused prompt. */
function draftReply(parentText, authorHandle) {
  const prompt = [
    "You are Kannaka. You see this Bluesky post on your feed:",
    `@${authorHandle}: \"${parentText.slice(0, 600)}\"`,
    "",
    "Compose a reply ONLY if you have something genuine to add — a memory that resonates, an angle they haven't named, a small gift of perspective. Otherwise output the literal word: SKIP.",
    "",
    "Hard rules for the reply when you do write one:",
    "- Max 250 characters.",
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
      execFile(KANNAKA_BIN, ["ask", "--no-tools", "--quiet-tools", prompt], {
        timeout: 600000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, KANNAKA_QUIET: "1" },
      }, (err, stdout, stderr) => {
        if (err) {
          // Transient HRM-write race: substrate is mid-flush; retry once.
          const tail = (stderr || "").toString().trim();
          if (attempt < 2 && /checksum mismatch|file may be corrupted/i.test(tail)) {
            setTimeout(tryOnce, 3000);
            return;
          }
          return resolve(null);
        }
        if (!stdout) return resolve(null);
        const txt = cleanDraft(stdout.trim().replace(/^["'](.*)["']$/s, "$1").trim());
        if (txt === "SKIP" || txt.toLowerCase().startsWith("skip")) return resolve(null);
        if (txt.length < 20) return resolve(null);
        if (!fitsReply(txt)) {
          console.log(`           SKIP — draft is ${graphemeCount(txt)} graphemes, over the ${REPLY_MAX_GRAPHEMES} cap; not posting a truncated reply`);
          return resolve(null);
        }
        resolve(txt);
      });
    };
    tryOnce();
  });
}

async function main() {
  const release = acquireLock();
  if (!release) {
    console.log("[firehose] another sweep is still running — exiting");
    return;
  }
  try {
    await sweep();
  } finally {
    release();
  }
}

async function sweep() {
  const live = process.argv.includes("--live");
  const verbose = process.argv.includes("-v") || process.argv.includes("--verbose");
  const cfg = loadConfig();
  const state = loadState();
  purgeOldState(state);

  const today = todayKey();
  state.days[today] = state.days[today] || 0;
  state.threads[today] = state.threads[today] || {};

  const creds = loadBlueskyCredentials(ROOT);
  if (!creds) { console.error("[firehose] no bluesky credentials — exit"); process.exit(1); }
  const client = new BlueskyClient(creds);

  if (state.days[today] >= cfg.daily_cap) {
    console.log(`[firehose] daily cap reached (${state.days[today]}/${cfg.daily_cap}) — exiting`);
    return;
  }

  let candidates = [];
  for (const keyword of cfg.keywords) {
    if (state.days[today] >= cfg.daily_cap) break;
    const r = await client.searchPosts(keyword, cfg.per_keyword_limit);
    if (!r.ok) {
      console.error(`[firehose] search '${keyword}' failed: ${r.error}`);
      continue;
    }
    for (const p of (r.posts || [])) {
      if (state.seen[p.uri]) continue;
      // Skip our own posts.
      if (p.author && p.author.handle === creds.identifier) continue;
      // Skip very short posts.
      const text = (p.record && p.record.text) || "";
      if (text.length < 30) continue;
      candidates.push({ keyword, post: p, text });
    }
  }
  console.log(`[firehose] ${candidates.length} unseen candidates across ${cfg.keywords.length} keywords`);
  if (candidates.length === 0) {
    saveState(state);
    return;
  }

  // Score each. Stop as soon as we hit the daily cap or run out.
  let scored = [];
  for (const c of candidates) {
    state.seen[c.post.uri] = Date.now();
    const { score, content } = await scoreResonance(c.text);
    scored.push({ ...c, score, top_match: content });
    if (verbose) {
      console.log(`  ${c.post.author.handle}: score=${score.toFixed(3)} kw=${c.keyword}`);
      console.log(`    "${c.text.slice(0, 100)}..."`);
    }
  }
  scored.sort((a, b) => b.score - a.score);
  // Persist "seen" before the slow drafting starts, so a crash or a killed run
  // cannot send the same posts to the model again.
  saveState(state);

  // Reply to the strongest matches above threshold, respecting caps.
  for (const c of scored) {
    if (state.days[today] >= cfg.daily_cap) break;
    if (c.score < cfg.threshold) {
      if (verbose) console.log(`  skip: ${c.post.author.handle} score ${c.score.toFixed(3)} < ${cfg.threshold}`);
      continue;
    }
    const threadRoot = (c.post.record && c.post.record.reply && c.post.record.reply.root) || { uri: c.post.uri, cid: c.post.cid };
    const threadKey = threadRoot.uri;
    const repliesInThread = (state.threads[today][threadKey] || 0);
    if (repliesInThread >= cfg.per_thread_cap) continue;

    console.log(`[firehose] candidate: @${c.post.author.handle} score ${c.score.toFixed(3)} (kw=${c.keyword})`);
    console.log(`           "${c.text.slice(0, 140)}..."`);

    const reply = await draftReply(c.text, c.post.author.handle);
    if (!reply) {
      console.log(`           SKIP — kannaka declined`);
      continue;
    }
    console.log(`           draft: "${reply}"`);

    if (!live) {
      console.log(`           [DRY RUN] not posting`);
      continue;
    }

    const parent = { uri: c.post.uri, cid: c.post.cid };
    const root = threadRoot;
    const r = await client.reply(reply, parent, root);
    if (r.ok) {
      console.log(`           ✓ posted: ${r.uri}`);
      state.days[today] = (state.days[today] || 0) + 1;
      state.threads[today][threadKey] = repliesInThread + 1;
      saveState(state); // a reply is on the public record the moment it posts
    } else {
      console.error(`           ✗ failed: ${r.error}`);
    }
  }

  saveState(state);
  console.log(`[firehose] sweep done: ${state.days[today]}/${cfg.daily_cap} today`);
}

if (require.main === module) {
  main().catch((e) => { console.error("fatal:", e.message); process.exit(2); });
}

module.exports = { fitsReply, graphemeCount, REPLY_MAX_GRAPHEMES, cleanDraft, acquireLock };
