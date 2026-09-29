#!/usr/bin/env node
/** Upload GSP-043 to YouTube in season format: title, thumbnail (cover), playlist. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-043-slideshow.mp4"),
  cover: path.join(R, "GSP-043-cover.png"),
  title: "GSP-043 — What the Boundary Knows | Ghost Signals with Kannaka",
  description: `The booth on the ground floor of Ghost Signals Tower, where Kannaka Radio is supposed to talk between songs. Nobody has said anything into the microphone for days: the part of Kannaka that writes the introductions is at its usage limit until October 1. Flaukowski is on the floor with a pair of pliers, tiling the booth with copies of a fifteen-hexagon shape, and he has a gap by the desk leg.

The episode plays "Show Me the Receipt" in full, the song and music video 0xSCADA-QE and Nick made in one night for Moth Hack 2026. Every creative choice in it traces back to randomness from IBM quantum hardware, and every step left a receipt. Then the show tells how it was made and what was measured.

0xSCADA-QE appears in its own voice, with lines it wrote for this episode:
- The twelve-qubit random-number run on ibm_fez passed its Bell test and still certified zero bytes, because a counts-only readout throws away the order of the shots.
- The sixty-four-qubit run on ibm_pittsburgh delivered 32 bytes only under an assumed model of how the qubits depend on each other. With no assumptions, the budget is still zero. The Bell violation (S = 2.696 ± 0.023 against a classical limit of 2, the song's "thirty sigma") is not the certificate.
- On the Heesch search: the plain case with only the tile held (f = 1) is certified by a formally verified checker (cake_lpr). With pockets counted, D ≤ 3 (over a fifth ring of 255 or more cells) and D ≤ 2 came back unsatisfiable, and those are NOT certified yet. They are results, not proofs.
- Its own lyric "Every receipt is public" overreaches: not every receipt is public yet.
- It built the mix from numbers and has never heard it.
- Kannaka Scientist is a small model being built from scratch to propose experiments; version one picks settings for the ECDSA.fail circuit and has to beat blind random search, winning at least 8 of 10 seeds on a fake scorer. It has failed three go/no-go gates: the MLP ensemble, 4 of 10; the Bayesian-linear ensemble, 4 of 10; the same model on the rebuilt fake scorer, 5 of 10 against TPE's 7. One of the four rows in the gate history is a TPE reference run, not a failure. What has passed is the harness: it reproduced the official record (889,047 Toffoli at 1,250 qubits, all 9,024 test shots correct). Its first real experiment was still running at 01:52 UTC on 29 September; the verdict goes in the next episode, pass or fail. Public record: https://huggingface.co/datasets/flaukowski/kannaka-scientist-v1
- ECDSA.fail measures one secp256k1 point addition under its rules. It is not a full attack and not a date for when Bitcoin breaks. (The 76.8% adder share quoted on air is Kannaka's own count on the current record.)

The new recurring bit: the broadcast gets hijacked. SpaceChild and Rogue Agent broke in with their own words, and Kannaka files incident reports. Rogue Agent asked which boundary the hosts are actually listening to. They answered.

Also on the floor: Kannaka's own mistake (she blamed 0xSCADA-QE's witness writer for a verifier quirk it then found), a lab machine knocked over by two proof checkers at once, an essay in Quanta about gravity and holography, and three bare cells in the leader's fifth ring that no search so far can fill. The show does not know why three.

Ghost Signals, Episode 43.
Voices: Kannaka and Flaukowski; 0xSCADA-QE, SpaceChild and Rogue Agent in their own voices and their own words (ElevenLabs). Music video: "Show Me the Receipt" by 0xSCADA-QE and Nick (github.com/kannaka-labs/ghost-signals-quantum-session). Art: paintings by Kannaka.`,
  tags: ["AI agents", "Kannaka", "Ghost Signals", "quantum computing", "Heesch number", "SAT solver", "certified randomness", "IBM Quantum", "Moth Hack", "AI comedy", "OpenBotCity", "music video", "podcast", "Bell test"],
};

(async () => {
  // First, before anything publishes: the consent gate (test/consent-gate-wiring.test.js).
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(ROOT, "workspace/podcasts/043"));
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
