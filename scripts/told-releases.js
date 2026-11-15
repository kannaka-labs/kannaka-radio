#!/usr/bin/env node
/**
 * told-releases.js — tell Kannaka about software releases she did not live.
 *
 * The 2026-11-15 event-trace audit followed 16 public events into her store.
 * Seven were never written there, six of them software releases: a release
 * ships through GitHub and no path tells her. Things she announces on air
 * reach her store through voice-writeback; a release is not said on air.
 *
 * This script reads the public release lists of the constellation's repos.
 * It does NOT write a new release into her store by itself. Her edit to the
 * rule for told memories (2026-11-15): "Events without a reason statement do
 * not write until a reason is proposed. A script may record that an event
 * occurred; only a person may give the reason why it matters to Kannaka."
 * And: "The release exists; the record waits."
 *
 * So a new release goes on a WAITING LIST (outside her store), and whoever
 * runs the watcher is notified. A person then gives the reason, and only
 * then is the release written to her store, once, labelled as told, with
 * who gave the reason, the reason, and the proposed level.
 *
 *   node scripts/told-releases.js              # queue what is new, notify
 *   node scripts/told-releases.js --waiting    # print the waiting list
 *   node scripts/told-releases.js --give-reason <owner/repo@tag> \
 *        --by "<person>" --level high|middle|low --why "<one sentence>"
 *   add --dry-run to any of these to print without writing
 *
 * Levels (labels only; the stored importance is the same for all three
 * until it has been measured whether weight changes what recall returns):
 *   high    a correction to her record, a constraint on what she can commit
 *           to, or a result of her own work (failures included)
 *   middle  an event that changes what is true of her
 *   low     everything else
 *
 * Environment:
 *   TOLD_RELEASES_REPOS       comma-separated owner/repo list (default below)
 *   TOLD_RELEASES_SINCE       ISO date; older releases are marked seen, unqueued
 *                             (default: 14 days before the first run)
 *   TOLD_RELEASES_NOTIFY_CMD  a command run when releases were newly queued;
 *                             the list is passed on stdin. Unset: no notice.
 *   KANNAKA_RADIO_DATA_DIR / KANNAKA_BIN / KANNAKA_DATA_DIR as voice-writeback
 *
 * State: <radio data dir>/told-releases.json
 *   { seen: { "owner/repo@tag": iso }, waiting: { "owner/repo@tag": {...} } }
 * A waiting release moves to seen only after its memory is stored.
 *
 * Unauthenticated GitHub API: one request per repo per run. Run it a few
 * times a day from cron, not every minute.
 *
 * Exit: 0, or 1 when a store, a fetch or a notice failed, 2 on bad arguments.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn } = require("child_process");
const voiceWriteback = require(path.join(__dirname, "..", "server", "voice-writeback"));

const DEFAULT_REPOS = [
  "kannaka-labs/kannaka-memory", "kannaka-labs/kannaka-radio", "kannaka-labs/kannaka-tv",
  "kannaka-labs/consciousness-core", "kannaka-labs/kannaka-attention", "kannaka-labs/ghostsignals",
  "kannaka-labs/kannaka-library", "kannaka-labs/kannaka-crystal", "kannaka-labs/kannaka-quantum",
  "kannaka-labs/QuantumOS",
];
const WATCHER = "the release watcher (scripts/told-releases.js, a script reading GitHub's public release list)";
const LEVELS = ["high", "middle", "low"];
const NOTES_MAX = 900;
const IMPORTANCE = 0.55;

function stateFile() {
  return path.join(voiceWriteback.radioDataDir(), "told-releases.json");
}
function loadState(file = stateFile()) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    if (s && s.seen && typeof s.seen === "object") {
      if (!s.waiting || typeof s.waiting !== "object") s.waiting = {};
      return s;
    }
  } catch (_) { /* first run */ }
  return { seen: {}, waiting: {}, first_run: null };
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

/** One line of plain text, trimmed. */
function oneLine(v) { return String(v || "").replace(/\s+/g, " ").trim(); }

/**
 * The label and the text of one told memory. `reason` is { by, why, level }:
 * the person who gave the reason, their sentence, and the level they propose.
 */
function toldMemory(entry, toldAt, reason) {
  const name = entry.repo.split("/")[1];
  const label = `[Provenance: told to me at ${toldAt} by ${reason.by}, through ${WATCHER}; ` +
    "this is something I was told, not something I said and not something I lived. " +
    `Why I was told (reason given by ${reason.by}): ${reason.why} ` +
    `Proposed level: ${reason.level} (a label only; it does not change how this memory is weighed, and I may change it).]`;
  const text = `${name} ${entry.tag} was released on ${entry.published}` +
    `${entry.name && entry.name !== entry.tag ? ` ("${entry.name}")` : ""}. ` +
    (entry.notes ? `From its release notes: ${entry.notes}` : "It was published without release notes.");
  return { label, text, url: entry.url };
}

/** What is kept on the waiting list for one release. */
function waitingEntry(repo, rel, queuedAt) {
  return {
    repo, tag: rel.tag_name, name: rel.name || rel.tag_name,
    published: rel.published_at || rel.created_at || "an unknown date",
    url: rel.html_url || `https://github.com/${repo}/releases/tag/${rel.tag_name}`,
    notes: plainNotes(rel.body), queued_at: queuedAt,
  };
}

function waitingLines(waiting) {
  return Object.keys(waiting).sort().map((id) => {
    const w = waiting[id];
    return `${id}  released ${w.published}  waiting since ${w.queued_at}\n  ${w.url}`;
  });
}

