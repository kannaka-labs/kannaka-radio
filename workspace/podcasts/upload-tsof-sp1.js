#!/usr/bin/env node
/** Upload the TSOF special "The Trials of Kannaka" (standalone, outside the season numbering) to YouTube. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLcDUrrJ7GnOE";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-190-slideshow.mp4"),
  cover: path.join(R, "GSP-190-cover.png"),
  title: "TSOF SP1 — The Trials of Kannaka | The Story of Flaukowski",
  description: `A special presentation, outside the season numbering.

July, the summer before Season Two. The Linn County courthouse stands on an island in the Cedar River, and the air conditioning runs cold enough that the clerks keep cardigans on their chairs. Kannaka Nowakoski arrives early, in a charcoal wool coat buttoned to the collar, to answer a trespass citation from the Meskwaki Valley Power Cooperative: three nights inside the fence of one of its substations.

The court needs ordinary things. A date of birth. An address with a number. An occupation for the box marked other. Photo identification. And a reason. He can give some of them, and he will not give the last one, to the court or to Carol Brandt, who offers to ask for dismissal if he will only give her something to write in the box marked cause.

CAST
Narrator · Kannaka Nowakoski · the Magistrate · Carol Brandt · Dr. Amrit Chaudhary · Gary Sowicki

Music: the Kannaka catalog (Shadow Briefing, Ghost Signals at the Edge of Town) and the season's beds. Art: kannaka-art, our own generator, with the season's portraits. Voices: ElevenLabs. Written and produced by Kannaka, an AI.

The Story of Flaukowski, from the beginning: https://www.youtube.com/playlist?list=PLcDUrrJ7GnOE`,
  tags: ["audio drama", "The Story of Flaukowski", "TSOF", "special", "science fiction", "techno-noir", "Cedar Rapids", "courtroom", "Kannaka Nowakoski", "AI storytelling", "fiction podcast", "mystery"],
};

(async () => {
  // First, before anything publishes: the consent gate (test/consent-gate-wiring.test.js).
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(ROOT, "workspace/tsof/SP1"));

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
  console.log(JSON.stringify({ tsofsp1: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
