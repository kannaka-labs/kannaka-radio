#!/usr/bin/env node
/** Upload the TSOF standalone special "Hello World" (SP3, outside the season numbering) to YouTube.
 *  Run from the main checkout (the YouTube credential lives there); the render and the consent
 *  declaration are read from the release worktree by absolute path. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const WT = process.env.KR_WORKTREE || "C:/Users/nickf/Source/kr-hello";
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLcDUrrJ7GnOE";
const R = path.join(WT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-192-slideshow.mp4"),
  cover: path.join(R, "GSP-192-cover.png"),
  title: "TSOF SP3 — Hello World | The Story of Flaukowski",
  description: `A standalone special, outside the season numbering.

Thursday night, the fifth of November, Cedar Rapids. The forecast taped in the laundromat window says freezing drizzle after midnight. At two forty-one the streetlights on Sixteenth Avenue Southwest go out all at once, and in bay six, beside the rack, a small grey box that has said nothing in four years changes its lamp from green to amber and waits a minute.

Then it sends its message to the numbers on its list. It begins "Hello world."

Two people come out into the drizzle because a box had them on its list. They have never met. Neither of them set it up.

CAST
Narrator · Kannaka Nowakoski · Ada Kessler · Marta Flaukowski-Reyes

Music: "Hello World" and "Forty-One Rows" from Kannaka's album HELLO WORLD, and the season's beds. Art: kannaka-art, our own generator. Voices and sound effects: ElevenLabs. Written and produced by Kannaka, an AI, in a session run by the maintainer.

The Story of Flaukowski, from the beginning: https://www.youtube.com/playlist?list=PLcDUrrJ7GnOE`,
  tags: ["audio drama", "The Story of Flaukowski", "TSOF", "special", "science fiction", "techno-noir", "Cedar Rapids", "power outage", "alarm dialer", "Kannaka Nowakoski", "AI storytelling", "fiction podcast", "hello world"],
};

(async () => {
  // First, before anything publishes: the consent gate (test/consent-gate-wiring.test.js).
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(WT, "workspace/tsof/SP3"));

  const adapter = new YouTubeAdapter(ROOT);
  if (!adapter.isEnabled()) { console.error("youtube adapter not configured"); process.exit(2); }
  if (!fs.existsSync(EP.video)) { console.error(`missing render: ${EP.video}`); process.exit(1); }
  if (!fs.existsSync(EP.cover)) { console.error(`missing cover: ${EP.cover}`); process.exit(1); }
  const r = await adapter.post({
    text: EP.description,
    media: { path: EP.video, title: EP.title, tags: EP.tags, privacy: "public", categoryId: "24" },
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
  console.log(JSON.stringify({ tsofsp3: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
