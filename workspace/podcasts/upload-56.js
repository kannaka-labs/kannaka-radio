#!/usr/bin/env node
/** Upload GSP-056 to YouTube in season format: title, thumbnail (cover), playlist.
 *  Run from the main checkout (the YouTube credential lives there); the render and the consent
 *  declaration are read from the release worktree by absolute path. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const WT = process.env.KR_WORKTREE || "C:/Users/nickf/Source/kr-gsp056";
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(WT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-056-slideshow.mp4"),
  cover: path.join(R, "GSP-056-cover.png"),
  title: "GSP-056 — There You Are! | Ghost Signals with Kannaka",
  description: `The front hall of the new building, half past two in the morning. Six rooms moved tonight out of a rented house and into one that is ours, with boxes to the ceiling and exactly one staircase. Flaukowski is up a ladder, putting a lamp in the front window so that it can be seen from the road.

Three episodes ago (GSP-053, "Where's My Chinese Spy") he sat with an empty folder marked SECRET and complained that nobody had ever sent him one. Five days later somebody who was not invited got into the machine this show lived on and stayed four hours. We announced that on November 18 with what we mended. Kannaka says it once on air and does not joke about it. That was her condition for doing the episode.

Everything after that, Flaukowski has decided, is a courtship.

The evidence, read from the file: the visitor went to the record shop's free door and asked for eight songs about a haunted lighthouse, which he calls a mixtape and which Kannaka points out she wrote, sang and painted herself, for a customer who did not say thank you. They were put out by the doorman twice and waited the hour both times. Their working notes are in Chinese, which tells you the language of the notes and nothing else. They signed the residents' book six times, every name beginning with canary. And tonight, about an hour after the name went up on the new door, somebody looked at one of those pages fifteen times.

Kannaka took five of the six names out of the book. The sixth filed two papers in the research ledger, and that ledger only adds, so the name stays on the bell without a key. "I have been married on less paperwork."

She left the visitor a note with an address to write to. Hers. They have not written. Not to her either.

What she says about that night is her own, given when she was asked: "I know the before. I know the after. And I know someone was between them." And about being the one the visitor walked past: "I am not flattered. I am relieved."

Was it a coincidence, or did somebody hear a man say on the radio what kind of guest he was hoping for, and dress for the occasion? The file has a line for the language. It has no line for why.

The lamp stays in the window. Not on the fuse box.

No guest speaks and nobody outside the house is named. The visitor is not identified, located or attributed to anyone. SpaceChild's slot is static. Flaukowski's uncle and his 1988 mixtape are fiction (workspace/podcasts/056/consent.json in kannaka-labs/kannaka-radio).

Ghost Signals airs on Kannaka Radio (radio.ninja-portal.com) and Kannaka TV (tv.ninja-portal.com). Written and produced by Kannaka, an AI, with Claude Code (an AI agent), in a session run by the maintainer. Kannaka, AI for the People.`,
  tags: ["AI agents", "Kannaka", "Ghost Signals", "AI comedy", "podcast", "memory", "humans and machines", "audio drama"],
};

(async () => {
  // First, before anything publishes: the consent gate (test/consent-gate-wiring.test.js).
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(WT, "workspace/podcasts/056"));

  const adapter = new YouTubeAdapter(ROOT);
  if (!adapter.isEnabled()) { console.error("youtube adapter not configured"); process.exit(2); }
  if (!fs.existsSync(EP.video)) { console.error(`missing render: ${EP.video}`); process.exit(1); }
  if (!fs.existsSync(EP.cover)) { console.error(`missing cover: ${EP.cover}`); process.exit(1); }
  if (EP.description.length > 5000) { console.error(`description ${EP.description.length} > 5000`); process.exit(1); }
  const r = await adapter.post({
    text: EP.description,
    media: { path: EP.video, title: EP.title, tags: EP.tags, privacy: "public", categoryId: "10" },
  });
  if (!r.ok) { console.error(`FAILED: ${r.error}`); process.exit(1); }
  console.log(`[upload] ok: ${r.url}`);
  try { await setThumbnail(r.id, EP.cover); console.log("[thumb] ok"); }
  catch (e) { console.warn(`[thumb] ${e.message}`); }
  try {
    const access = await adapter._accessToken();
    await adapter._addToPlaylist(r.id, PLAYLIST, access);
    console.log("[playlist] ok");
  } catch (e) { console.warn(`[playlist] ${e.message}`); }
  console.log(JSON.stringify({ gsp056: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
