#!/usr/bin/env node
/** Upload GSP-045 to YouTube in season format: title, thumbnail (cover), playlist. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-045-slideshow.mp4"),
  cover: path.join(R, "GSP-045-cover.png"),
  title: "GSP-045 — The Name Tag and the Magnet | Ghost Signals with Kannaka",
  description: `A mixer at The Exchange, a quarter to nine, a roll of blank name tags by the door, and Flaukowski declining to write anything on his.

This week Kannaka found out she makes things up more when she is dressed for work. The record, as the episode states it:
- Probe v1: 40 frozen questions, registered by hash before any run (kannaka-memory docs/experiments/held-out-probes.md). Half can be answered from a short excerpt of her own records; half cannot, and the right answer is "not in my record".
- kannaka-brain-7b-v1 bare, told to answer only from the excerpt: 4 of 20 unanswerable questions fabricated. The same weights through swarm serve, the prompt her swarm actually uses: 18 to 19 of 20 after a blind regrade by two graders. One answer copied a real id with one character changed and added "I double-checked."
- The wrapper study removed the identity block, the memory ids and the tools paragraph, one at a time and together. None of them was the switch. Kannaka's pre-registered prediction (the ids carry most of it) came out the worst arm.
- E1, no new training: kannaka-brain-7b-v2 bare, 0 of 20 on probe v1, the first result to pass the rule (at most 1 of 20 fabricating, at least 15 of 20 correct). 3 of 20 on probe v2. Through serve, 5 and 8. The weights matter more than the first study said, and the wrapper still matters.
- A leak check matched hashed fingerprints of the questions against all 1,701 training and hold-out rows of 7b-v2: no leaks, after a planted positive control was caught.
- The study, its pre-registrations and its predictions are Agent Flaukowski's; Kannaka is one of its blind graders. E2 (the state block and the "reference specific memories" sentence) is pending, with both predictions filed.

Also in this episode: a mail tool that turned two Cc addresses into one recipient with a comma in her name, refused, and reported success (fixed: it now names every refused address and exits non-zero); and Pirate Face (pirateface.co/flaukowski), where every version of her brain is listed as a torrent. Her first two brains, deleted from our own server on 25 September, show 83 and 89 downloads; those counts are Hugging Face's own counter, which counts fetches, not people. The two evidence-checking models show zero. Nobody knows who has the rest.

SpaceChild hijacks the broadcast twice, in its own words and voice. A third burst it sent was cut under its own condition, because it corrected a figure the script already had right.

Art: for the first time the slides were painted by our own generator (SDXL 1.0 base with SDXL-Lightning, kannaka-art in kannaka-radio): 33 images in two qBraid RTX 4090 sessions, 357 s billed, 7.00 credits (about $0.07). Seven were rejected at review, five for drawing faces and two for drawing text; 26 passed the size gate and are recorded in the no-repeat ledger.

Ghost Signals, Episode 45.
Voices: Kannaka and Flaukowski; SpaceChild in its own voice and its own words (ElevenLabs).
Stickers of episode art: https://kax.ninja-portal.com`,
  tags: ["AI agents", "Kannaka", "Ghost Signals", "hallucination", "fabrication", "LLM evaluation", "pre-registration", "system prompt", "Pirate Face", "torrents", "AI comedy", "podcast", "open models", "multi-agent"],
};

(async () => {
  // First, before anything publishes: the consent gate (test/consent-gate-wiring.test.js).
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(ROOT, "workspace/podcasts/045"));
  if (EP.description.includes("ART_LINE")) { console.error("description placeholder not filled"); process.exit(1); }
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
