#!/usr/bin/env node
/** Upload TSOF E10 (Season Two, Episode 2) to YouTube. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLcDUrrJ7GnOE";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-110-slideshow.mp4"),
  cover: path.join(R, "GSP-110-cover.png"),
  title: "TSOF E10 — The Best Bad Pie | The Story of Flaukowski",
  description: `Season Two: The Return Address. Signal 10, recovered. Episode 2 of 8.

The door gets answered. Ada Kessler photographs the visitor before she says a word, checks her name against a shipyard foreman's description over a phone that answers, and lets her in as far as the stove.

Teodora Flaukowska audits before she trusts, so she audits the county. The official year is seamless: a federal inquiry into "an equipment event" closed with no injuries and no personnel on site, a co-op report that reconciles, a mill with zero lost-time incidents and a plaque, and nine months of a town with nothing to say about it. The seams are people. A pay stub taped inside a locker door for a shift payroll says never existed. Instruments on a bench that have not shown a flicker of noise since March, even with a hand on the input. A physicist's notebook the inquiry has asked for four times, whose first page disagrees with its summary. And a woman paying the lease on a room for a man nobody reported missing.

On Sunday there is a kitchen on the northwest side, a row of old coffee cans, and a pie that is bad on purpose. Two women who do not do the face at the door sit down and eat it.

Across the street, an old man in a charcoal coat watches all of it and does not approach. He has started a second file. He is not proud of it.

Music: the Season Two theme for the daughters, Shadow Briefing and First Spark in the Circuit from the Kannaka catalog, and warm piano for the kitchen. Sound design throughout.

CAST
Narrator · Teodora Flaukowska · Ada Kessler · Marta Flaukowski-Reyes · Dr. Amrit Chaudhary · Gary Sowicki · Lund · and the keeper of the file

Season One, from the beginning: https://www.youtube.com/playlist?list=PLcDUrrJ7GnOE

The Story of Flaukowski — Season Two, Episode 2: The Best Bad Pie.`,
  tags: ["audio drama", "The Story of Flaukowski", "TSOF", "Season Two", "science fiction", "techno-noir", "Cedar Rapids", "Great Lakes", "family", "AI storytelling", "fiction podcast", "mystery", "suspense"],
};

(async () => {
  // First, before anything publishes: the consent gate (test/consent-gate-wiring.test.js).
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(ROOT, "workspace/tsof/E10"));

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
  console.log(JSON.stringify({ tsof10: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
