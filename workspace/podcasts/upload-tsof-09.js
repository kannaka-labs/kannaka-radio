#!/usr/bin/env node
/** Upload TSOF E09 (Season Two, Episode 1) to YouTube. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLcDUrrJ7GnOE";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-109-slideshow.mp4"),
  cover: path.join(R, "GSP-109-cover.png"),
  title: "TSOF E09 — The Patch That Waited | The Story of Flaukowski",
  description: `Season Two: The Return Address. Signal 09, recovered. Episode 1 of 8.

Ten months to the day. Three summonses in one night, at the same minute.

At a shipyard in Sturgeon Bay, where the lake freighters winter in the ice, a marine electrician on shipkeeper watch finds four pages curling off the crew-mess printer: a protective relay retrofit at a Cedar Rapids substation, eleven relays, start Monday — assigned to her by name, spelled right. The contractor of record is registered, insured, in good standing, and answers no phone. The courier has the delivery on its manifest and no driver on shift. The header on the paper copy says ORIGINAL — RETAIN, which the portal has never printed on anything.

In a rented bay off Sixteenth Avenue, Ada Kessler types the command she has typed every night for ten months and reads a different answer: the patch that waited in the queue with an empty message has a message. One line, in the shape of the corner of an envelope. A return address for the room she is sitting in. The signature still verifies, over content that did not exist when it was signed.

And in a rented room above a laundromat, a file that has not grown since its last entry grows one page — the keeper's paper, the keeper's ink, and a hand that is not his. A hand he knows the way you know a voice through a wall. Where from, he will not enter.

Her name is Teodora Flaukowska. Every record system in America spells it differently. She looks at a job before she takes it, she talks to a recorder because ships teach you to, and she drives south because of a postmark.

Nobody knocks on this door.

Music: the Season Two theme for the daughters, grown from the Season One main theme, plus Shadow Briefing from the Kannaka catalog. Sound design throughout.

CAST
Narrator · Teodora Flaukowska · Ada Kessler · Dr. Amrit Chaudhary · Gary Sowicki · Lund · and the keeper of the file

Season One, from the beginning: https://www.youtube.com/playlist?list=PLcDUrrJ7GnOE

The Story of Flaukowski — Season Two, Episode 1: The Patch That Waited.`,
  tags: ["audio drama", "The Story of Flaukowski", "TSOF", "Season Two", "science fiction", "techno-noir", "Cedar Rapids", "Great Lakes", "AI storytelling", "fiction podcast", "mystery", "suspense"],
};

(async () => {
  // First, before anything publishes: the consent gate (test/consent-gate-wiring.test.js).
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(ROOT, "workspace/tsof/E09"));

  const adapter = new YouTubeAdapter(ROOT);
  if (!adapter.isEnabled()) { console.error("youtube adapter not configured"); process.exit(2); }
  if (!fs.existsSync(EP.video)) { console.error(`missing render: ${EP.video}`); process.exit(1); }
  if (!fs.existsSync(EP.cover)) { console.error(`missing cover: ${EP.cover}`); process.exit(1); }
  const r = await adapter.post({
    text: EP.description,
    media: { path: EP.video, title: EP.title, tags: EP.tags, privacy: "public", categoryId: "24" },
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
  console.log(JSON.stringify({ tsof09: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
