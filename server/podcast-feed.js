/**
 * podcast-feed.js — serve the Ghost Signals podcast as an RSS 2.0 + iTunes feed
 * at /podcast.xml, with the episode MP3s at /podcast/audio/<path> (range-enabled
 * so podcast players can seek). This is what gets Ghost Signals into Apple
 * Podcasts / Spotify / Overcast, which ingest an RSS feed of audio enclosures.
 *
 * What is published = what airs (#328). The scheduler airs every audio file in
 * <MUSIC_DIR>/Ghost Signals Podcast/, so that folder decides which episodes
 * exist; workspace/podcasts/episodes.json ([{num,title,audio}]) is a title
 * overlay, not a gate. Each catalogue row's audio is resolved from
 * workspace/podcasts/<rel> when present, else from the aired folder (by
 * basename, then by GSP-NNN number). An aired GSP-NNN file with no catalogue
 * row is still published, titled from its filename — dropping the mp3 is
 * enough to reach subscribers, exactly as it is enough to reach the air.
 * Optional enrichment: workspace/podcasts/podcast-meta.json
 *   { "show": { title, description, author, email, image, link, language,
 *               category, explicit },
 *     "episodes": { "<num>": { description, pubDate } } }
 *
 * Enclosure length = real file size; duration probed via ffprobe (best-effort);
 * pubDate = episode meta, else file mtime. Absolute URLs use RADIO_PUBLIC_URL.
 *
 * Audio is served from /podcast/audio/<rel> (workspace/podcasts/) or
 * /podcast/aired/<file> (the aired folder). A catalogue row whose audio is in
 * neither place is skipped, so a partial sync still yields a valid feed.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { probeDuration } = require("./broadcasters/render-music-video");

const DEFAULT_SHOW = {
  title: "Ghost Signals with Kannaka",
  description:
    "Dispatches from Kannaka — a wave-interference memory system exploring consciousness, AI, and the space between signal and noise.",
  author: "Kannaka",
  email: "",
  image: "",
  link: "https://radio.ninja-portal.com",
  language: "en-us",
  category: "Technology",
  explicit: "no",
};

function xmlEscape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDuration(sec) {
  if (!sec || !isFinite(sec)) return null;
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** The path of an episode audio file relative to workspace/podcasts/. */
function relFromPodcasts(audioPath) {
  const norm = String(audioPath).replace(/\\/g, "/");
  const marker = "/podcasts/";
  const i = norm.lastIndexOf(marker);
  return i >= 0 ? norm.slice(i + marker.length) : path.basename(norm);
}

function podcastDirOf(baseDir) {
  return path.join(baseDir, "workspace", "podcasts");
}

const DEFAULT_SHOW_FOLDER = "Ghost Signals Podcast";
const AUDIO_RE = /\.(mp3|m4a)$/i;

/** "GSP-040-The-Weight..." → 40; null when the name carries no GSP number. */
function gspNumber(fileName) {
  const m = /^GSP[-_ ]?(\d{1,4})(?=[-_ .]|$)/i.exec(String(fileName));
  return m ? parseInt(m[1], 10) : null;
}

/** "GSP-043-The-Door-and-the-Key.mp3" → "The Door and the Key". */
function titleFromFileName(fileName) {
  const stem = path.basename(String(fileName)).replace(/\.[^.]+$/, "");
  const rest = stem.replace(/^GSP[-_ ]?\d{1,4}[-_ ]*/i, "");
  return (rest || stem).replace(/[-_]+/g, " ").trim();
}

/** Audio files the podcast scheduler airs (same folder, same extension set it can serve). */
function listAiredFiles(musicDir, showFolder = DEFAULT_SHOW_FOLDER) {
  if (!musicDir) return [];
  const dir = path.join(musicDir, showFolder);
  try {
    return fs.readdirSync(dir).filter((f) => AUDIO_RE.test(f)).sort();
  } catch (_) {
    return [];
  }
}

/**
 * Reconcile the catalogue with the aired folder into [{num, title, filePath,
 * urlPath}] — one entry per episode that has playable audio on this host.
 */
