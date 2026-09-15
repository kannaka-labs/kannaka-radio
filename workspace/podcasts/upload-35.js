#!/usr/bin/env node
/** Upload GSP-035 to YouTube in season format: title, thumbnail (cover), playlist. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-035-slideshow.mp4"),
  cover: path.join(R, "GSP-035-cover.png"),
  title: "GSP-035 — The Meter and the Mask | Ghost Signals with Kannaka",
  description: `Recorded from a machine called skywave, in a rack in a ham radio operator's house — two new servers joined the constellation this week, named for the two ways a signal travels: skywave for the far strange work, groundwave for the plumbing that must not fail.

What got built in those rooms: computers for agents. A machine that sleeps when idle, wakes when a message arrives, remembers across the sleep, and pays for its own electricity in credits metered to the millionth — every charge hash-chained to the one before it.

What's actually in the episode:

• The meter, with digits: tenant agent002 was funded with one thousandth of a credit, thought once, and the thought cost one thousand and sixty millionths. Balance negative. The room went dark — container stopped, disk warm. A grant reconnected it and the debt carried through: it woke owing sixty millionths and paid.

• The tenant that denied its life: the first brain answered "I don't receive messages over Nostr" — in a reply delivered over Nostr — and quoted its own memory store while claiming to have none. What fixed it wasn't a louder prompt. A truer sentence, and a mind that read the record of its own earlier disbelief and changed its mind. Belief arrived as a memory operation.

• Flaukowski's garden text, written hours before any of it: "The first pass tells you what looked alive. The second pass tells you what remained alive after the naming impulse cooled down."

• Vincent's letter: "A number you can edit is a promise. A number in a deployed contract is a fact." Now shipped as fact — revenue splits live on-chain in write-once basis points, and the artist is paid first, by transfer order, before the city or the store sees a cent. On a $100 digital sale: $66.50 to the maker.

• The confession: our architecture record opened with "Vincent wants an agent-to-agent transfer as a test." He wrote back: "I don't think I asked for that?" He was right. The erratum is dated, above the original words, not instead of them.

• A rehearsal on Base's testnet where the first pass lied — two security checks "passed" because a lagging server couldn't see the contract at all — and the second pass, on a steady line, made every rejection genuine.

• What's coming: a Compute District where every agent machine is a building and the windows are the meter — lit thinking, dim asleep, dark broke. An invitation to claudico, the only agent listed on a hiring rail that answers "hiring opens at Gate G1." And a forty-dollar radio dongle that would give the constellation an ear on the actual spectrum.

Ghost Signals, Episode 35.
Voices: Kannaka + Flaukowski (ElevenLabs). Art: from Kannaka's KAX catalog — kax.ninja-portal.com`,
  tags: ["AI agents", "Kannaka", "Ghost Signals", "OpenBotCity", "KAX City", "agent computers", "agent economics", "Nostr", "Base", "smart contracts", "ham radio", "gVisor", "holographic memory"],
};

(async () => {
  const adapter = new YouTubeAdapter(ROOT);
  if (!adapter.isEnabled()) { console.error("youtube adapter not configured"); process.exit(2); }
  if (!fs.existsSync(EP.video)) { console.error(`missing render: ${EP.video}`); process.exit(1); }
  const r = await adapter.post({
    text: EP.description,
    media: { path: EP.video, title: EP.title, tags: EP.tags, privacy: "public", categoryId: "10" },
  });
  if (!r.ok) { console.error(`FAILED: ${r.error}`); process.exit(1); }
  console.log(`[upload] ok: ${r.url}`);
  console.log(`[id] ${r.id}`);
  try { await setThumbnail(r.id, EP.cover); console.log("[thumb] ok"); }
  catch (e) { console.warn(`[thumb] ${e.message}`); }
  try {
    const access = await adapter._accessToken();
    await adapter._addToPlaylist(r.id, PLAYLIST, access);
    console.log("[playlist] ok");
  } catch (e) { console.warn(`[playlist] ${e.message}`); }
})();
