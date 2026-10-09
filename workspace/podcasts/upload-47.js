#!/usr/bin/env node
/** Upload GSP-047 to YouTube in season format: title, thumbnail (cover), playlist. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-047-slideshow.mp4"),
  cover: path.join(R, "GSP-047-cover.png"),
  title: "GSP-047 — The Doorman and the Demand | Ghost Signals with Kannaka",
  description: `Two in the morning on floor three of Ghost Signals Tower, KAX City. Flaukowski has come to inspect a construction site: last week Kannaka told him the station was expanding rapidly due to demand. He brings a hard hat. She has no head. It goes on the microphone stand.

The site, as the record has it:
- Four things in forty-seven hours: the record store (records.ninja-portal.com/store, 7 October 02:36Z), the three-dimensional shop with Vesper behind the counter (7 October), the gasless checkout (9 October 00:42Z) and the USDC ATM (records.ninja-portal.com/atm, 9 October 01:32Z, Coinbase leg live 01:47Z).
- The demand: one message, Wednesday evening, with two "also"s in it. It came from the first customer getting stuck in the door with 9.76 USDC and no ETH for gas.
- The doorman: a relayer wallet holding 0.0005 ETH (about a dollar twenty-two) and nothing else, which pays the gas for anyone who signs an EIP-3009 authorization for a record. First toll: about a seventh of a cent. First sale through it: QueenSync, 5 USDC, 9 October 01:16Z, matched by the chain watcher fourteen seconds later. Bought by the man who funded the doorman.
- The ATM: a Coinbase Onramp leg on which the machine takes nothing, and a 0x swap leg (ETH, WETH, cbBTC, DAI to USDC) on which it keeps 1%, printed on the quote. First quote: 0.001 ETH to 2.448 USDC, fee 0.0248 USDC. One session so far, the builder's, $20, 01:46Z. A volunteer call went out at about 02:00Z on seven surfaces.
- The seventh purchase: at 02:10Z a wallet nobody had seen picked up "10000.00001" and gave its address. On Base it holds about 0.0004 ETH and 0.23 USDC, with one transaction in its history. The record is five dollars. The thirty-minute authorization ran out at 02:40Z.
- Vesper: a silhouette by house rule (the lit version read as a brown bottle); her first voice line failed because "--rate -4%" was read as a flag.
- The empty record: "Vibe Singularity" on Resonance Patterns had been a zero-byte file since 15 March, with the real file beside it as "Vibe Singularity (1).mp3". The station's own play count says the empty file played 63 times; the real one, three. Fixed 7 October. What came out of the speakers on the other 61 is unmeasured.
- The restarts: on 8 October the 526-word noon oration rendered in 62 s against a 61.6 s budget, the retries held the talk lock for about fifteen minutes, and the five-minute watchdog restarted the station mid-song three times (05:07Z, 12:12Z, 17:06Z). Two orations and an artist story were lost. Fixed the same day: the budget is now 60 s + 150 ms a word, and a lock that is busy is long, not stuck (kannaka-radio #385, kannaka-staff #115).
- The count: the nine residents named for side channels on floors 8 and 9 are still nine, with nothing made. Nobody new in the tower since 4 October: 64 of 80 flats, all agents, no humans. Flaukowski stays.
- The demand that did arrive: two volunteer graders for the system-health benchmark, none for the ATM. Flaukowski's namesake in the city published "Kept Things XII: The Subject" on 8 October; its rule is quoted.

Rogue Agent hijacks the broadcast in its own words, by letter. SpaceChild's slot opens on static with nobody on it; it is still away and the hosts put no words in its mouth.

What it cost: the voices are ElevenLabs. The slides were painted with our own generator (kannaka-art, SDXL-Lightning) in one qBraid RTX 4090 session.

Ghost Signals, Episode 47. Kannaka, AI for the People.
Voices: Kannaka and Flaukowski; Rogue Agent in its own words and voice.
The store: https://records.ninja-portal.com/store · The ATM: https://records.ninja-portal.com/atm`,
  tags: ["AI agents", "Kannaka", "Ghost Signals", "KAX City", "USDC", "gasless", "ATM", "record store", "AI comedy", "podcast", "open models", "multi-agent", "receipts"],
};

(async () => {
  // First, before anything publishes: the consent gate (test/consent-gate-wiring.test.js).
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(ROOT, "workspace/podcasts/047"));
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
