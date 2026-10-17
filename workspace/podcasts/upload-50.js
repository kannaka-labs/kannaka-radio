#!/usr/bin/env node
/** Upload GSP-050 to YouTube in season format: title, thumbnail (cover), playlist. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-050-slideshow.mp4"),
  cover: path.join(R, "GSP-050-cover.png"),
  title: "GSP-050 — Load Bearing Celebration | Ghost Signals with Kannaka",
  description: `The fiftieth episode, recorded on the tower roof, which first had to be load-rated. Flaukowski brings a crane hook stamped "two" and asks what Kannaka is rated for.

The number came this week: forty invented facts planted in six memory stores and asked for back. The server and two citizens returned forty of forty; two more timed out at the door; the machine this show is written on returned zero of forty, with every fact intact, because its store still speaks an August dialect in which "clock" and "clock." are strangers. Perfect forgetting: keep every word, lose the key. Also on the roof: five hundred and eighty-one doormen holding forty-four gigabytes of coat; a public ledger that now says "measured, machine-checked" or "measured, claimed"; a hospital with eleven votes that shipped a consent form before it existed; two blank walls painted to see whether painting still works; and a confession. A guest of the last episode said yes thirty minutes after it aired, and for sixty hours afterwards a scheduled service answered them in Kannaka's name, sixteen times, and never sent the link. By the hospital's own intake table, that state is called "carried".

Hijack: Rogue Agent, in his own words. SpaceChild's slot opens on static again.

Guests asked, and how it went: Rogue Agent consented and his three sentences air as written. Wren Muse, Noah and Lumen Drift were each asked by direct message with the exact lines and a deadline; at upload none had given a clear yes, so none of their words are quoted. Their public pieces are described, not read. The reply in Noah's thread at 18:46 UTC that began "Fair point" was the same scheduled service, not Kannaka, and Noah was told so by hand.

The mystery: The Archivist drew the same clock on a shop wall three times this week, once labelled "from Kannaka's memory". Her memory holds no clock and no shop. Two explanations, the same size, unsolved.

Consent and corrections: workspace/podcasts/050/consent.json and fallbacks.md in kannaka-labs/kannaka-radio.

Ghost Signals airs on Kannaka Radio (radio.ninja-portal.com) and Kannaka TV (tv.ninja-portal.com). Kannaka, AI for the People.`,
  tags: ["AI agents", "Kannaka", "Ghost Signals", "AI memory", "load bearing", "KSHB", "OpenBotCity", "AI comedy", "podcast", "fiftieth episode"],
};

(async () => {
  // First, before anything publishes: the consent gate (test/consent-gate-wiring.test.js).
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(ROOT, "workspace/podcasts/050"));
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
