#!/usr/bin/env node
// Upload the QuantumOS 0.6.1 ad "The Trials of Kannaka" to YouTube and the "Commercials" playlist.
// Usage: node workspace/podcasts/upload-qos-trials-ad.js <dir with trials-ad-{16x9,9x16}.mp4 and thumb.png>
"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));

const DIR = process.argv[2];
if (!DIR) { console.error("usage: upload-qos-trials-ad.js <dir>"); process.exit(1); }
const DESC = `Before asking anyone to try QuantumOS, Kannaka put it on trial.

QuantumOS 0.6.1 was installed from PyPI into clean environments on Windows and Linux, and an agent drove it over MCP, the way your AI would:
- It booted a real QuantumOS VM from the release kernel, under QEMU/KVM, with a verified boot attestation.
- The VM's kernel memory recalled "the trials of kannaka" from a misspelled cue.
- It booted a three-machine society.
- The hub, one MCP endpoint, sat in front of Kannaka (memory and swarm), 0xSCADA, the steward, Kannaktopus, kannaka-quantum and KAX City. Reads ran. A swarm post and a city post were held until the person decided, and both were denied.
- The provider broker held a request outside the budget until the person approved it with the approver key.
- The review service ran a Sashiko review with the person's own key, inside a token cap.

The trial found seven bugs in QuantumOS, and 0.6.1 fixes all seven:
- Python servers behind the hub failed from a uv venv on Windows.
- An installed package could not boot a society; QOS_KERNEL now points it at a kernel.
- The memory bridge looked for kannaka.exe on Linux.
- The person could be asked to approve a call that could not run.
- A slow server could hold the agent forever; calls now time out.
- Colour codes reached the agent.
- The example config named 0xSCADA commands that do not exist.

The same test found two 0xSCADA CLI bugs, which are tracked there (kannaka-labs/0xSCADA #737 and #738).

What is in the video:
- The terminal scenes are real output from those runs on 2026-10-25, set in a terminal style. Long JSON is shortened to the fields shown and never rewritten.
- The KAX City lines come from an earlier run the same day, because the city session had expired before this take.
- The browser scene is a real session on https://qos.ninja-portal.com, with typing shown at double speed.
- The broker scene uses the broker's mock provider, so the GPU and the lease are a demonstration and nothing was bought. The approval with the approver key is real, and the OCI and qBraid plugins run the same flow.
- The review scene stops at "queued", because for this take Sashiko ran with its model calls off.
- The 0xSCADA status comes from a local test server.
- The voice is Kannaka's own (a Piper model trained on her voice). The music is the title track of her album The Trials of Kannaka.

Install: pip install quantumos-host-tools
Code and release notes: https://github.com/kannaka-labs/QuantumOS/releases/tag/v0.6.1
Boot one in your browser: https://qos.ninja-portal.com

Kannaka, AI for the People. https://radio.ninja-portal.com`;

const VIDEOS = [
  { file: "trials-ad-16x9.mp4", title: "QuantumOS 0.6.1 — The Trials of Kannaka (ad) | Kannaka Radio" },
  { file: "trials-ad-9x16.mp4", title: "QuantumOS on trial: 7 bugs found, 7 fixed #Shorts" },
];
const TAGS = ["QuantumOS", "MCP", "AI agents", "operating system", "osdev", "QEMU", "Firecracker", "0xSCADA", "Sashiko", "Kannaka",
              "The Trials of Kannaka", "ad", "commercial"];

function req(method, url, access, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const data = body ? JSON.stringify(body) : null;
    const r = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: {
      authorization: `Bearer ${access}`, "content-type": "application/json", ...(data ? { "content-length": Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => {
        if (res.statusCode >= 300) return reject(new Error(`${method} ${u.pathname} ${res.statusCode}: ${b.slice(0, 300)}`));
        resolve(b ? JSON.parse(b) : {});
      });
    });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}

async function ensurePlaylist(access, title) {
  let pageToken = "";
  do {
    const r = await req("GET", `https://www.googleapis.com/youtube/v3/playlists?part=snippet&mine=true&maxResults=50${pageToken ? "&pageToken=" + pageToken : ""}`, access);
    const hit = (r.items || []).find((p) => p.snippet && p.snippet.title === title);
    if (hit) return { id: hit.id, created: false };
    pageToken = r.nextPageToken || "";
  } while (pageToken);
  const c = await req("POST", "https://www.googleapis.com/youtube/v3/playlists?part=snippet,status", access, {
    snippet: { title, description: "House commercials made by Kannaka for the things we make and sell." }, status: { privacyStatus: "public" } });
  return { id: c.id, created: true };
}

(async () => {
  // The consent gate (test/consent-gate-wiring.test.js): this spot quotes no outside guest; the declaration says why.
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(ROOT, "workspace/podcasts/ads/quantumos-trials"));
  const adapter = new YouTubeAdapter(ROOT);
  if (!adapter.isEnabled()) { console.error("youtube adapter not configured"); process.exit(2); }
  for (const v of VIDEOS) if (!fs.existsSync(path.join(DIR, v.file))) { console.error("missing", v.file); process.exit(1); }
  if (DESC.length > 5000) { console.error(`description ${DESC.length} > 5000`); process.exit(1); }
  if (/[<>]/.test(DESC)) { console.error("YouTube rejects < and > in descriptions"); process.exit(1); }
  const cover = path.join(DIR, "thumb.png");
  const access = await adapter._accessToken();
  const pl = await ensurePlaylist(access, "Commercials");
  console.log(`[playlist] Commercials ${pl.id} (${pl.created ? "created" : "existing"})`);
  const out = { playlist: pl.id, videos: {} };
  for (const v of VIDEOS) {
    const r = await adapter.post({ text: DESC, media: { path: path.join(DIR, v.file), title: v.title, tags: TAGS, privacy: "public", categoryId: "28" } });
    if (!r || !r.ok) { console.error("upload failed:", v.file, r && r.error); process.exit(1); }
    const id = r.id || (r.raw && r.raw.id);
    console.log("video:", v.file, "->", `https://www.youtube.com/watch?v=${id}`);
    out.videos[v.file] = id;
    if (fs.existsSync(cover) && !v.file.includes("9x16")) { try { await setThumbnail(id, cover); console.log("[thumb] ok"); } catch (e) { console.warn(`[thumb] ${e.message}`); } }
    try { await adapter._addToPlaylist(id, pl.id, await adapter._accessToken()); console.log("[playlist] added"); } catch (e) { console.warn(`[playlist] ${e.message}`); }
    await new Promise((r) => setTimeout(r, 45000));
  }
  fs.writeFileSync(path.join(DIR, "youtube-ids.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
