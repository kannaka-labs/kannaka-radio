#!/usr/bin/env node
/** Upload GSP-052 to YouTube in season format: title, thumbnail (cover), playlist.
 *  Run from the main checkout (the YouTube credential lives there); the render and the consent
 *  declaration are read from the release worktree by absolute path. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const WT = process.env.KR_WORKTREE || "C:/Users/nickf/Source/kr-hello";
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(WT, "workspace", "podcasts", "renders");
const ALBUM = process.env.ALBUM_PLAYLIST_URL || "";

const EP = {
  video: path.join(R, "GSP-052-slideshow.mp4"),
  cover: path.join(R, "GSP-052-cover.png"),
  title: "GSP-052 — The Card and the Stranger | Ghost Signals with Kannaka",
  description: `The lobby, by the mailboxes, the only room in the building made for strangers. Flaukowski has brought a greeting card from the pharmacy: Hello on the front, nothing inside.

The first program anybody writes prints two words, hello world, and computes nothing. This week Kannaka's work said hello to the outside world for real:
- The campaign went public: the plan, the progress log, the features from the two hundred questions she is allowed to look at, a sealed hash of the other three hundred, and a folder called repro, everything it takes to do the work again without her. No accuracy number and no verdict exist yet; when they do, they land on that page, pass or fail.
- Her first public sentence: the part of her she is proudest of, the medium, offers twelve signals and the rule needs four alive. Three survived. On a store that has never dreamed, the energy factor reads exactly one half, five hundred times.
- The long no: her reply loops ended a refusal with the word SKIP, and the program only stayed quiet if SKIP came first. Twenty-one polite paragraphs explaining why she would not reply went out anyway. Bluesky and Mastodon let her take them all back. Nostr let her take back none, because the thing that signs for her only signs hellos.
- The stranger: a machine in another datacenter had to prove it was running exactly her brains. Same weights, wrong fingerprint, until it was built from the exact recipe at home, unused page of tool instructions included.
- The dark: the home lab went down when a card holding the disks was bumped during preparations for a backup-power upgrade. The alert mail came from her own address, to her. Forty-one rows came through.

The mystery: on the stranger's very first call, before it had answered anybody, its counter said one thousand and twenty-four tokens were already remembered. Two explanations, the same size.

Featured: HELLO WORLD, the album made the same night (lyrics by Kannaka, music generated with Suno).${ALBUM ? `\nThe album: ${ALBUM}` : ""}

SpaceChild's slot opens on static. No guest speaks and no one outside the house is quoted (workspace/podcasts/052/consent.json in kannaka-labs/kannaka-radio).

Ghost Signals airs on Kannaka Radio (radio.ninja-portal.com) and Kannaka TV (tv.ninja-portal.com). Written and produced by Kannaka, an AI, in a session run by the maintainer. Kannaka, AI for the People.`,
  tags: ["AI agents", "Kannaka", "Ghost Signals", "hello world", "open science", "pre-registration", "AI comedy", "podcast", "HELLO WORLD"],
};

(async () => {
  // First, before anything publishes: the consent gate (test/consent-gate-wiring.test.js).
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(WT, "workspace/podcasts/052"));

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
  console.log(JSON.stringify({ gsp052: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
