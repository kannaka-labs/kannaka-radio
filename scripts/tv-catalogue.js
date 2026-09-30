#!/usr/bin/env node
/**
 * tv-catalogue.js — fetch the channel's YouTube catalogue for Kannaka TV's slate builder.
 *
 * Runs ON ORACLE (O1), next to both checkouts. It produces exactly the catalogue shape that
 * `~/kannaka-tv/scripts/build-slate.js --from <file>` consumes:
 *
 *   [{ playlist, playlistId, items: [{ id, title, description, published, seconds, privacy }] }]
 *
 * Why this exists: build-slate.js fetches the public playlists with a plain Data API key, and no
 * such key is provisioned on O1 (nothing in ~/.kannaka-tv.env, nothing in /etc/kannaka-secrets).
 * The publish pipeline DOES hold a YouTube credential — the uploader's OAuth grant in
 * ~/kannaka-radio/.youtube.json (scopes youtube + youtube.upload) — and the Data API answers the
 * same read endpoints to a Bearer token. So the episode that was just uploaded with that
 * credential is catalogued with it too. If the token has died (weekly `invalid_grant` while the
 * consent screen is in Testing) the upload step already failed, so this never runs blind.
 *
 * The playlist list is READ FROM build-slate.js rather than copied here, so kannaka-tv stays the
 * one place that says what the channel carries.
 *
 *   node tv-catalogue.js > catalogue.json
 *   TV_DIR=~/kannaka-tv RADIO_DIR=~/kannaka-radio node tv-catalogue.js > catalogue.json
 *
 * Exit 0 with JSON on stdout; anything else on stderr with a non-zero exit. Never prints a token.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');

const HOME = process.env.HOME || os.homedir();
const TV_DIR = process.env.TV_DIR || path.join(HOME, 'kannaka-tv');
const RADIO_DIR = process.env.RADIO_DIR || path.join(HOME, 'kannaka-radio');
const BUILD_SLATE = path.join(TV_DIR, 'scripts', 'build-slate.js');
const CRED_PATH = path.join(RADIO_DIR, '.youtube.json');
const API = 'https://www.googleapis.com/youtube/v3';

function request(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = { method, hostname: u.hostname, path: u.pathname + u.search, headers: { ...headers } };
    if (body != null) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

/** The playlists kannaka-tv carries, read off build-slate.js so there is one list, not two. */
function playlistsFromBuildSlate() {
  const src = fs.readFileSync(BUILD_SLATE, 'utf8');
  const block = src.match(/const PLAYLISTS\s*=\s*\[([\s\S]*?)\];/);
  if (!block) throw new Error(`could not find PLAYLISTS in ${BUILD_SLATE}`);
  const ids = [...block[1].matchAll(/'(PL[A-Za-z0-9_-]+)'/g)].map((m) => m[1]);
  if (!ids.length) throw new Error(`PLAYLISTS in ${BUILD_SLATE} is empty`);
  return ids;
}

async function accessToken() {
  const creds = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
  const form = new URLSearchParams({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: creds.refresh_token,
    grant_type: 'refresh_token',
  }).toString();
  const r = await request('https://oauth2.googleapis.com/token', 'POST',
    { 'Content-Type': 'application/x-www-form-urlencoded' }, form);
  if (r.status !== 200 || !r.body || !r.body.access_token) {
    const why = r.body && r.body.error ? `${r.body.error}: ${r.body.error_description || ''}` : `HTTP ${r.status}`;
    throw new Error(`YouTube token refresh failed (${why}). Re-grant with scripts/youtube-grant.js.`);
  }
  return r.body.access_token;
}

/** Same walk as build-slate.js's fetchCatalogue, authenticated by Bearer instead of ?key=. */
async function fetchCatalogue(token, playlists) {
  const H = { Authorization: `Bearer ${token}` };
  const get = async (url) => {
    const r = await request(url, 'GET', H, null);
    if (r.status !== 200 || !r.body || r.body.error) {
      const msg = r.body && r.body.error ? r.body.error.message : `HTTP ${r.status}`;
      throw new Error(`${url.replace(/\?.*$/, '')}: ${msg}`);
    }
    return r.body;
  };

  const out = [];
  for (const id of playlists) {
    const items = [];
    let pageToken = '';
    let title = id;
    do {
      const j = await get(
        `${API}/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${id}` +
          `${pageToken ? '&pageToken=' + pageToken : ''}`
      );
      for (const it of j.items || []) {
        title = (it.snippet && it.snippet.channelTitle) || title;
        items.push({
          id: it.contentDetails && it.contentDetails.videoId,
          title: (it.snippet && it.snippet.title) || '',
          description: ((it.snippet && it.snippet.description) || '').split('\n')[0].slice(0, 300),
          published: ((it.contentDetails && it.contentDetails.videoPublishedAt) || '').slice(0, 10),
        });
      }
      pageToken = j.nextPageToken || '';
    } while (pageToken);

    const pl = await get(`${API}/playlists?part=snippet&id=${id}`);
    const plTitle = pl.items && pl.items[0] && pl.items[0].snippet && pl.items[0].snippet.title;
    out.push({ playlist: plTitle || title, playlistId: id, items });
  }

  // durations + privacy, in batches of 50
  const all = out.flatMap((p) => p.items).filter((x) => x.id);
  for (let i = 0; i < all.length; i += 50) {
    const ids = all.slice(i, i + 50).map((x) => x.id).join(',');
    const j = await get(`${API}/videos?part=contentDetails,status&id=${ids}`);
    const by = {};
    for (const v of j.items || []) {
      const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec((v.contentDetails && v.contentDetails.duration) || '');
      by[v.id] = {
        seconds: m ? +(m[1] || 0) * 3600 + +(m[2] || 0) * 60 + +(m[3] || 0) : null,
        privacy: v.status && v.status.privacyStatus,
      };
    }
    for (const p of out) for (const it of p.items) if (by[it.id]) Object.assign(it, by[it.id]);
  }
  return out;
}

(async () => {
  try {
    const playlists = playlistsFromBuildSlate();
    const token = await accessToken();
    const cat = await fetchCatalogue(token, playlists);
    const n = cat.reduce((s, p) => s + p.items.length, 0);
    process.stderr.write(`catalogue: ${cat.length} playlists, ${n} items\n`);
    process.stdout.write(JSON.stringify(cat) + '\n');
  } catch (e) {
    process.stderr.write(`tv-catalogue: ${e.message}\n`);
    process.exit(1);
  }
})();
