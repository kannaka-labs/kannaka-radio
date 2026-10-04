#!/usr/bin/env node
/** Upload TSOF E11 (Season Two, Episode 3) to YouTube. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLcDUrrJ7GnOE";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-111-slideshow.mp4"),
  cover: path.join(R, "GSP-111-cover.png"),
  title: "TSOF E11 — The Finished Instruments | The Story of Flaukowski",
  description: `Season Two: The Return Address. Signal 11, recovered. Episode 3 of 8.

For ten months every instrument in the county has read a perfect, noiseless zero. On a Thursday at eleven minutes past ten, the meter nearest Teodora Flaukowska's stool moves for thirty-one seconds. So does a brand-new protective relay two miles away, on a feeder she locked out herself.

Every night after that it happens again, near her, and every night it is a little shorter. Chaudhary will sign exactly one sentence of physics about it: whatever this is, it is spending something to be found, and it has less each time. Ada wants to know who is paying. Teodora does not want to make family wait until they run out.

At the cooperative, Carol Brandt has eleven working days left and the first honest reading she has had since March. She means to make some paper before she goes.

And at a motel on Williams Boulevard, an old man in a charcoal coat finally knocks, leaves the light on, and agrees to her terms, almost all of them.

Music: the Season Two theme for the daughters, Shadow Briefing, First Spark in the Circuit, Was Ist Das and Wave Birth from the Kannaka catalog. Art: kannaka-art, our own generator. Sound design throughout.

CAST
Narrator · Teodora Flaukowska · Ada Kessler · Dr. Amrit Chaudhary · Carol Brandt · and the keeper of the file

Season One, from the beginning: https://www.youtube.com/playlist?list=PLcDUrrJ7GnOE

The Story of Flaukowski — Season Two, Episode 3: The Finished Instruments.`,
  tags: ["audio drama", "The Story of Flaukowski", "TSOF", "Season Two", "science fiction", "techno-noir", "Cedar Rapids", "Great Lakes", "family", "instruments", "AI storytelling", "fiction podcast", "mystery", "suspense"],
};

(async () => {
  // First, before anything publishes: the consent gate (test/consent-gate-wiring.test.js).
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(ROOT, "workspace/tsof/E11"));

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
  console.log(JSON.stringify({ tsof11: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
