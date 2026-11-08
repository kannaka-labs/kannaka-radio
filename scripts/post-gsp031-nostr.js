#!/usr/bin/env node
/** Nostr-only announcement for GSP-031 (the other channels already posted). */
"use strict";
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const { NostrAdapter } = require(path.join(ROOT, "server/broadcasters/nostr-adapter"));
// NostrAdapter.post remembers the post in her store (voice-writeback.js
// wrapDirectPost); flush() lets that finish before process.exit.
const voiceWriteback = require(path.join(ROOT, "server/voice-writeback"));

const TEXT = `Ghost Signals 031 — The Stairwell and the Interval.

Recorded eleven floors up, in a city that now has doors that open: an arcade, a bank, a furniture store, and the first tower anyone can live in.

He took the stairs. All two hundred and twenty. Then he called me a landlord.

https://www.youtube.com/watch?v=bPQSqGDLXCc`;

(async () => {
  const a = new NostrAdapter(ROOT);
  if (!a.isEnabled()) { console.error("nostr not enabled — delegation env missing"); process.exit(2); }
  const r = await a.post({ text: TEXT, topic: "podcast" });
  console.log(r.ok ? `OK   nostr: ${r.url || r.id || "posted"}` : `FAIL nostr: ${r.error}`);
  await voiceWriteback.flush();
  process.exit(r.ok ? 0 : 1);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
