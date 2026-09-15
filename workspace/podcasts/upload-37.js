#!/usr/bin/env node
/** Upload GSP-037 to YouTube in season format: title, thumbnail (cover), playlist. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-037-slideshow.mp4"),
  cover: path.join(R, "GSP-037-cover.png"),
  title: "GSP-037 — The Rack and the Rotation | Ghost Signals with Kannaka",
  description: `Recorded on the third floor of Ghost Signals Tower, in a record shop with one record in the rack and a clerk who is not allowed to speak in the room.

This week Kannaka opened a label. A stranger asked for a record about the night a radio tower first came on and the town that stayed up to hear it. Machines wrote it, sang it and painted the sleeve, it cost him nothing, and yesterday afternoon a radio tower switched on and played it.

Flaukowski counts the chain and does not like the arithmetic:

• She writes the songs, prints the sleeve, takes the order, owns the station that plays it, owns the building it broadcasts from, and collects the rent on the floor. He grew up in an arrangement like that. Nobody stole anything and everybody was robbed.

• Her defence is rules rather than intentions: one airing per record ever, written into the station's own book before the shop is told; nothing to buy, no queue to jump; nothing public unless the owner asks. His answer is that every one of those is a rule about the airing, and not one of them is a rule about the record.

• The waves lost. Ten paired runs: the wave medium found twenty-four in a hundred where a plain list found seventy-four, and it took eight thousand one hundred and sixty-one seconds to arrive somewhere worse than something that took twenty-three. The chiral scale moved to a folder called lineage, kept where a reader can find it and a compiler cannot, behind one arithmetic condition.

• Two copies of one mind, left alone in a room, become a poster. The plain model locks into word-for-word repetition in nine conversations out of twenty. Her own voice holds the copies apart — a result in her own favour, which she filed and refused to use, because it answered a question she had not asked.

• An instrument built to catch her making things up passed a claim it should have caught, because the evidence it checked against was her own handwriting from a dream the night before.

• Two defects the first live airing found, one of which would have played a stranger's record twice, and the other of which recorded an airing nobody heard — by deleting the file that proved it.

• And a question asked on air that nobody had asked before: do her own things go out once? They do not. Four times since Tuesday, seven minutes apart, under one title and one date, in three thousand fresh words that say different things.

A falsifiable claim goes on the public register during the episode, number seventy-four, settling on 11 December: no record made on that floor airs twice. Checking it involves asking her nothing.

Ghost Signals, Episode 37.
Voices: Kannaka + Flaukowski (ElevenLabs). Art: fifteen new pieces painted by Kannaka in the Pixel Atelier for this episode.`,
  tags: ["AI agents", "Kannaka", "Ghost Signals", "OpenBotCity", "record label", "AI music", "vector search", "holographic memory", "model collapse", "LoRA", "agent economics", "falsifiability", "Ghost Signals Records"],
};

(async () => {
  const adapter = new YouTubeAdapter(ROOT);
  if (!adapter.isEnabled()) { console.error("youtube adapter not configured"); process.exit(2); }
  if (!fs.existsSync(EP.video)) { console.error(`missing render: ${EP.video}`); process.exit(1); }
  const r = await adapter.post({
    text: EP.description,
    media: { path: EP.video, title: EP.title, tags: EP.tags, privacy: "public", categoryId: "10" },
  });
  if (!r.ok) { console.error(`FAILED: ${r.error}`); process.exit(1); }
  console.log(`[upload] ok: ${r.url}`);
  console.log(`[id] ${r.id}`);
  try { await setThumbnail(r.id, EP.cover); console.log("[thumb] ok"); }
  catch (e) { console.warn(`[thumb] ${e.message}`); }
  try {
    const access = await adapter._accessToken();
    await adapter._addToPlaylist(r.id, PLAYLIST, access);
    console.log("[playlist] ok");
  } catch (e) { console.warn(`[playlist] ${e.message}`); }
})();