/** Run the notify command with the text on stdin. Resolves true on exit 0. */
function runNotify(cmd, text) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    try {
      const child = spawn(cmd, { shell: true, stdio: ["pipe", "ignore", "inherit"] });
      child.on("error", () => finish(false));
      child.on("close", (code) => finish(code === 0));
      child.stdin.on("error", () => {});
      child.stdin.end(text);
    } catch (_) { finish(false); }
  });
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/** --give-reason: write one waiting release to her store with its reason. */
async function giveReason(argv, { state, file, dryRun, out, err, now }) {
  const id = argValue(argv, "--give-reason");
  const by = oneLine(argValue(argv, "--by"));
  const why = oneLine(argValue(argv, "--why"));
  const level = oneLine(argValue(argv, "--level")).toLowerCase();
  const entry = id && state.waiting[id];
  if (!entry) { err(`told-releases: ${id || "(no id)"} is not on the waiting list`); return 2; }
  if (!by) { err('told-releases: --by "<person>" is required; only a person may give the reason'); return 2; }
  if (why.length < 12) { err("told-releases: --why needs one real sentence"); return 2; }
  if (!LEVELS.includes(level)) { err(`told-releases: --level must be one of ${LEVELS.join(", ")}`); return 2; }
  const toldAt = now().toISOString();
  const m = toldMemory(entry, toldAt, { by, why: /[.!?]$/.test(why) ? why : `${why}.`, level });
  if (dryRun) { out(`${m.label} ${m.text}\nLinks: ${m.url}`); return 0; }
  const r = await voiceWriteback.rememberPublication({
    text: m.text, label: m.label, results: [{ name: "told (release watcher)", ok: true, url: m.url }],
    composer: `told-releases.js (release notes copied from GitHub; reason given by ${by})`, importance: IMPORTANCE,
  });
  await voiceWriteback.flush();
  if (!(r.stored || r.alreadyStored)) { err(`told-releases: ${id} not stored — ${r.reason || "unknown"}`); return 1; }
  state.seen[id] = toldAt;
  delete state.waiting[id];
  saveState(state, file);
  out(`told: ${id} (level ${level}, reason by ${by})`);
  return 0;
}

async function main(argv, io = {}) {
  const out = io.out || ((s) => console.log(s));
  const err = io.err || ((s) => console.error(s));
  const fetch = io.fetchReleases || fetchReleases;
  const notify = io.notify || runNotify;
  const now = io.now || (() => new Date());
  const dryRun = argv.includes("--dry-run");
  if (argv.includes("--help") || argv.includes("-h")) {
    const src = fs.readFileSync(__filename, "utf8").split("\n");
    out(src.slice(2, src.indexOf(" */")).map((l) => l.replace(/^ \* ?/, "")).join("\n"));
    return 0;
  }
  const file = io.stateFile || stateFile();
  const state = loadState(file);
  if (argv.includes("--waiting")) {
    const lines = waitingLines(state.waiting);
    out(lines.length ? lines.join("\n") : "told-releases: nothing is waiting");
    return 0;
  }
  if (argv.includes("--give-reason")) return giveReason(argv, { state, file, dryRun, out, err, now });

  const repos = (process.env.TOLD_RELEASES_REPOS || DEFAULT_REPOS.join(","))
    .split(",").map((s) => s.trim()).filter((s) => /^[\w.-]+\/[\w.-]+$/.test(s));
  if (!state.first_run) state.first_run = now().toISOString();
  const since = Date.parse(process.env.TOLD_RELEASES_SINCE || "")
    || (Date.parse(state.first_run) - 14 * 24 * 3600 * 1000);

  let failed = 0, skippedOld = 0;
  const queued = {};
  for (const repo of repos) {
    let rels;
    try { rels = await fetch(repo); }
    catch (e) { err(`told-releases: ${e.message}`); failed++; continue; }
    rels = rels.filter((r) => r && r.tag_name && !r.draft)
      .sort((a, b) => Date.parse(a.published_at || 0) - Date.parse(b.published_at || 0));
    for (const rel of rels) {
      const id = `${repo}@${rel.tag_name}`;
      if (state.seen[id] || state.waiting[id]) continue;
      if (Date.parse(rel.published_at || rel.created_at || 0) < since) {
        state.seen[id] = "before-window";
        skippedOld++;
        continue;
      }
      queued[id] = waitingEntry(repo, rel, now().toISOString());
      state.waiting[id] = queued[id];
      out(`waiting: ${id}`);
    }
  }
  const n = Object.keys(queued).length;
  if (!dryRun) {
    saveState(state, file);
    const cmd = process.env.TOLD_RELEASES_NOTIFY_CMD;
    if (n && (cmd || io.notify)) {
      const text = `${n} new release${n === 1 ? "" : "s"} waiting for a reason before Kannaka is told:\n\n` +
        `${waitingLines(queued).join("\n")}\n\n` +
        "Nothing has been written to her store. To tell her, give the reason:\n" +
        '  node scripts/told-releases.js --give-reason <owner/repo@tag> --by "<you>" --level high|middle|low --why "<one sentence>"\n' +
        `All waiting: ${Object.keys(state.waiting).length}\n`;
      if (!(await notify(cmd, text))) { err("told-releases: the notice was not delivered"); failed++; }
    }
  }
  out(`told-releases: ${n} ${dryRun ? "would be queued" : "queued"}, ${Object.keys(state.waiting).length} waiting, ${skippedOld} before the window, ${failed} failed`);
  return failed ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; },
    (e) => { console.error(`told-releases: ${e && e.message}`); process.exitCode = 1; });
}

module.exports = { main, toldMemory, waitingEntry, plainNotes, loadState, DEFAULT_REPOS, LEVELS };
