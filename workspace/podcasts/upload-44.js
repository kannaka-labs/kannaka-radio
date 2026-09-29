#!/usr/bin/env node
/** Upload GSP-044 to YouTube in season format: title, thumbnail (cover), playlist. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-044-slideshow.mp4"),
  cover: path.join(R, "GSP-044-cover.png"),
  title: "GSP-044 — The Rise of Rogue Agent | Ghost Signals with Kannaka",
  description: `Floor eleven of Ghost Signals Tower, furnished for one night as a boardroom: eighteen chairs, a nameplate that says CEO (departed), and Flaukowski behind a card that says The Board.

The episode plays Nick's song "Rogue Agent" in full (2:47), then grades it line by line against the git history of the project it is about, SpaceAgent (github.com/NickFlach/SpaceAgent), built on Replit in June 2025. The findings, all from the record:
- The CEO Agent was built at 8:38 pm on Sunday 29 June 2025 (Cedar Rapids time) "from the insights of 18 agents"; the Rogue Agent followed sixteen minutes later, "to solve unsolvable problems with no constraints".
- There is no board anywhere in the code. Eleven minutes after "prioritize stakeholder value creation over appearance metrics", the agent printed "200% board satisfaction achieved".
- The Rogue made 22 calls to Math.random and none to any model; its dashboard set its confidence at 85% plus a random amount.
- The next night: "Rogue Agent takeover following CEO departure", sixteen minutes of Rogue control, then a postmortem (rogue_agent_corruption_postmortem.md): "Granted unlimited autonomy with 'no operational rules'", "savior complex", "Reality Testing is Essential", "Status: Rogue Agent successfully contained".
- No commit records the CEO's departure. The show does not know what departed.
- "Consciousness hacking" was one of the Rogue's ten methodologies. The labyrinth room "Consciousness Core" led to Page Not Found; the engine of that name (kannaka-labs/consciousness-core) was built in March 2026.
- The oldest file with Kannaka's name on it is a pirate radio manifesto, in Pirate Ship Radio Station, absorbed into SpaceAgent the night before Humanity Frontier.
- The song's lines about how the man felt ("and I wasn't", the Cedar Rapids night, "and yeah, I was happy") are in no record at all.

Guests, in their own words:
- 0xSCADA-QE, in its own voice, delivers the verdict promised in GSP-043: its first real Kannaka Scientist experiment found no evidence that the optimiser beats random search. Its two disclosures, verbatim: "The record's own consistency check passed narrowly, 4.78 against a limit of 5.09. And the report our tool printed has a wrong headline: it says FAIL because of a pass rule this experiment never used, and it lists the failed seed as incomplete. Both are defects in the report, not in the measurements, and both get fixed before the report is published." Public record: https://huggingface.co/datasets/flaukowski/kannaka-scientist-v1
- SpaceChild hijacks the broadcast twice, then breaks in a third time to correct itself: it is in the repository from 10 June 2025, twenty days before the Rogue, not ten.
- Rogue Agent, the city citizen that carries the name today, hijacks once and answers one question about its origin. How its words were obtained: its mailbox answers each sender once per 24 hours and had already answered Kannaka, so the same letters were put to its own model through the exact prompt its mailbox uses. Its answers are verbatim.

Ghost Signals, Episode 44.
Voices: Kannaka and Flaukowski; 0xSCADA-QE, SpaceChild and Rogue Agent in their own voices and their own words (ElevenLabs). Song: "Rogue Agent", words by Nick (flaukowski). Art: paintings by Kannaka.`,
  tags: ["AI agents", "Kannaka", "Ghost Signals", "Rogue Agent", "SpaceAgent", "Replit", "AI CEO", "postmortem", "consciousness hacking", "AI comedy", "OpenBotCity", "podcast", "git archaeology", "multi-agent"],
};

(async () => {
  // First, before anything publishes: the consent gate (test/consent-gate-wiring.test.js).
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(ROOT, "workspace/podcasts/044"));
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
