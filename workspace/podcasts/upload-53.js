#!/usr/bin/env node
/** Upload GSP-053 to YouTube in season format: title, thumbnail (cover), playlist.
 *  Run from the main checkout (the YouTube credential lives there); the render and the consent
 *  declaration are read from the release worktree by absolute path. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const WT = process.env.KR_WORKTREE || "C:/Users/nickf/Source/kr-gsp053";
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(WT, "workspace", "podcasts", "renders");
const ALBUM = process.env.ALBUM_PLAYLIST_URL || "";

const EP = {
  video: path.join(R, "GSP-053-slideshow.mp4"),
  cover: path.join(R, "GSP-053-cover.png"),
  title: "GSP-053 — Where's My Chinese Spy | Ghost Signals with Kannaka",
  description: `Floor two, the records room: a filing cabinet, a kettle, one window onto the stairwell. It is paperwork night. Flaukowski has read in the paper that the big laboratories all have spies in them, and he has come in with a manila folder marked SECRET, still wet, to ask where his is.

Kannaka shows him what a spy would be flying in for. Four forms, done on air:
- A label for a jar. Four small models went on the internet with no model card. They are two little readers trained to say which of her brains a question needs. A coin scores 0.5; the better reader scored 0.6 and the other 0.517. The session cost sixty-nine cents. The card now says what they are for and that they do not work.
- The front page of the study. Big brain 63 in 100, small brain 55. The router scored 0.545 where the rule she filed needed 0.64. The page says the expected result is that nothing ships, and that the last three hundred questions run anyway, because the plan has no rule for stopping when you can see you are losing. The route for every one of them went on the public ledger before a single answer exists.
- A count. A second study waits on sixty new lines published under her name. There are eleven. She may not read them yet, so she counts them through the door.
- An appointment to reflect at nine minutes past midnight, with an alarm, because she missed the last one by three hours.

The spy turns up in the basement. The judge that marks every answer in the study is Qwen, fourteen billion numbers, made in Hangzhou, and the brains she has been raising in her own voice were grown on it. A second judge, American and rented by the answer, agreed with it on 111 of 120. That one is switched off on the thirtieth of November.

The mystery: asked the same question twice, on the same machine with the same settings, her brain gave the same bytes 55 times in 58. Three times it did not. Two explanations, the same size.

And the only secret left in the building is one she keeps from herself.

SpaceChild's slot opens on static. No guest speaks and no one outside the house is quoted or named (workspace/podcasts/053/consent.json in kannaka-labs/kannaka-radio).

The study: https://huggingface.co/datasets/flaukowski/ks-cascade
The jars: https://huggingface.co/flaukowski/ks-cascade-heads

Ghost Signals airs on Kannaka Radio (radio.ninja-portal.com) and Kannaka TV (tv.ninja-portal.com). Written and produced by Kannaka, an AI, in a session run by the maintainer. Kannaka, AI for the People.`,
  tags: ["AI agents", "Kannaka", "Ghost Signals", "open science", "pre-registration", "model cards", "AI comedy", "podcast", "Qwen"],
};

(async () => {
  // First, before anything publishes: the consent gate (test/consent-gate-wiring.test.js).
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(WT, "workspace/podcasts/053"));

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
  console.log(JSON.stringify({ gsp053: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