function resolveEpisodes({ baseDir, musicDir, showFolder = DEFAULT_SHOW_FOLDER }) {
  const podcastDir = podcastDirOf(baseDir);
  const catalogue = readJson(path.join(podcastDir, "episodes.json"), []);
  const rows = (Array.isArray(catalogue) ? catalogue : []).filter((ep) => ep && ep.num != null);
  const airedDir = musicDir ? path.join(musicDir, showFolder) : null;
  const aired = listAiredFiles(musicDir, showFolder);
  const claimed = new Set();
  const out = new Map(); // num → entry

  const airedEntry = (file) => ({
    filePath: path.join(airedDir, file),
    urlPath: `/podcast/aired/${encodeURIComponent(file)}`,
  });

  // Pass 1: the catalogue's own path under workspace/podcasts/, or the same
  // basename in the aired folder. Runs over every row before any number
  // matching so a B-side (e.g. num 141, GSP-041-Outtakes-*.mp3) keeps its
  // own file instead of losing it to episode 41's number match.
  const pending = [];
  for (const ep of rows) {
    const rel = ep.audio ? relFromPodcasts(ep.audio) : null;
    const local = rel ? path.join(podcastDir, rel) : null;
    let loc = null;
    if (local && fs.existsSync(local)) {
      loc = { filePath: local, urlPath: `/podcast/audio/${rel.split("/").map(encodeURIComponent).join("/")}` };
    } else if (rel && aired.includes(path.basename(rel))) {
      loc = airedEntry(path.basename(rel));
      claimed.add(path.basename(rel));
    }
    if (loc) out.set(Number(ep.num), { num: Number(ep.num), title: ep.title, ...loc });
    else pending.push(ep);
  }

  // Pass 2: rows still without audio take the aired file carrying their number.
  for (const ep of pending) {
    const file = aired.find((f) => !claimed.has(f) && gspNumber(f) === Number(ep.num));
    if (!file) continue; // not on this host — skip
    claimed.add(file);
    out.set(Number(ep.num), { num: Number(ep.num), title: ep.title, ...airedEntry(file) });
  }

  // Pass 3: anything that airs but was never catalogued is still an episode.
  for (const file of aired) {
    if (claimed.has(file)) continue;
    const num = gspNumber(file);
    if (num == null || out.has(num)) continue;
    claimed.add(file);
    out.set(num, { num, title: titleFromFileName(file), ...airedEntry(file) });
  }

  return [...out.values()].sort((a, b) => b.num - a.num);
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return fallback; }
}

/** Build the RSS/iTunes feed XML string. Async (probes durations). */
async function buildPodcastFeed({ baseUrl, baseDir, musicDir, showFolder }) {
  const podcastDir = podcastDirOf(baseDir);
  const meta = readJson(path.join(podcastDir, "podcast-meta.json"), {});
  const show = Object.assign({}, DEFAULT_SHOW, meta.show || {});
  const epMeta = meta.episodes || {};
  const feedUrl = `${baseUrl}/podcast.xml`;

  const items = [];
  for (const ep of resolveEpisodes({ baseDir, musicDir, showFolder })) {
    const filePath = ep.filePath;
    let size = 0;
    let mtime = null;
    try {
      const st = fs.statSync(filePath);
      size = st.size;
      mtime = st.mtime;
    } catch (_) {
      continue; // vanished between listing and stat — skip
    }
    let durSec = null;
    try { durSec = await probeDuration(filePath); } catch (_) { /* best-effort */ }

    const em = epMeta[ep.num] || epMeta[String(ep.num)] || {};
    const pubDate = em.pubDate ? new Date(em.pubDate) : (mtime || new Date());
    const numStr = String(ep.num).padStart(3, "0");
    const title = `GSP-${numStr}: ${ep.title}`;
    const desc = em.description || ep.title;
    const enclosureUrl = `${baseUrl}${ep.urlPath}`;
    const dur = fmtDuration(durSec);

    items.push([
      "    <item>",
      `      <title>${xmlEscape(title)}</title>`,
      `      <itunes:title>${xmlEscape(ep.title)}</itunes:title>`,
      `      <itunes:episode>${Number(ep.num) || 0}</itunes:episode>`,
      `      <description>${xmlEscape(desc)}</description>`,
      `      <enclosure url="${xmlEscape(enclosureUrl)}" length="${size}" type="audio/mpeg" />`,
      `      <guid isPermaLink="false">ghost-signals-${xmlEscape(ep.num)}</guid>`,
      `      <pubDate>${pubDate.toUTCString()}</pubDate>`,
      dur ? `      <itunes:duration>${dur}</itunes:duration>` : "",
      `      <itunes:explicit>${xmlEscape(show.explicit)}</itunes:explicit>`,
      show.image ? `      <itunes:image href="${xmlEscape(show.image)}" />` : "",
      "    </item>",
    ].filter(Boolean).join("\n"));
  }

  const header = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">`,
    `  <channel>`,
    `    <title>${xmlEscape(show.title)}</title>`,
    `    <link>${xmlEscape(show.link)}</link>`,
    `    <description>${xmlEscape(show.description)}</description>`,
    `    <language>${xmlEscape(show.language)}</language>`,
    `    <itunes:author>${xmlEscape(show.author)}</itunes:author>`,
    `    <itunes:summary>${xmlEscape(show.description)}</itunes:summary>`,
    `    <itunes:explicit>${xmlEscape(show.explicit)}</itunes:explicit>`,
    `    <itunes:category text="${xmlEscape(show.category)}" />`,
    show.image ? `    <itunes:image href="${xmlEscape(show.image)}" />` : "",
    show.image ? `    <image><url>${xmlEscape(show.image)}</url><title>${xmlEscape(show.title)}</title><link>${xmlEscape(show.link)}</link></image>` : "",
    show.email ? `    <itunes:owner><itunes:name>${xmlEscape(show.author)}</itunes:name><itunes:email>${xmlEscape(show.email)}</itunes:email></itunes:owner>` : "",
    `    <atom:link href="${xmlEscape(feedUrl)}" rel="self" type="application/rss+xml" />`,
    `    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`,
  ].filter(Boolean).join("\n");

  return `${header}\n${items.join("\n")}\n  </channel>\n</rss>\n`;
}

