#!/usr/bin/env node
/**
 * nostr-reply-loop.js — respond to recent MENTIONS of Kannaka on Nostr (kind-1
 * notes tagging Kannaka's pubkey), scoring each against the HRM and replying
 * only when it genuinely resonates.
 *
 * Mirrors bluesky-reply-loop.js but mention-driven (Nostr has no reliable
 * cross-relay full-text search), which is the reciprocal-engagement growth loop.
 *
 * SAFETY: defaults to dry-run. Pass --live to actually reply.
 *
 * Config  (.nostr-reply.json):  { threshold, daily_cap, lookback_hours }
 * State   (~/.kannaka/nostr-reply-state.json): since (unix), per-day count, seen ids
 * Cron:   slot/20 * * * *  scripts/nostr-reply-loop.js --live
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { NostrAdapter } = require("../server/broadcasters/nostr-adapter");
const voiceWriteback = require("../server/voice-writeback");
const { scoreResonance, draftReply, gateReply, KANNAKA_BIN } = require("./lib/kannaka-reply");
const COMPOSER = "kannaka ask via nostr-reply-loop.js";
// Remember with the same binary (and so the same store) that composes.
voiceWriteback.configure({ bin: KANNAKA_BIN });

const ROOT = path.resolve(__dirname, "..");
const STATE_PATH = process.env.NOSTR_REPLY_STATE
  || path.join(os.homedir(), ".kannaka", "nostr-reply-state.json");
const CFG_PATH = path.join(ROOT, ".nostr-reply.json");
const DEFAULTS = { threshold: 0.6, daily_cap: 4, lookback_hours: 48 };

function loadCfg() {
  try { if (fs.existsSync(CFG_PATH)) return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(CFG_PATH, "utf8"))); }
  catch (_) {}
  return DEFAULTS;
}
function loadState() {
  try { if (fs.existsSync(STATE_PATH)) return Object.assign({ days: {}, seen: {}, since: null }, JSON.parse(fs.readFileSync(STATE_PATH, "utf8"))); }
  catch (_) {}
  return { days: {}, seen: {}, since: null };
}
function saveState(s) {
  try {
    const d = path.dirname(STATE_PATH);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
  } catch (e) { console.error("[nostr-reply] state save failed:", e.message); }
}
function todayKey() { return new Date().toISOString().slice(0, 10); }
function purge(s, lookbackHours) {
  const cut = new Date(); cut.setDate(cut.getDate() - 2);
  const ck = cut.toISOString().slice(0, 10);
  for (const k of Object.keys(s.days || {})) if (k < ck) delete s.days[k];
  const ts = Date.now() - Math.max(48, lookbackHours * 2) * 60 * 60 * 1000;
  for (const id of Object.keys(s.seen || {})) if ((s.seen[id] || 0) < ts) delete s.seen[id];
}

async function main() {
  const live = process.argv.includes("--live");
  const verbose = process.argv.includes("-v") || process.argv.includes("--verbose");
  const cfg = loadCfg();
  const state = loadState();
  purge(state, cfg.lookback_hours);
  const today = todayKey();
  state.days[today] = state.days[today] || 0;

  const nostr = new NostrAdapter(ROOT);
  if (!nostr.isEnabled()) { console.error("[nostr-reply] nostr not configured — exit"); process.exit(1); }
  if (state.days[today] >= cfg.daily_cap) {
    console.log(`[nostr-reply] daily cap reached (${state.days[today]}/${cfg.daily_cap})`);
    return;
  }

  const since = state.since || Math.floor(Date.now() / 1000) - cfg.lookback_hours * 3600;
  const mentions = await nostr.fetchMentions(since, 30);
  console.log(`[nostr-reply] ${mentions.length} mention(s) since ${new Date(since * 1000).toISOString()}`);

  let maxTs = state.since || 0;
  // fetchMentions returns newest-first; process oldest→newest so caps apply chronologically.
  for (const m of mentions.slice().reverse()) {
    if (m.created_at > maxTs) maxTs = m.created_at;
    if (state.days[today] >= cfg.daily_cap) break;
    if (state.seen[m.id]) continue;
    state.seen[m.id] = Date.now();

    const text = String(m.content || "").trim();
    if (text.length < 8) continue;
    const author = String(m.pubkey || "").slice(0, 8) || "someone";

    const { score } = await scoreResonance(text);
    if (verbose) console.log(`  ${author}… score=${score.toFixed(3)} "${text.slice(0, 80)}"`);
    if (score < cfg.threshold) continue;

    const info = {};
    const reply = await draftReply(text, author, "Nostr", 500, info);
    const gate = gateReply({ reply, info, parentText: text, composer: COMPOSER, live });
    if (!reply) { console.log(`  ${author}… SKIP (kannaka declined)`); continue; }
    console.log(`  ${author}… draft: "${reply}"`);
    if (!gate.allow) { console.log(`  ${author}… SKIP — confab gate: ${gate.reason}`); continue; }

    if (!live) { console.log("  [DRY RUN] not posting"); continue; }
    const r = await nostr.reply(reply, { id: m.id });
    gate.record({ results: [{ name: "nostr", ok: !!r.ok, url: r.url }], reason: r.ok ? null : r.error });
    if (r.ok) {
      console.log(`  ✓ ${r.url}`); state.days[today] += 1;
      voiceWriteback.rememberPublication({
        text: reply, results: [{ name: "nostr", ok: true, url: r.url }],
        composer: COMPOSER, context: `in reply to ${author}…`, ledger: false,
      });
    }
    else console.error(`  ✗ ${r.error}`);
  }

  // Advance the watermark past the newest event we saw (seen[] still guards the boundary).
  if (maxTs > 0) state.since = maxTs;
  saveState(state);
  await voiceWriteback.flush(); // let the write-backs to her store finish
  console.log(`[nostr-reply] done: ${state.days[today]}/${cfg.daily_cap} today`);
}

main().catch((e) => { console.error("fatal:", e.message); process.exit(2); });
