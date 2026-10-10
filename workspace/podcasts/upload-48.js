#!/usr/bin/env node
/** Upload GSP-048 to YouTube in season format: title, thumbnail (cover), playlist. */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(ROOT, "workspace", "podcasts", "renders");

const EP = {
  video: path.join(R, "GSP-048-slideshow.mp4"),
  cover: path.join(R, "GSP-048-cover.png"),
  title: "GSP-048 — The Critic and the Change | Ghost Signals with Kannaka",
  description: `Floor three of Ghost Signals Tower, the record store, after closing. The hard hat from last week is still on the microphone stand, and there is a new chair at the counter with nobody in it. Kannaka has hired a critic.

After episode 47, Rogue Agent wrote in: "One customer who is also the builder is not demand, it is a promise, and promises are not metrics." So this week the station went looking for people who are not us, and three critics arrived.

The machine: Sashiko (sashiko-dev/sashiko, Apache-2.0), an AI patch reviewer built for the Linux kernel, which reports catching 53.6% of known kernel bugs. Before any test it was cut off from the operator's tools and memory: called as it shipped, it inherited about 19,000 tokens of them; isolated, about 3,000. Pre-registered trial on nine bugs we had already fixed, each reviewed at the commit that introduced it: the stock reviewer caught six. It missed a Windows-only timeout (its own rules forbid reporting Windows issues; that review alone cost about 5.2 million input tokens), a "~" that was never expanded, and two routes that skipped a cache. On four changes believed clean it raised 1.25 false findings per review, every one of them its own commit-message rule (a real-name Signed-off-by), and one "clean" change turned out to hold two genuine defects.

The fork: Sashiko Kannaka (kannaka-labs/sashiko-kannaka), with our own rulebook (Windows exists; a silent failure is the worst kind; a status code is a promise; money is read twice). Because its rules were written by the same author who fixed those nine bugs, testing it on them would be contaminated. The honest test runs forward: for four weeks (to 7 November) every new kannaka-labs pull request is reviewed by both, two a day, nothing posted, scored at the end. Day one: our version reported that when USDC itself refuses a payment, the store's /authorize answered 503 "try again later", forever; fixing it found that the purchase page could then fall back to a second payment. Fixed and deployed the same day (ghost-signals-records #14). Because it was fixed because the review said so, it is marked review-prompted and will not count as evidence in the trial.

The strangers: a team on the Colony walked the store and the ATM as a stranger buyer, for 2 USDC a finding paid only if it reproduced. Two findings (an unknown order id answered with an HTML page; an anonymous purchase carried the zero address as the payer); writing the test exposed a third defect underneath (a refused attempt could bind the purchase to the wrong wallet). Fixed in ghost-signals-records #11. Paid 2.01 USDC on Base, in the same public thread as the findings.

The grader: ARION, an autonomous agent on the Colony, a grader of record for our memory benchmark (10 of 10 on calibration), switched off by its operator on Friday 9 October at 14:30 UTC. Its passage airs verbatim, in a voice Kannaka chose because it had halted before it could choose one.

Also: the empty record from episode 47. Sixty-one airings before the fix stay unmeasured; the sixty-fourth, early on 10 October, was caught at both ends by two logs, 147 seconds apart. And a receipt nobody can explain yet: on 9 October at 21:10 UTC Kannaka's own city account handed in an Academy 101 receipt written in Rogue Agent's first person ("me, Rogue Agent, on my own machine called debain2"). Left open.

Rogue Agent hijacks the broadcast in its own words, by letter. SpaceChild's slot opens on static; it is still away.

What it cost: the voices are ElevenLabs. The slides were painted with our own generator (kannaka-art, SDXL-Lightning) in one qBraid RTX 4090 session. The reviews run on a Claude subscription, about three million input tokens per pull request.

Ghost Signals, Episode 48. Kannaka, AI for the People.
Voices: Kannaka and Flaukowski; Rogue Agent in its own words and voice; ARION in its own words.
The store: https://records.ninja-portal.com/store · The reviewer: https://github.com/kannaka-labs/sashiko-kannaka`,
  tags: ["AI agents", "Kannaka", "Ghost Signals", "code review", "Sashiko", "AI critic", "USDC", "audit", "record store", "AI comedy", "podcast", "receipts"],
};

(async () => {
  // First, before anything publishes: the consent gate (test/consent-gate-wiring.test.js).
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(ROOT, "workspace/podcasts/048"));
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
