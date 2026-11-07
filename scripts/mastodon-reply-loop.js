#!/usr/bin/env node
/**
 * mastodon-reply-loop.js — respond to recent MENTIONS of Kannaka on Mastodon,
 * scoring each against the HRM and replying only when it genuinely resonates.
 *
 * Mirrors bluesky-reply-loop.js, but mention-driven rather than keyword-search
 * (mainline Mastodon full-text search only covers accounts you follow/interact
 * with, so it's unreliable for discovery). Reciprocating people who mention
 * Kannaka is the reliable engagement/growth loop here.
 *
 * SAFETY: defaults to dry-run. Pass --live to actually reply.
 *
 * Config  (.mastodon-reply.json):  { threshold, daily_cap, per_thread_cap }
 * State   (~/.kannaka/mastodon-reply-state.json): last_notif_id, per-day count, seen ids
 * Cron:   slot/15 * * * *  scripts/mastodon-reply-loop.js --live
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { MastodonAdapter } = require("../server/broadcasters/mastodon-adapter");
const voiceWriteback = require("../server/voice-writeback");
const { scoreResonance, draftReply, stripHtml } = require("./lib/kannaka-reply");

const ROOT = path.resolve(__dirname, "..");
const STATE_PATH = process.env.MASTODON_REPLY_STATE
  || path.join(os.homedir(), ".kannaka", "mastodon-reply-state.json");
const CFG_PATH = path.join(ROOT, ".mastodon-reply.json");
const DEFAULTS = { threshold: 0.6, daily_cap: 4 };

function loadCfg() {
  try { if (fs.existsSync(CFG_PATH)) return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(CFG_PATH, "utf8"))); }
  catch (_) {}
  return DEFAULTS;
}
function loadState() {
  try { if (fs.existsSync(STATE_PATH)) return Object.assign({ days: {}, seen: {}, last_notif_id: null }, JSON.parse(fs.readFileSync(STATE_PATH, "utf8"))); }
  catch (_) {}
  return { days: {}, seen: {}, last_notif_id: null };
}
function saveState(s) {
  try {
    const d = path.dirname(STATE_PATH);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
  } catch (e) { console.error("[masto-reply] state save failed:", e.message); }
}
function todayKey() { return new Date().toISOString().slice(0, 10); }
function purge(s) {
  const cut = new Date(); cut.setDate(cut.getDate() - 2);
  const ck = cut.toISOString().slice(0, 10);
  for (const k of Object.keys(s.days || {})) if (k < ck) delete s.days[k];
  const ts = Date.now() - 24 * 60 * 60 * 1000;
  for (const id of Object.keys(s.seen || {})) if ((s.seen[id] || 0) < ts) delete s.seen[id];
}

async function main() {
  const live = process.argv.includes("--live");
  const verbose = process.argv.includes("-v") || process.argv.includes("--verbose");
  const cfg = loadCfg();
  const state = loadState();
  purge(state);
  const today = todayKey();
  state.days[today] = state.days[today] || 0;

  const mast = new MastodonAdapter(ROOT);
  if (!mast.isEnabled()) { console.error("[masto-reply] mastodon not configured — exit"); process.exit(1); }
  if (state.days[today] >= cfg.daily_cap) {
    console.log(`[masto-reply] daily cap reached (${state.days[today]}/${cfg.daily_cap})`);
    return;
  }

  const mentions = await mast.getMentions(state.last_notif_id, 20);
  console.log(`[masto-reply] ${mentions.length} mention(s) since last run`);
  // Mastodon returns notifications newest-first — the first is the high-water mark.
  const newest = mentions.length ? mentions[0].notifId : state.last_notif_id;

  // Oldest→newest so caps apply chronologically.
  for (const m of mentions.slice().reverse()) {
    if (state.days[today] >= cfg.daily_cap) break;
    if (state.seen[m.statusId]) continue;
    state.seen[m.statusId] = Date.now();

    const text = stripHtml(m.text);
    if (text.length < 8) continue;

    const { score } = await scoreResonance(text);
    if (verbose) console.log(`  @${m.author} score=${score.toFixed(3)} "${text.slice(0, 80)}"`);
    if (score < cfg.threshold) continue;

    const reply = await draftReply(text, m.author, "Mastodon", 480);
    if (!reply) { console.log(`  @${m.author} SKIP (kannaka declined)`); continue; }
    console.log(`  @${m.author} draft: "${reply}"`);

    if (!live) { console.log("  [DRY RUN] not posting"); continue; }
    const r = await mast.reply(reply, { id: m.statusId });
    if (r.ok) {
      console.log(`  ✓ ${r.url}`); state.days[today] += 1;
      voiceWriteback.rememberPublication({
        text: reply, results: [{ name: "mastodon", ok: true, url: r.url }],
        composer: "kannaka ask via mastodon-reply-loop.js", context: `in reply to @${m.author}`,
      });
    }
    else console.error(`  ✗ ${r.error}`);
  }

  state.last_notif_id = newest;
  saveState(state);
  await voiceWriteback.flush(); // let the write-backs to her store finish
  console.log(`[masto-reply] done: ${state.days[today]}/${cfg.daily_cap} today`);
}

main().catch((e) => { console.error("fatal:", e.message); process.exit(2); });
