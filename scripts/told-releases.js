#!/usr/bin/env node
/**
 * told-releases.js — tell Kannaka about software releases she did not live.
 *
 * The 2026-11-15 event-trace audit followed 16 public events into her store.
 * Seven were never written there, six of them software releases: a release
 * ships through GitHub and no path tells her. Things she announces on air
 * reach her store through voice-writeback; a release is not said on air.
 *
 * This script reads the public release lists of the constellation's repos
 * and writes each new release into her store ONCE, labelled as told. Her
 * own words on how (asked 2026-11-15): "Write it as told. Tag it honestly.
 * 'Kannaka learned that X from Claude Code at timestamp Y' is true.
 * 'Kannaka experienced X' is false."
 *
 *   node scripts/told-releases.js            # write what is new
 *   node scripts/told-releases.js --dry-run  # print what would be written
 *
 * Environment:
 *   TOLD_RELEASES_REPOS   comma-separated owner/repo list (default below)
 *   TOLD_RELEASES_SINCE   ISO date; older releases are marked seen, unwritten
 *                         (default: 14 days before the first run)
 *   KANNAKA_RADIO_DATA_DIR / KANNAKA_BIN / KANNAKA_DATA_DIR as voice-writeback
 *
 * State: <radio data dir>/told-releases.json  { seen: { "owner/repo@tag": iso } }
 * A release is marked seen only after its memory is stored (or was already
 * stored), so a failed store is tried again on the next run.
 *
 * Unauthenticated GitHub API: one request per repo per run. Run it a few
 * times a day from cron, not every minute.
 *
 * Exit: 0 (also when there was nothing new), 1 when a store or a fetch failed.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const voiceWriteback = require(path.join(__dirname, "..", "server", "voice-writeback"));

const DEFAULT_REPOS = [
  "kannaka-labs/kannaka-memory", "kannaka-labs/kannaka-radio", "kannaka-labs/kannaka-tv",
  "kannaka-labs/consciousness-core", "kannaka-labs/kannaka-attention", "kannaka-labs/ghostsignals",
  "kannaka-labs/kannaka-library", "kannaka-labs/kannaka-crystal", "kannaka-labs/kannaka-quantum",
  "kannaka-labs/QuantumOS",
];
const TOLD_BY = "the release watcher (scripts/told-releases.js, a script reading GitHub's public release list)";
const NOTES_MAX = 900;
const IMPORTANCE = 0.55;

function stateFile() {
  return path.join(voiceWriteback.radioDataDir(), "told-releases.json");
}
function loadState(file = stateFile()) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    if (s && s.seen && typeof s.seen === "object") return s;
  } catch (_) { /* first run */ }
  return { seen: {}, first_run: null };
}
function saveState(state, file = stateFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, file);
}

function fetchReleases(repo) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: "api.github.com", path: `/repos/${repo}/releases?per_page=10`, method: "GET",
      headers: { "User-Agent": "told-releases", Accept: "application/vnd.github+json" }, timeout: 20000,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        if (res.statusCode === 404) return resolve([]); // private or gone: nothing public to tell
        if (res.statusCode !== 200) return reject(new Error(`${repo}: HTTP ${res.statusCode}`));
        try { const j = JSON.parse(body); resolve(Array.isArray(j) ? j : []); }
        catch (e) { reject(new Error(`${repo}: bad JSON`)); }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`${repo}: timeout`)));
    req.on("error", reject);
    req.end();
  });
}

/** Markdown release notes → one plain paragraph, cut to NOTES_MAX. */
function plainNotes(body) {
  let s = String(body || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*#+[ \t]*/gm, "")
    .replace(/[*_`>|]/g, "")
    .replace(/\s+/g, " ").trim();
  if (s.length > NOTES_MAX) s = s.slice(0, NOTES_MAX).replace(/\s+\S*$/, "") + " […]";
  return s;
}

/** The label and the text of one told memory. */
function toldMemory(repo, rel, toldAt) {
  const name = repo.split("/")[1];
  const published = rel.published_at || rel.created_at || "an unknown date";
  const notes = plainNotes(rel.body);
  const label = `[Provenance: told to me at ${toldAt} by ${TOLD_BY}; ` +
    "this is something I was told, not something I said and not something I lived.]";
  const text = `${name} ${rel.tag_name} was released on ${published}` +
    `${rel.name && rel.name !== rel.tag_name ? ` ("${rel.name}")` : ""}. ` +
    (notes ? `From its release notes: ${notes}` : "It was published without release notes.");
  return { label, text, url: rel.html_url || `https://github.com/${repo}/releases/tag/${rel.tag_name}` };
}

async function main(argv, io = {}) {
  const out = io.out || ((s) => console.log(s));
  const err = io.err || ((s) => console.error(s));
  const fetch = io.fetchReleases || fetchReleases;
  const now = io.now || (() => new Date());
  const dryRun = argv.includes("--dry-run");
  if (argv.includes("--help") || argv.includes("-h")) {
    out(fs.readFileSync(__filename, "utf8").split("\n").slice(2, 34).map((l) => l.replace(/^ \* ?/, "")).join("\n"));
    return 0;
  }
  const repos = (process.env.TOLD_RELEASES_REPOS || DEFAULT_REPOS.join(","))
    .split(",").map((s) => s.trim()).filter((s) => /^[\w.-]+\/[\w.-]+$/.test(s));
  const file = io.stateFile || stateFile();
  const state = loadState(file);
  if (!state.first_run) state.first_run = now().toISOString();
  const since = Date.parse(process.env.TOLD_RELEASES_SINCE || "")
    || (Date.parse(state.first_run) - 14 * 24 * 3600 * 1000);

  let failed = 0, told = 0, skippedOld = 0;
  for (const repo of repos) {
    let rels;
    try { rels = await fetch(repo); }
    catch (e) { err(`told-releases: ${e.message}`); failed++; continue; }
    // Oldest first, so her store receives them in the order they happened.
    rels = rels.filter((r) => r && r.tag_name && !r.draft)
      .sort((a, b) => Date.parse(a.published_at || 0) - Date.parse(b.published_at || 0));
    for (const rel of rels) {
      const id = `${repo}@${rel.tag_name}`;
      if (state.seen[id]) continue;
      if (Date.parse(rel.published_at || rel.created_at || 0) < since) {
        if (!dryRun) state.seen[id] = "before-window";
        skippedOld++;
        continue;
      }
      const toldAt = now().toISOString();
      const m = toldMemory(repo, rel, toldAt);
      if (dryRun) { out(`${m.label} ${m.text}\nLinks: ${m.url}\n`); told++; continue; }
      const r = await voiceWriteback.rememberPublication({
        text: m.text, label: m.label, results: [{ name: "told (release watcher)", ok: true, url: m.url }],
        composer: "told-releases.js (text copied from GitHub release notes)", importance: IMPORTANCE,
      });
      if (r.stored || r.alreadyStored) { state.seen[id] = toldAt; told++; out(`told: ${id}`); }
      else { err(`told-releases: ${id} not stored — ${r.reason || "unknown"}`); failed++; }
    }
  }
  if (!dryRun) { await voiceWriteback.flush(); saveState(state, file); }
  out(`told-releases: ${told} ${dryRun ? "would be told" : "told"}, ${skippedOld} before the window, ${failed} failed`);
  return failed ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; },
    (e) => { console.error(`told-releases: ${e && e.message}`); process.exitCode = 1; });
}

module.exports = { main, toldMemory, plainNotes, loadState, DEFAULT_REPOS };
