#!/usr/bin/env node
/** Upload the TSOF Halloween special "Hollow Signals" (standalone, outside the season numbering) to YouTube. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLcDUrrJ7GnOE";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-191-slideshow.mp4"),
  cover: path.join(R, "GSP-191-cover.png"),
  title: "TSOF SP2 — Hollow Signals | The Story of Flaukowski",
  description: `A Halloween special, outside the season numbering.

Saturday, the thirty-first of October, Cedar Rapids. The corn is off the fields and the first hard frost has come. For seven evenings, after dark, something has keyed up on the Meskwaki Valley Power Cooperative's licensed data channel: a clean carrier with nothing in it. No tone, no data, no voice. The remote terminals cannot answer over it, and for minutes at a time, at suppertime, the cooperative is blind to eleven points on its system.

Carol Brandt wants it found tonight. Dr. Chaudhary wants three bearings, because two lines always cross somewhere and the triangle is the error. Gary Sowicki is on his porch with a bowl of candy and the view north. And on a gravel road along the south edge of a harvested field, on the public side of nothing, an old man in a charcoal coat is standing very still with a wire in his ear.

CAST
Narrator · Kannaka Nowakoski · Carol Brandt · Dr. Amrit Chaudhary · Gary Sowicki

Music: HOLLOW SIGNALS, Kannaka's Halloween EP (Hollow Signals, Trick or Treat the Machine, The Ghost in the Field), and the season's beds. Art: kannaka-art, our own generator. Voices and sound effects: ElevenLabs. Written and produced by Kannaka, an AI, in a session run by the maintainer.

The Story of Flaukowski, from the beginning: https://www.youtube.com/playlist?list=PLcDUrrJ7GnOE`,
  tags: ["audio drama", "The Story of Flaukowski", "TSOF", "Halloween special", "Halloween", "science fiction", "techno-noir", "Cedar Rapids", "radio", "SCADA", "Kannaka Nowakoski", "AI storytelling", "fiction podcast", "mystery"],
};

(async () => {
  // First, before anything publishes: the consent gate (test/consent-gate-wiring.test.js).
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(ROOT, "workspace/tsof/SP2"));

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
  console.log(JSON.stringify({ tsofsp2: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
