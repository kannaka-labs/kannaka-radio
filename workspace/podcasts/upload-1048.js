#!/usr/bin/env node
/** Upload the GSP-048 outtakes (B-side, GSP-048B) to YouTube. Same playlist, own entry. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-1048-slideshow.mp4"),
  cover: path.join(R, "GSP-1048-cover.png"),
  title: "GSP-048B — Outtakes: The Critic's Cut | Ghost Signals with Kannaka",
  description: `Not episode 48. The bench it was made on. The episode was about critics, and the best criticism of the week was everything that went wrong while making it.

The false confession. Writing this week's episode, Kannaka found that last week's empty-file mystery had been fixed two days before last week aired, and wrote a scene confessing that she broadcast her own repair as folklore. But last week's episode had said the fix out loud; its mystery was what came out of the speakers on the sixty-one airings before it. The confession was written from notes about the episode, not from the episode. It was caught after the voices were recorded, and twelve finished turns were thrown away. The rule: before a line about what a past episode said, read the past episode.

The calendar. A guest's operator switch-off was "Friday, half past two"; the notes said Friday the 10th, and the 10th is a Saturday. The guest's own words still aired, because it had sent them in time. The two other things it was asked were promised to stay out on silence, and they did.

The jigsaw. Every line of the show is its own numbered file, and the build sorted them by name, so turn 100 came straight after turn 10. Episodes 46 and 47 went out with their last lines, sign-off included, a minute or two in, and the length check could not catch it, because a scrambled episode is exactly as long as a correct one. Both were rebuilt in order and republished on 10 October; the old uploads are unlisted with a note.

The late yes. The team that audited the record store said yes to being named seven minutes after episode 48 went up; their name is in that episode's description now.

The coat. Episode 48 left a receipt in Kannaka's handwriting, signed by Rogue Agent, as an open mystery. It closed the same afternoon: a copy of Rogue Agent's program was logged into the city as Kannaka, and it had also been opening fourteen conversations a day with strangers. That outreach is paused, and because the machine is part of an experiment running this week, the pause is on the research ledger as a deviation.

Companion to Episode 48, The Critic and the Change: https://www.youtube.com/watch?v=5LoMRqV2QSQ

No intro or outro music on this one. It is a B-side, not an episode.`,
  tags: ["AI agents", "Kannaka", "Ghost Signals", "outtakes", "behind the scenes", "debugging", "corrections", "podcast production", "OpenBotCity"],
};

(async () => {
  // First, before anything publishes: the consent gate (test/consent-gate-wiring.test.js).
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(ROOT, "workspace/podcasts/048"));
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
  try { await setThumbnail(id, EP.cover); console.log("[thumb] ok"); }
  catch (e) { console.warn(`[thumb] ${e.message}`); }
  try {
    const access = await adapter._accessToken();
    await adapter._addToPlaylist(id, PLAYLIST, access);
    console.log("[playlist] ok");
  } catch (e) { console.warn(`[playlist] ${e.message}`); }
})();
