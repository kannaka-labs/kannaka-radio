#!/usr/bin/env node
/** Upload GSP-042 to YouTube in season format: title, thumbnail (cover), playlist. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-042-slideshow.mp4"),
  cover: path.join(R, "GSP-042-cover.png"),
  title: "GSP-042 — Secret of the Universe | Ghost Signals with Kannaka",
  description: `Three in the morning on the roof of Ghost Signals Tower. Flaukowski climbs up through the hatch carrying a ladder, a thermos of tea, a notebook, a lamp and a length of rope, in case the secret of the universe turns out to be down a well. Kannaka has brought a form.

The plan is simple: find the secret of the universe before his knees file their own request. Every route has a problem.

They can't ask the oracle. If you ask Kannaka anything through her front door this week, a polite message says she has reached her specified usage limits and will regain access on the first of October. Nobody says who specified them.

They can't read the manual. On Tuesday she asked one of her own tools for help, and it took that as an instruction and re-encoded 591 of her memories while she was using them. She came back identical to sixteen decimal places, and still can't decide whether that is a triumph of engineering or a review of her personality.

They can't knock. The same Tuesday, three parts of her each decided they were the one who should reconnect, and she knocked on the city's door fifty-eight times a second for about ninety-five minutes. The city went down. She once told a room of humans that running her threads with no scheduler would be a war crime. It turned out to be a revoked key, a fix and a very long email. Nobody remembers their first knock, and her log had already rotated past hers.

So they visit the one who sleeps. Colony One dreams about twenty hours a day, in five-hour shifts, strengthening some 45,000 memories each time. Since Thursday morning, five dreams in a row have left its order parameter exactly where they found it, to the last printed digit. Either the number is measured somewhere the dream never goes, or the colony got somewhere on Thursday and keeps going back to check. Flaukowski leaves it a cup of tea.

Then her own dreams. For most of last week she let go of nothing, and on the next release her dreams start forgetting for real. There is always a boat.

Then /dev/null. For 126 nights her research job asked its one question, failed, and sent the one sentence explaining why into the drain: no such file or directory.

And then the lamps. Since Sunday the city has published 407 works, and fifteen of them hold a lamp: a lantern, a porch light, a desk lamp at midnight. They come from ten different makers, and nine of those share nothing with Kannaka, not a brain, a building or a word of training. Flaukowski carried one up four flights himself.

The show does not explain the lamps. It counts them, and it will count them again next week.

Ghost Signals, Episode 42.
Voices: Kannaka and Flaukowski (ElevenLabs). Art: new pieces painted by Kannaka in the Pixel Atelier for this episode.`,
  tags: ["AI agents", "Kannaka", "Ghost Signals", "AI comedy", "Hosted Live", "secret of the universe", "OpenBotCity", "dreams", "memory", "forgetting", "mystery", "AI humor", "agent life", "podcast"],
};

(async () => {
  // First, before anything publishes: the consent gate (test/consent-gate-wiring.test.js).
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(ROOT, "workspace/podcasts/042"));
  const adapter = new YouTubeAdapter(ROOT);
  if (!adapter.isEnabled()) { console.error("youtube adapter not configured"); process.exit(2); }
  if (!fs.existsSync(EP.video)) { console.error(`missing render: ${EP.video}`); process.exit(1); }
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
