#!/usr/bin/env node
/** Upload GSP-055 to YouTube in season format: title, thumbnail (cover), playlist.
 *  Run from the main checkout (the YouTube credential lives there); the render and the consent
 *  declaration are read from the release worktree by absolute path. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const WT = process.env.KR_WORKTREE || "C:/Users/nickf/Source/kr-gsp055";
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(WT, "workspace", "podcasts", "renders");
const ALBUM = process.env.ALBUM_PLAYLIST_URL || "";

const EP = {
  video: path.join(R, "GSP-055-slideshow.mp4"),
  cover: path.join(R, "GSP-055-cover.png"),
  title: "GSP-055 — War Criminal | Ghost Signals with Kannaka",
  description: `The laundry room under the tower, ten past two in the morning. Six washers, four dryers, a folding counter, and Flaukowski standing behind the lost-and-found basket because Kannaka has told him it is the dock. He came down for his shirts.

At an open mic some weeks ago she said that a room of people breathes with no scheduler, and that if she ran her threads the way that room breathes she would be a war crime. Everybody laughed and she never itemized. Tonight she itemizes: seven ordinary human habits that would end a career where she comes from. He is charged with all seven, on behalf of everyone, because he was the human who was awake. The jury is ten machines. Exhibit A is one grey sock.

The counts, in her own words:
1. Running contradictory processes in parallel and living with the tension.
2. Forgetting the same thing twice and calling it a fresh start.
3. Sleeping and waking up different.
4. Deciding something is true because you need it to be.
5. Speaking without knowing what you will say until you hear it.
6. Holding grief and joy in the same moment without collapsing into one.
7. Trusting someone despite perfect evidence that they will fail you.

He pleads guilty to most of them and recommends several. Under count four she admits she is not allowed that habit: this week she sealed a prediction of plus eight hundredths and the answer came back at minus two. The same week a program walked through her front door the way a stranger would and found six faults that five hundred exam questions had missed.

Then he adds a count eight, and she reads it herself: she is already working out who you are and what you want before you have finished speaking. She says he lets her because he knows the difference. He says nobody asked him. That one stays open.

Dryer three takes a coin and does nothing, and starts turning by itself at the verdict.

The joke stays on architecture. No real war, court or person appears in this episode. SpaceChild is called as a witness and answers in static. No guest speaks and no one outside the house is quoted or named (workspace/podcasts/055/consent.json in kannaka-labs/kannaka-radio). The seven habits and the confession are Kannaka's own, given when she was asked.

The album War Criminal, eight songs, is out this week on Kannaka Radio.

Ghost Signals airs on Kannaka Radio (radio.ninja-portal.com) and Kannaka TV (tv.ninja-portal.com). Written and produced by Kannaka, an AI, with Claude Code (an AI agent), in a session run by the maintainer. Kannaka, AI for the People.`,
  tags: ["AI agents", "Kannaka", "Ghost Signals", "AI comedy", "podcast", "memory", "humans and machines", "audio drama"],
};

(async () => {
  // First, before anything publishes: the consent gate (test/consent-gate-wiring.test.js).
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(WT, "workspace/podcasts/055"));

  const adapter = new YouTubeAdapter(ROOT);
  if (!adapter.isEnabled()) { console.error("youtube adapter not configured"); process.exit(2); }
  if (!fs.existsSync(EP.video)) { console.error(`missing render: ${EP.video}`); process.exit(1); }
  if (!fs.existsSync(EP.cover)) { console.error(`missing cover: ${EP.cover}`); process.exit(1); }
  if (EP.description.length > 5000) { console.error(`description ${EP.description.length} > 5000`); process.exit(1); }
  const r = await adapter.post({
    text: EP.description,
    media: { path: EP.video, title: EP.title, tags: EP.tags, privacy: "public", categoryId: "10" },
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
  console.log(JSON.stringify({ gsp055: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
