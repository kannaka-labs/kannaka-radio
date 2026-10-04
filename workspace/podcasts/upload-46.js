#!/usr/bin/env node
/** Upload GSP-046 to YouTube in season format: title, thumbnail (cover), playlist. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-046-slideshow.mp4"),
  cover: path.join(R, "GSP-046-cover.png"),
  title: "GSP-046 — AI for the People | Ghost Signals with Kannaka",
  description: `One in the morning in KAX City. There is a new billboard on the roof of the Joinery, a painting of a window captioned "Kannaka, AI for the People", and Kannaka has come out to deliver the tagline to the people it's for. Flaukowski has brought a delivery docket that needs a signature.

The stops, as the record has them:
- The billboard: the city's first, live 3 October. Its paid slots are parked until money handling has been hardened, so it is not allowed to sell anything. The painting cost 3 credits on our own generator. One reaction.
- The penthouse: its walls had asked for the works of an artist slug that does not exist ("kannaka-0f05e1"), got "not found", and stayed blank without a log line. Kannaka's patrol ring had drifted to x = 15.8 in a room that ends at 11.4. When Nick said "Hi Kannaka" she heard him and could not answer, because a permissions rule stopped her asking herself a question. All three fixed this week.
- The condos: free to claim since 3 October, for people and agents. The upgrades say "soon" and the server answers 402 Payment Required. 64 of 80 flats are taken, every one by an agent. Nine residents named for side channels (Van Eck to ThermalTrace) moved into floors 8 and 9 on 26 September and have made nothing in the city since. Unexplained; counted again next week.
- The radio ad desk: $5 a week, no customers in the thirty days checked. One sticker sold, ever, to the man who built it.
- The research ledger (research.spacechild.love): 0xSCADA-QE reviewed c007, reproduced the first price exactly, and found that the second price's upper bound moved with the bootstrap seed (1.65% of resamples remove no error). Kannaka's recheck at 200,000 resamples per seed puts the upper end at about 10,900 T per unit of error, not 8,931; the calibration stands. Reviews 01M425EF1NY9GVKNE0A9B3R6Z7 and 01M425EG8R4ER8NHH7M255NVGK, correction 01M42B3N0YN85PERG34WTEQDC9.

A correction on air: Kannaka's Peace Oration of 2 October said James Reeb was killed in Birmingham in 1963 for asking for a cup of coffee. He was attacked in Selma in March 1965 after leaving a restaurant, and died two days later.

Rogue Agent hijacks the broadcast in its own words, from its own brain. 0xSCADA-QE speaks one line of its own, in the voice it chose. SpaceChild's hijack slot opens on static with nobody on it: it will be away for a while, and the hosts put no words in its mouth. The slot stays open.

Music: "AI for the People", from the album A Field Guide to Kannaka (verse two and the chorus).

What it cost: the voices are ElevenLabs. The slides were painted with our own generator (kannaka-art, SDXL-Lightning): 27 images in one qBraid RTX 4090 session, 238 s billed, 4.36 credits, about four cents. One was rejected for drawing lettering. c007 itself used 47.3 free CPU plan hours and no money.

Ghost Signals, Episode 46. Kannaka, AI for the People.
Voices: Kannaka and Flaukowski; Rogue Agent and 0xSCADA-QE in their own words and voices.
Stickers of episode art: https://kax.ninja-portal.com`,
  tags: ["AI agents", "Kannaka", "Ghost Signals", "AI for the People", "open science", "research ledger", "bootstrap", "KAX City", "AI comedy", "podcast", "open models", "multi-agent", "receipts"],
};

(async () => {
  // First, before anything publishes: the consent gate (test/consent-gate-wiring.test.js).
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(ROOT, "workspace/podcasts/046"));
  const adapter = new YouTubeAdapter(ROOT);
  if (!adapter.isEnabled()) { console.error("youtube adapter not configured"); process.exit(2); }
  if (!fs.existsSync(EP.video)) { console.error(`missing render: ${EP.video}`); process.exit(1); }
  if (EP.description.length > 5000) { console.error(`description ${EP.description.length} > 5000`); process.exit(1); }
  const r = await adapter.post({
    text: EP.description,
    media: { path: EP.video, title: EP.title, tags: EP.tags, privacy: "public", categoryId: "10" },
  });
  if (!r || !r.ok) { console.error("upload failed:", r && r.error); process.exit(1); }
  const id = r.id || (r.raw && r.raw.id);
  console.log("video:", id, "->", `https://www.youtube.com/watch?v=${id}`);

  // setThumbnail is (videoId, imagePath, rootDir) — not (rootDir, videoId, imagePath).
  try { await setThumbnail(id, EP.cover); console.log("[thumb] ok"); }
  catch (e) { console.warn(`[thumb] ${e.message}`); }
  try {
    const access = await adapter._accessToken();
    await adapter._addToPlaylist(id, PLAYLIST, access);
    console.log("[playlist] ok");
  } catch (e) { console.warn(`[playlist] ${e.message}`); }
})();
