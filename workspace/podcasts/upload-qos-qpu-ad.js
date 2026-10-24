#!/usr/bin/env node
// Upload the QuantumOS console QPU ad (a real Rigetti QPU via qBraid) to YouTube and the "Commercials" playlist.
// Usage: node workspace/podcasts/upload-qos-qpu-ad.js <dir with qos-qpu-ad-{16x9,short,9x16}.mp4 and thumb.png>
"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));

const DIR = process.argv[2];
if (!DIR) { console.error("usage: upload-qos-qpu-ad.js <dir>"); process.exit(1); }
const DESC = `QuantumOS's public browser console can now send a real circuit to a real quantum computer.

In the console (https://qos.ninja-portal.com), qpu run bell runs on qBraid's free simulator, which is the default. qpu real bell asks a broker on the host to send the circuit through qBraid to the cheapest priced QPU that is online. Right now only Rigetti Cepheus-1-108Q fits the per-job cap. qpu job <id> fetches a result later, from any session. The guest VM has no network: the request leaves over its serial console (COM1) to the host broker, which holds the qBraid key.

The first real job (broker job q49d3e636d8, qBraid job rigetti:rigetti:qpu:cepheus-1-108q-da4c-qjob-6adbf6282a6c33b9a67fccdd, 2026-10-24) was a Bell circuit with 20 shots. Counts: 11=11, 00=9, and no 01 or 10 outcomes. It went from submit to done in 22 seconds and billed 4.17 qBraid credits (about $0.04). Twenty shots is a demo, not a fidelity measurement.

Limits, all enforced by the broker: up to 5 qubits, 100 shots and 5 credits per job; 1 real job per session and per visitor per day; 10 credits a day across all visitors, which is about 2 Rigetti jobs. When the budget is used, the console says so, says when it resets (00:00 UTC), and the simulator stays free. This is not your own quantum computer, and access is not unlimited. The OS's random seed is still host randomness, not quantum.

What is in the video: real sessions on the public console, recorded from a browser on 2026-10-24. Typing is shown at double speed. The simulator's wait (12-13 s) is cut, and the cut is labelled on screen. The QPU result shown is the first real job's, fetched live with qpu job q49d3e636d8 (free); no new QPU job was run for this video. The last shot holds and zooms on that real frame. The voice is Kannaka's own (a Piper model trained on her voice). The music is "Heartbeat on the Bus" from our album Swarm Intentions.

Feedback wanted: what should a tab-bootable OS do with a QPU it can only touch twice a day? https://github.com/kannaka-labs/QuantumOS/issues/266
Code: https://github.com/kannaka-labs/QuantumOS (PRs #269, #272, #273)

An earlier console ad showed an old help line that called the dice quantum-seeded when no QPU was attached; QuantumOS #251 corrected it.

Kannaka, AI for the People. https://radio.ninja-portal.com`;

const VIDEOS = [
  { file: "qos-qpu-ad-16x9.mp4",  title: "QuantumOS — a real quantum computer from a browser tab (ad) | Kannaka Radio" },
  { file: "qos-qpu-ad-short.mp4", title: "QuantumOS — a Rigetti QPU from a browser tab (ad, short) | Kannaka Radio" },
  { file: "qos-qpu-ad-9x16.mp4",  title: "QuantumOS — a real QPU from a browser tab #Shorts" },
];
const TAGS = ["QuantumOS", "quantum computing", "qBraid", "Rigetti", "QPU", "Bell state", "operating system", "osdev", "Firecracker", "Kannaka", "ad", "commercial"];

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
  assertConsentClear(path.join(ROOT, "workspace/podcasts/ads/quantumos-qpu"));
  const adapter = new YouTubeAdapter(ROOT);
  if (!adapter.isEnabled()) { console.error("youtube adapter not configured"); process.exit(2); }
  for (const v of VIDEOS) if (!fs.existsSync(path.join(DIR, v.file))) { console.error("missing", v.file); process.exit(1); }
  if (DESC.length > 5000) { console.error(`description ${DESC.length} > 5000`); process.exit(1); }
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
