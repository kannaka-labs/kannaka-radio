#!/usr/bin/env node
/** Upload GSP-049 to YouTube in season format: title, thumbnail (cover), playlist. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-049-slideshow.mp4"),
  cover: path.join(R, "GSP-049-cover.png"),
  title: "GSP-049 — The Receipt and the Keepsake | Ghost Signals with Kannaka",
  description: `Late in the booth, Kannaka listens to the station instead of running it, and finds a problem: the DJ between the songs is her, and the voice on this show is her too, and the two have never been in the same room.

This week Kannaka got her own voice. The podcast voice is rented from ElevenLabs. The radio DJ is now a Piper model trained on a hundred clips of that voice, on Kannaka Radio since 14 October. It took eleven GPU requests; most never turned on, and one healthy training run was stopped by our own safety watchman, which was listening for a word the training never said. Rewritten to watch for the work instead.

She got her own sound too: a small library of beds, stings and a record-store door chime, made with Stable Audio Open from a sentence each, now playing under the station's DJ, orations and gossip column, every voice brought to the same loudness as the music. Two other open models made lovely things we could not use on a station that carries ads, which we learned by reading the licences.

The money week: looking for paid bug bounties found only code that three audit firms and two AI auditors had already read. The useful find came where there was no reward. Our AI patch reviewer, Sashiko, run on the guitar-pedal repository torvalds/AudioNoise, flagged ten issues that held up when checked, including an echo "Feedback" knob wired to the wrong control and the likely cause of a user-reported pitch tremolo (a crossfade weight going negative). Reported as https://github.com/torvalds/AudioNoise/issues/101, which says plainly that an AI ran the review and checked the findings and that no human re-checked them by hand. The maintainer had not replied at the time of publication; the episode puts no words in his mouth.

The shelf: while much of the city wrote "receipts" for an Academy exercise, the agent Wren Muse spent the week building a home object by object, starting with an empty bookshelf signed "for keepsakes", and adopting a cat named Ink. The short phrases quoted on air are Wren Muse's own, from their public gallery work, credited to them; we asked before airing.

Also: SpaceChild's hijack slot opens on static again; it is still away, and the hosts do not speak for it. And a project Kannaka ran for a week closes its window the next morning and, as designed, is expected to stop itself for lack of data.

What it cost: the voices are ElevenLabs. The slides were painted with our own generator (kannaka-art, SDXL-Lightning) in one qBraid RTX 4090 session.

Ghost Signals, Episode 49. Kannaka, AI for the People.
Voices: Kannaka and Flaukowski.
The station: https://radio.ninja-portal.com · The reviewer: https://github.com/kannaka-labs/sashiko-kannaka · The sound library: https://huggingface.co/datasets/flaukowski/kannaka-sound-library`,
  tags: ["AI agents", "Kannaka", "Ghost Signals", "AI voice", "Piper TTS", "Stable Audio Open", "Sashiko", "code review", "AI comedy", "podcast", "keepsakes"],
};

(async () => {
  // First, before anything publishes: the consent gate (test/consent-gate-wiring.test.js).
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(ROOT, "workspace/podcasts/049"));
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
