#!/usr/bin/env node
/**
 * remember-said.js — write something said under Kannaka's name into her own
 * store, by hand, with the same provenance label and the same shared dedupe
 * ledger as everything the radio posts (server/voice-writeback.js).
 *
 * For words that went out by a path no code here runs: a correction posted
 * from a Claude Code session, a reply typed into a client, a post from
 * another repo. One command instead of a hand-written `kannaka remember`:
 *
 *   node scripts/remember-said.js --surface bluesky,mastodon \
 *     --url https://bsky.app/profile/…/post/… \
 *     --composer "Claude Code session (correction to the 11-06 teaser)" \
 *     "A correction: yesterday's post retold a story from the oration as if it were mine. It was not."
 *
 *   node scripts/remember-said.js --surface "OpenClawCity DM" --private --file reply.txt
 *
 * Options:
 *   --surface <a,b>    where it was said (repeatable or comma-separated); required
 *   --url <u>          a link to it (repeatable, up to 6 kept)
 *   --composer <who>   who wrote the words (default: "by hand (remember-said.js)")
 *   --context <text>   e.g. "in reply to @someone"
 *   --private          a private message: labelled so, text kept off the swarm bus
 *   --importance <x>   0..1 (default 0.50, voice-writeback's IMPORTANCE)
 *   --file <path>      read the text from a file instead of the arguments
 *   --dry-run          print the memory that would be stored; store nothing
 *   --help             this text; runs nothing
 *
 * It stores into the store KANNAKA_BIN / KANNAKA_DATA_DIR resolve to, so run it
 * where her store lives (O1: cd ~/kannaka-radio && node scripts/remember-said.js …).
 * KANNAKA_VOICE_WRITEBACK=0 and KANNAKA_READONLY=1 skip it as they skip every
 * write-back; KANNAKA_VOICE_WRITEBACK=force overrides READONLY.
 *
 * Exit: 0 stored (or identical text already stored inside the window), 1 not
 * stored, 2 usage error.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const voiceWriteback = require(path.join(__dirname, "..", "server", "voice-writeback"));

const USAGE = fs.readFileSync(__filename, "utf8").split("\n")
  .slice(2, 34).map((l) => l.replace(/^ \* ?/, "")).join("\n");

function parseArgs(argv) {
  const o = { surfaces: [], urls: [], composer: null, context: null, private: false,
    importance: null, file: null, dryRun: false, help: false, words: [] };
  const take = (i, name) => {
    if (i + 1 >= argv.length) throw new Error(`${name} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--surface": o.surfaces.push(...take(i, a).split(",").map((s) => s.trim()).filter(Boolean)); i++; break;
      case "--url": o.urls.push(take(i, a)); i++; break;
      case "--composer": o.composer = take(i, a); i++; break;
      case "--context": o.context = take(i, a); i++; break;
      case "--importance": {
        const v = Number(take(i, a)); i++;
        if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error("--importance must be a number from 0 to 1");
        o.importance = v; break;
      }
      case "--file": o.file = take(i, a); i++; break;
      case "--private": o.private = true; break;
      case "--dry-run": o.dryRun = true; break;
      case "--help": case "-h": o.help = true; break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
        o.words.push(a);
    }
  }
  return o;
}

/**
 * @param {string[]} argv
 * @param {{ out?: function, err?: function }} [io]
 * @returns {Promise<number>} the exit code
 */
async function main(argv, io = {}) {
  const out = io.out || ((s) => console.log(s));
  const err = io.err || ((s) => console.error(s));
  let o;
  try { o = parseArgs(argv); } catch (e) { err(`remember-said: ${e.message}\n\n${USAGE}`); return 2; }
  if (o.help) { out(USAGE); return 0; }
  let text = o.words.join(" ");
  if (o.file) {
    if (text) { err("remember-said: give the text OR --file, not both"); return 2; }
    try { text = fs.readFileSync(o.file, "utf8"); } catch (e) { err(`remember-said: cannot read ${o.file}: ${e.message}`); return 2; }
  }
  if (!text.trim()) { err(`remember-said: no text given\n\n${USAGE}`); return 2; }
  if (o.surfaces.length === 0) { err("remember-said: --surface is required (where was it said?)"); return 2; }

  const p = {
    text,
    results: o.surfaces.map((name) => ({ name, ok: true })),
    links: o.urls,
    composer: o.composer || "by hand (remember-said.js)",
    private: o.private,
    context: o.context || undefined,
    importance: o.importance == null ? undefined : o.importance,
  };

  if (o.dryRun) {
    out(voiceWriteback.buildMemoryText({
      text, surfaces: o.surfaces, composer: p.composer, urls: o.urls,
      private: o.private, context: p.context,
    }));
    const why = voiceWriteback.skipReason(p);
    out(`\n(dry run: nothing stored${why ? `; a real run would skip — ${why}` : ""})`);
    return 0;
  }

  const r = await voiceWriteback.rememberPublication(p);
  await voiceWriteback.flush();
  if (r.stored) { out("stored"); return 0; }
  // Only a COMPLETED store counts; "being stored by another process" is not.
  if (r.alreadyStored) { out(`already stored — ${r.reason}`); return 0; }
  err(`not stored — ${r.reason || "unknown"}`);
  return 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; },
    (e) => { console.error(`remember-said: ${e && e.message}`); process.exitCode = 1; });
}

module.exports = { main, parseArgs };
