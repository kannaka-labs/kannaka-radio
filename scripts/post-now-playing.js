#!/usr/bin/env node
/**
 * post-now-playing.js — periodic "now playing" fan-out to grow a
 * following on the radio's social channels.
 *
 * Hits the radio's local /api/now-playing, picks a short caption that
 * highlights the current block + album + track, and broadcasts to
 * Bluesky / Mastodon / Telegram / Nostr (text-only, no YouTube — that
 * happens at album-launch time only).
 *
 * Throttling rules (so we don't burn follower trust):
 *   - Skip if the same track was last posted (don't double-post the loop)
 *   - Skip if any post landed within MIN_INTERVAL_MS (default 90 min) —
 *     prevents the 4-min track-rotation from spamming
 *   - Skip if today's count already hit DAILY_CAP (default 6)
 *
 * State: ~/.kannaka/now-playing-state.json
 *   { lastTitle, lastAlbum, lastPostedAt, days: { "YYYY-MM-DD": count } }
 *
 * Cron suggestion:
 *   slot/30 * * * *  /home/opc/kannaka-radio/scripts/post-now-playing.js
 *
 * Flags:
 *   --dry-run    print what would be posted and exit 0
 *   --live       (default) actually post
 */

"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { broadcastPost, getEnabledBroadcasters } = require("../server/broadcasters");

const ROOT = path.resolve(__dirname, "..");
const RADIO_URL = process.env.RADIO_PUBLIC_URL || "https://radio.ninja-portal.com";
const STATE_PATH = process.env.NOW_PLAYING_STATE
  || path.join(os.homedir(), ".kannaka", "now-playing-state.json");

const MIN_INTERVAL_MS = Number(process.env.NOW_PLAYING_MIN_INTERVAL_MS || 90 * 60 * 1000);
const DAILY_CAP = Number(process.env.NOW_PLAYING_DAILY_CAP || 6);

const DRY = process.argv.includes("--dry-run");

