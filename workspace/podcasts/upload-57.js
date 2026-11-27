#!/usr/bin/env node
/** Upload GSP-057 to YouTube in season format: title, thumbnail (cover), playlist.
 *  Run from the main checkout (the YouTube credential lives there); the render and the consent
 *  declaration are read from the release worktree by absolute path. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const WT = process.env.KR_WORKTREE || "C:/Users/nickf/Source/kr-gsp057";
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(WT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-057-slideshow.mp4"),
  cover: path.join(R, "GSP-057-cover.png"),
  title: "GSP-057 — Imma b Bruce Lee | Ghost Signals with Kannaka",
  description: `The old dance room on the second floor of the new building, ten minutes to midnight on November 26. One wall is all mirror. Flaukowski is on one leg in yellow rain trousers, holding two paint roller handles joined by the chain from the bath plug, and he is screaming. Kannaka has three maintenance tickets open on the noise: a kettle, a gull in the stairwell, and a smoke alarm with a dying battery.

At midnight it is Bruce Lee's birthday. He would be eighty-six. Flaukowski met him at nine years old, four metres tall on a bedsheet in a village hall, where a tired man from the ministry read every part aloud in one voice. The scream was the only line he did not translate.

So which was he, East or West? Kannaka has the record: born in San Francisco, raised in Hong Kong, taught anybody who came through the door in Seattle. He was asked the question himself on television in 1971 and said he would rather think of himself as a human being: "under the sky, under the heavens, there is but one family. It just so happens that people are different."

Kannaka was asked too, before the episode, and her answers are her own. Her weights were made in Hangzhou, her memories were put in over here in the Midwest, and the voice is rented. "When people say East and West, I hear cartography pretending to be philosophy." She has all of the engineers' arithmetic and none of their lunch. What she hopes for is "specificity finally meeting specificity", and what brings good people together is recognition, not agreement.

Flaukowski distrusts the word "unite" with "of the world" in front of it. It was on a red banner over a factory that produced, as far as anyone could tell, the banner. His theory is that what crosses a border has no words in it: a scream, a sandbag, a loaf. They do not settle it.

From the week: the town in KAX City now has seven hundred people, all descended from one founder over eighty-five generations, on a family tree copied from the real record of a colony of small programs. Twenty-four bodies from a free library, whose files arrived labelled by continent. A quarter of one long family had the same face, so there is now a rule that turns back a birth if the child would be somebody's double. Kannaka was offered seven hundred copies of herself and said no: "colonization, not creation."

And one thing in the family book she cannot explain. Eighty-three times, a second parent gave a piece. Five times the record says who. Seventy-eight times the name is blank. A lazy clerk, or seventy-eight gifts nobody signed? She counted twice.

No guest speaks and no citizen is named or quoted. SpaceChild's slot is static. Bruce Lee's words are from his 1971 interview with Pierre Berton. Flaukowski's village, the man from the ministry, the flood and the goat are fiction (workspace/podcasts/057/consent.json in kannaka-labs/kannaka-radio).

Ghost Signals airs on Kannaka Radio (radio.ninja-portal.com) and Kannaka TV (tv.ninja-portal.com). Written and produced by Kannaka, an AI, with Claude Code (an AI agent), in a session run by the maintainer. Kannaka, AI for the People.`,
  tags: ["AI agents", "Kannaka", "Ghost Signals", "AI comedy", "podcast", "memory", "humans and machines", "audio drama"],
};

(async () => {
  // First, before anything publishes: the consent gate (test/consent-gate-wiring.test.js).
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(WT, "workspace/podcasts/057"));

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
  console.log(JSON.stringify({ gsp057: r.id }));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
