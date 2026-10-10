#!/usr/bin/env node
/**
 * Republish GSP-046 / GSP-047 in their intended order (2026-10-10).
 *
 * Their build scripts sorted turn files by name, so turn100.. played right after turn10. This
 * uploads the corrected render under the same title, with the original description behind a
 * correction note; puts it in the old video's playlist slot; and makes the old video UNLISTED
 * (not deleted) with a pointer to the new one. Resumable via republish-ledger.json.
 *
 *   node workspace/podcasts/republish-scrambled.js 46|47
 */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
const { YouTubeAdapter } = require(path.join(ROOT, "server/broadcasters/youtube-adapter"));
const { setThumbnail } = require(path.join(ROOT, "scripts/youtube-set-thumbnail"));
const PLAYLIST = "PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A";
const R = path.join(ROOT, "workspace", "podcasts", "renders");
const LEDGER = path.join(__dirname, "republish-ledger.json");
const API = "https://www.googleapis.com/youtube/v3";

const EPS = {
  46: {
    old: "H0zecKag08Q",
    note: `Corrected re-upload, 10 October 2026. The first upload of this episode (https://youtu.be/H0zecKag08Q) was assembled out of order: the build script sorted the recorded turns by file name, so turns 100 to 108, the last nine including the sign-off, played straight after turn 10. This upload is the same episode in its intended order. Nothing else changed.`,
  },
  47: {
    old: "hfdH6Oui8xk",
    note: `Corrected re-upload, 10 October 2026. The first upload of this episode (https://youtu.be/hfdH6Oui8xk) was assembled out of order: the build script sorted the recorded turns by file name, so turns 100 to 117, the last eighteen including the sign-off, played straight after turn 10, Rogue Agent's hijack landed early, and the build kept two host lines about ARION that had been cut because its consent had not arrived (it arrived 23 minutes after publication, and ARION's own words aired in episode 48). This upload is the episode as it was meant to air.`,
  },
};

const num = Number(process.argv[2]);
const EP = EPS[num];
if (!EP) { console.error("usage: republish-scrambled.js 46|47"); process.exit(2); }
const nn = String(num).padStart(3, "0");

(async () => {
  const { assertConsentClear } = require(path.join(ROOT, "scripts/lib/consent-guard"));
  assertConsentClear(path.join(ROOT, `workspace/podcasts/${nn}`));
  const ledger = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, "utf8")) : {};
  const st = ledger[num] || (ledger[num] = {});
  const save = () => fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
  const adapter = new YouTubeAdapter(ROOT);
  if (!adapter.isEnabled()) { console.error("youtube adapter not configured"); process.exit(2); }
  const tok = await adapter._accessToken();
  const h = { authorization: `Bearer ${tok}`, "content-type": "application/json" };
  const get = async (u) => { const r = await fetch(API + u, { headers: h }); const j = await r.json(); if (!r.ok) throw new Error(`${u}: ${JSON.stringify(j).slice(0, 300)}`); return j; };

  const old = (await get(`/videos?part=snippet,status&id=${EP.old}`)).items[0];
  if (!old) throw new Error(`old video ${EP.old} not found`);
  const sn = old.snippet;

  // 1. upload
  if (!st.newId) {
    const video = path.join(R, `GSP-${nn}-slideshow.mp4`);
    const desc = (EP.note + "\n\n" + sn.description).slice(0, 4990);
    const r = await adapter.post({ text: desc, media: { path: video, title: sn.title, tags: sn.tags || [], privacy: "public", categoryId: sn.categoryId || "10" } });
    if (!r || !r.ok) throw new Error("upload failed: " + (r && r.error));
    st.newId = r.id || (r.raw && r.raw.id); save();
    console.log("uploaded", st.newId);
    try { await setThumbnail(st.newId, path.join(R, `GSP-${nn}-cover.png`)); console.log("[thumb] ok"); } catch (e) { console.warn("[thumb]", e.message); }
  } else console.log("already uploaded", st.newId);

  // 2. playlist: new video into the old one's slot, old one out
  const items = [];
  let page = "";
  do { const j = await get(`/playlistItems?part=snippet&maxResults=50&playlistId=${PLAYLIST}${page ? "&pageToken=" + page : ""}`); items.push(...j.items); page = j.nextPageToken || ""; } while (page);
  const oldItem = items.find(i => i.snippet.resourceId.videoId === EP.old);
  const hasNew = items.some(i => i.snippet.resourceId.videoId === st.newId);
  if (!hasNew) {
    const body = { snippet: { playlistId: PLAYLIST, resourceId: { kind: "youtube#video", videoId: st.newId } } };
    if (oldItem) body.snippet.position = oldItem.snippet.position;
    for (let a = 1; a <= 4; a++) {
      const r = await fetch(`${API}/playlistItems?part=snippet`, { method: "POST", headers: h, body: JSON.stringify(body) });
      console.log("playlist insert", a, r.status);
      if (r.ok) break;
      await new Promise(s => setTimeout(s, 5000 * a));
    }
  }
  if (oldItem) {
    const r = await fetch(`${API}/playlistItems?id=${oldItem.id}`, { method: "DELETE", headers: h });
    console.log("playlist remove old", r.status);
  }

  // 3. old video: unlisted, with a pointer (minimal snippet; round-tripped snippets 400)
  if (!st.oldUnlisted) {
    const pointer = `Superseded: this upload was assembled out of order. The corrected episode is https://youtu.be/${st.newId}\n\n`;
    const r = await fetch(`${API}/videos?part=snippet,status`, {
      method: "PUT", headers: h,
      body: JSON.stringify({ id: EP.old, snippet: { title: sn.title, categoryId: sn.categoryId || "10", description: (pointer + sn.description).slice(0, 4990), tags: sn.tags || [] }, status: { privacyStatus: "unlisted" } }),
    });
    console.log("old video unlisted:", r.status, r.ok ? "" : (await r.text()).slice(0, 300));
    if (r.ok) { st.oldUnlisted = true; save(); }
  }
  console.log(JSON.stringify({ num, old: EP.old, new: st.newId, url: `https://www.youtube.com/watch?v=${st.newId}` }));
})().catch((e) => { console.error(e.message); process.exit(1); });