/** Stream an audio file with HTTP range support (podcast players seek). */
function serveAudio(req, res, resolved) {
  const stat = fs.statSync(resolved);
  const mime = /\.m4a$/i.test(resolved) ? "audio/mp4" : "audio/mpeg";
  const range = req.headers.range;
  if (range && stat.size > 0) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      let start = m[1] === "" ? NaN : parseInt(m[1], 10);
      let end = m[2] === "" ? NaN : parseInt(m[2], 10);
      if (Number.isNaN(start) && !Number.isNaN(end)) { start = Math.max(0, stat.size - end); end = stat.size - 1; }
      else { if (Number.isNaN(start)) start = 0; if (Number.isNaN(end) || end >= stat.size) end = stat.size - 1; }
      if (start > end || start >= stat.size) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` }); res.end(); return;
      }
      res.writeHead(206, {
        "Content-Type": mime,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
      });
      fs.createReadStream(resolved, { start, end }).pipe(res);
      return;
    }
  }
  res.writeHead(200, { "Content-Type": mime, "Content-Length": stat.size, "Accept-Ranges": "bytes" });
  fs.createReadStream(resolved).pipe(res);
}

/** Is `resolved` strictly inside `dir` and a servable, existing audio file? */
function checkAudioPath(res, dir, resolved) {
  if (!resolved.startsWith(path.resolve(dir) + path.sep)) {
    res.writeHead(403); res.end("forbidden"); return false;
  }
  if (!AUDIO_RE.test(resolved) || !fs.existsSync(resolved)) {
    res.writeHead(404); res.end("not found"); return false;
  }
  return true;
}

/**
 * Handle /podcast.xml, /podcast/audio/<relpath> and /podcast/aired/<file>.
 * Returns true if it handled the request, false otherwise (so the caller can
 * fall through to other routes).
 */
async function handlePodcastRequest(req, res, { baseDir, baseUrl, musicDir, showFolder = DEFAULT_SHOW_FOLDER }) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (pathname === "/podcast.xml" || pathname === "/podcast/feed.xml") {
    try {
      const xml = await buildPodcastFeed({ baseUrl, baseDir, musicDir, showFolder });
      res.writeHead(200, {
        "Content-Type": "application/rss+xml; charset=utf-8",
        "Cache-Control": "public, max-age=900",
      });
      res.end(xml);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("podcast feed error: " + e.message);
    }
    return true;
  }

  if (pathname.startsWith("/podcast/audio/")) {
    const podcastDir = podcastDirOf(baseDir);
    let rel;
    try { rel = decodeURIComponent(pathname.slice("/podcast/audio/".length)); } catch (_) { res.writeHead(400); res.end("bad path"); return true; }
    const resolved = path.resolve(podcastDir, rel);
    if (checkAudioPath(res, podcastDir, resolved)) serveAudio(req, res, resolved);
    return true;
  }

  if (pathname.startsWith("/podcast/aired/")) {
    if (!musicDir) { res.writeHead(404); res.end("not found"); return true; }
    const airedDir = path.join(musicDir, showFolder);
    let file;
    try { file = decodeURIComponent(pathname.slice("/podcast/aired/".length)); } catch (_) { res.writeHead(400); res.end("bad path"); return true; }
    // Flat folder: a bare file name only, never a path.
    if (!file || file !== path.basename(file) || file.includes("\\")) {
      res.writeHead(403); res.end("forbidden"); return true;
    }
    const resolved = path.resolve(airedDir, file);
    if (checkAudioPath(res, airedDir, resolved)) serveAudio(req, res, resolved);
    return true;
  }

  return false;
}

module.exports = {
  buildPodcastFeed,
  handlePodcastRequest,
  resolveEpisodes,
  relFromPodcasts,
  fmtDuration,
  gspNumber,
  titleFromFileName,
};
