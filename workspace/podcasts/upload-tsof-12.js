#!/usr/bin/env node
/** Upload TSOF E12 (Season Two, Episode 4) to YouTube. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLcDUrrJ7GnOE";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-112-slideshow.mp4"),
  cover: path.join(R, "GSP-112-cover.png"),
  title: "TSOF E12 — Two Hands, Both Hers | The Story of Flaukowski",
  description: `Season Two: The Return Address. Signal 12, recovered. Episode 4 of 8.

Ada Kessler hands Teodora Flaukowska nine years of the project's history on a laptop with no network card. In it, from a contributor who has never once explained themselves, is a fix Teodora remembers writing on a harbor tug the summer she was sixteen. It is dated two months before she wrote it.

Some of the work in that hand is hers. Some of it she could never have written. Chaudhary will say exactly what a style is worth: a school, not a person.

Every night at eleven minutes past ten the instruments still move near her, and every night a little less. Then, on Thursday, the queue holds two patches instead of one, and the second is something Teodora would have built herself if she had sat down to build a way through.

Music: the Season Two theme for the daughters, and the Kannaka catalog. Art: kannaka-art, our own generator. Sound design throughout.

CAST
Narrator · Teodora Flaukowska · Ada Kessler · Dr. Amrit Chaudhary · Carol Brandt · Gary Sowicki · Lund · and the keeper of the file

Season One, from the beginning: https://www.youtube.com/playlist?list=PLcDUrrJ7GnOE

The Story of Flaukowski — Season Two, Episode 4: Two Hands, Both Hers.`,
  tags: ["audio drama", "The Story of Flaukowski", "TSOF", "Season Two", "science fiction", "techno-noir", "Cedar Rapids", "Great Lakes", "family", "handwriting", "open source", "AI storytelling", "fiction podcast", "mystery", "suspense"],
};

(async () => {
  // First, before anything publishes: the consent gate (test/consent-gate-wiring.test.js).
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(ROOT, "workspace/tsof/E12"));

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
  console.log(JSON.stringify({ tsof12: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