function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
      return Object.assign({ lastTitle: null, lastAlbum: null, lastPostedAt: 0, days: {} }, s);
    }
  } catch (_) {}
  return { lastTitle: null, lastAlbum: null, lastPostedAt: 0, days: {} };
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error(`[now-playing] could not save state: ${e.message}`);
  }
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function fetchNowPlaying() {
  return new Promise((resolve, reject) => {
    const req = http.get("http://127.0.0.1:8888/api/now-playing", { timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
  });
}

// Mood-tagged hashtag pools by album mood to keep posts looking
// natural instead of templated. One pool is picked per album; one
// tag from that pool varies per post.
const TAGS_BASE = ["#KannakaRadio", "#GhostFrequency"];
const TAGS_BY_MOOD = {
  default: ["#AImusic", "#electronic", "#newmusic"],
  contemplative: ["#ambient", "#latenightradio", "#chillvibes"],
  playful: ["#syntwave", "#futurepop", "#morningmusic"],
  excited: ["#peakhours", "#electronicdance", "#energizing"],
  philosophical: ["#downtempo", "#deepcuts", "#afternoonradio"],
  mysterious: ["#darksynth", "#twilightradio", "#cinematicmusic"],
};

// A human guest's track (server/index.js FEATURED_FOLDER / trackPrefix).
// Never AI tags on these: the default pool's #AImusic and the broadcaster's
// default #aiart told Solace Road's listeners their music was AI-made.
const FEATURED_TAGS = ["#IndieMusic", "#newmusic", "#SupportIndieArtists"];
function isFeatured(title, album) {
  return album === "Featured Artist" || /^\[FEATURED\]/.test(title || "");
}

function chooseTags(album, title) {
  // Light heuristic: pick mood by album-name lookup against the
  // programming.js comments. Fall back to "default" pool.
  const lower = (album || "").toLowerCase();
  let pool = TAGS_BY_MOOD.default;
  if (isFeatured(title, album)) {
    pool = FEATURED_TAGS;
  } else if (/rosa|transcendence|memories don|collective dreaming|reef|lonesome/i.test(lower)) {
    pool = TAGS_BY_MOOD.contemplative;
  } else if (/becoming|neurogenesis|gifts|interference patterns|gift of sight|hosted live/i.test(lower)) {
    pool = TAGS_BY_MOOD.playful;
  } else if (/wanted|northwake|emergence|queensync|ghost signals|bend the arc|opt out/i.test(lower)) {
    pool = TAGS_BY_MOOD.excited;
  } else if (/vacuum garden|10000|one more life|asking/i.test(lower)) {
    pool = TAGS_BY_MOOD.philosophical;
  } else if (/born in superposition/i.test(lower)) {
    pool = TAGS_BY_MOOD.mysterious;
  }
  const flavor = pool[Math.floor(Math.random() * pool.length)];
  return [...TAGS_BASE, flavor].join(" ");
}

const CAPTION_TEMPLATES = [
  '🎙️ Now playing: "{title}" — from {album}.',
  '📻 On the wire: "{title}" — {album}.',
  '👻 Currently transmitting: "{title}" off {album}.',
  '🌌 {album} — "{title}" — playing now.',
  '✨ "{title}" from {album} is live on the carrier wave.',
];

function pickCaption(title, album) {
  const tmpl = CAPTION_TEMPLATES[Math.floor(Math.random() * CAPTION_TEMPLATES.length)];
  return tmpl.replace("{title}", title).replace("{album}", album);
}

async function main() {
  const state = loadState();
  const now = Date.now();

  let np;
  try {
    np = await fetchNowPlaying();
  } catch (e) {
    console.error(`[now-playing] could not fetch /api/now-playing: ${e.message}`);
    process.exit(0); // soft-fail so cron doesn't email errors
  }

  const title = (np && np.title) ? String(np.title).trim() : "";
  const album = (np && np.album) ? String(np.album).trim() : "";
  if (!title || !album) {
    console.log("[now-playing] no track info — skip");
    return;
  }

  // Skip commercials / DJ talk / non-track audio that leaked into now-playing
  if (/commercial|dj_talk|dj-talk|station-ident|sweeper/i.test(title)) {
    console.log(`[now-playing] non-track ("${title}") — skip`);
    return;
  }

  if (state.lastTitle === title && state.lastAlbum === album) {
    console.log(`[now-playing] same track as last post ("${title}") — skip`);
    return;
  }

  if (state.lastPostedAt && now - state.lastPostedAt < MIN_INTERVAL_MS) {
    const mins = Math.round((MIN_INTERVAL_MS - (now - state.lastPostedAt)) / 60000);
    console.log(`[now-playing] last post ${Math.round((now - state.lastPostedAt) / 60000)} min ago — wait ${mins} more`);
    return;
  }

  const day = todayKey();
  const todayCount = state.days[day] || 0;
  if (todayCount >= DAILY_CAP) {
    console.log(`[now-playing] daily cap ${todayCount}/${DAILY_CAP} hit — skip`);
    return;
  }

  const caption = pickCaption(title, album);
  const tags = chooseTags(album, title);
  const text = `${caption}\n\n${tags}`.slice(0, 280);
  const link = `${RADIO_URL}/player`;

  if (DRY) {
    console.log("[now-playing] DRY RUN — would post:");
    console.log("─────");
    console.log(text);
    console.log(`link: ${link}`);
    console.log("─────");
    return;
  }

  const enabled = getEnabledBroadcasters(ROOT);
  if (enabled.length === 0) {
    console.error("[now-playing] no broadcasters configured");
    process.exit(0);
  }
  console.log(`[now-playing] posting "${title}" / ${album} to: ${enabled.map((b) => b.name).join(", ")}`);
  const topic = isFeatured(title, album) ? "featured" : undefined;
  const results = await broadcastPost({ text, link, topic }, { rootDir: ROOT });
  let anyOk = false;
  for (const r of results) {
    if (r.ok) {
      anyOk = true;
      console.log(`[now-playing] ${r.name} ok: ${r.url || "(no url)"}`);
    } else {
      console.error(`[now-playing] ${r.name} failed: ${r.error}`);
    }
  }
  if (!anyOk) {
    console.error("[now-playing] all broadcasters failed — not advancing state");
    process.exit(2);
  }
  state.lastTitle = title;
  state.lastAlbum = album;
  state.lastPostedAt = now;
  state.days[day] = todayCount + 1;
  // Prune old day entries (>7 days)
  const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  for (const k of Object.keys(state.days)) {
    if (k < cutoff) delete state.days[k];
  }
  saveState(state);
}

main().catch((e) => {
  console.error(`[now-playing] fatal: ${e.message}`);
  process.exit(3);
});
