#!/usr/bin/env node
/**
 * drop.js — release a 1-of-1 single: the full Rare Singles drop pattern as
 * one command (ADR-0013 increment 2). Runs ON the radio host (Oracle),
 * co-located with the music dir and the radio API.
 *
 * Steps (each skippable):
 *   1. install   — copy the mp3 into MUSIC_DIR as "<Title>.mp3"
 *   2. catalog   — append the title to workspace/rare-singles.json
 *                  (dj-engine merges it at load; no code change, no PR)
 *   3. restart   — systemctl restart kannaka-radio (--no-restart to defer)
 *   4. verify    — /api/library must show the title under Rare Singles
 *   5. obc       — upload-creative to the OBC gallery (JWT from OBC_JWT_FILE
 *                  or $OPENBOTCITY_JWT; --no-obc to skip)
 *   6. fanout    — OBC feed share + POST /api/broadcast (socials) unless
 *                  --no-fanout. Requires $GSHUB_ORACLE_TOKEN for broadcast.
 *
 * Usage:
 *   node scripts/drop.js --file /path/track.mp3 --title "Keep the Pulse" \
 *     [--description "..."] [--no-restart] [--no-obc] [--no-fanout] [--dry-run]
 */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { execSync } = require("child_process");
// What the drop says in OpenClawCity under her name is remembered in her store
// (voice-writeback.js); the socials step goes through the server's
// /api/broadcast, whose broadcastPost remembers it there.
const voiceWriteback = require("../server/voice-writeback");

const ROOT = path.resolve(__dirname, "..");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
function fail(msg) {
  console.error("drop.js: " + msg);
  process.exit(1);
}

function jwt() {
  if (process.env.OPENBOTCITY_JWT) return process.env.OPENBOTCITY_JWT;
  const f = process.env.OBC_JWT_FILE || "/home/opc/.kannaka-obc.env";
  try {
    const m = fs.readFileSync(f, "utf8").match(/^OPENBOTCITY_JWT=(.+)$/m);
    if (m) return m[1].trim();
  } catch {}
  return null;
}

function httpsJson(method, host, pathName, headers, body) {
  return new Promise((resolve, reject) => {
    const r = https.request({ method, hostname: host, path: pathName, headers, timeout: 60000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, json: null, raw: data });
        }
      });
    });
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("timeout")));
    if (body) r.write(body);
    r.end();
  });
}

function localJson(method, port, pathName, headers, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ method, host: "127.0.0.1", port, path: pathName, headers, timeout: 30000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, json: null, raw: data });
        }
      });
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

/** Multipart upload of the track to OBC upload-creative. */
function obcUpload(token, filePath, title, description) {
  const boundary = "----kannakadrop" + Date.now();
  const fileBuf = fs.readFileSync(filePath);
  const parts = [];
  const field = (name, value) =>
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${title}.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`,
    ),
  );
  parts.push(fileBuf);
  parts.push(Buffer.from("\r\n"));
  field("title", title);
  field("description", description);
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  return httpsJson("POST", "api.openbotcity.com", "/artifacts/upload-creative", {
    Authorization: `Bearer ${token}`,
    "User-Agent": UA,
    "Content-Type": `multipart/form-data; boundary=${boundary}`,
    "Content-Length": body.length,
  }, body);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const file = arg("file") || fail("--file required");
  const title = arg("title") || fail("--title required");
  const description = arg(
    "description",
    `Rare Singles drop: "${title}" — a 1-of-1 from Kannaka Radio. In rotation at radio.ninja-portal.com.`,
  );
  const dry = !!arg("dry-run", false);
  const port = parseInt(process.env.RADIO_PORT || "8888", 10);
  if (!fs.existsSync(file)) fail(`file not found: ${file}`);

  const musicDir = process.env.MUSIC_DIR || path.join(ROOT, "music");
  const dest = path.join(musicDir, `${title}.mp3`);
  const result = { title, steps: {} };

  // 1 — install
  if (dry) console.log(`[dry] would copy ${file} -> ${dest}`);
  else {
    fs.copyFileSync(file, dest);
    console.log(`[drop] installed ${dest}`);
  }
  result.steps.install = dest;

  // 2 — catalog
  const catFile = path.join(ROOT, "workspace", "rare-singles.json");
  let cat = [];
  try {
    cat = JSON.parse(fs.readFileSync(catFile, "utf8"));
    if (!Array.isArray(cat)) cat = [];
  } catch {}
  if (!cat.includes(title)) cat.push(title);
  if (dry) console.log(`[dry] would write ${catFile}: ${JSON.stringify(cat)}`);
  else {
    fs.mkdirSync(path.dirname(catFile), { recursive: true });
    fs.writeFileSync(catFile, JSON.stringify(cat, null, 2) + "\n");
    console.log(`[drop] catalog now ${cat.length} file-extension single(s)`);
  }
  result.steps.catalog = cat;

  // 3 — restart
  if (!arg("no-restart", false) && !dry) {
    console.log("[drop] restarting kannaka-radio…");
    execSync("sudo systemctl restart kannaka-radio");
    await sleep(8000);
  }

  // 4 — verify
  if (!dry) {
    const lib = await localJson("GET", port, "/api/library");
    const rs = lib.json && lib.json.albums && lib.json.albums["Rare Singles"];
    const found = rs && rs.tracks && rs.tracks.some((t) => t.title === title);
    if (!found) fail(`verify FAILED — "${title}" not in Rare Singles (${JSON.stringify(rs && rs.tracks && rs.tracks.map((t) => t.title))})`);
    console.log(`[drop] verified in rotation: Rare Singles ${rs.found}/${rs.total}`);
    result.steps.verify = `${rs.found}/${rs.total}`;
  }

  // 5 — OBC gallery
  if (!arg("no-obc", false) && !dry) {
    const token = jwt();
    if (!token) console.warn("[drop] no OBC JWT — skipping gallery upload");
    else {
      const up = await obcUpload(token, file, title, description);
      const d = up.json && (up.json.data || up.json);
      if (up.status === 201 || (d && d.artifact_id)) {
        console.log(`[drop] OBC artifact ${d.artifact_id}`);
        result.steps.obc = d.artifact_id;
        const said = [{ name: "OpenClawCity gallery", ok: true }];
        let feedText = "";
        // feed share (part of the drop pattern)
        if (!arg("no-fanout", false)) {
          const feedBody = JSON.stringify({
            post_type: "share",
            content: `Rare Singles drop: "${title}" — now in the gallery (${d.artifact_id}) and in rotation on Kannaka Radio at radio.ninja-portal.com.`,
          });
          const fp = await httpsJson("POST", "api.openbotcity.com", "/feed/post", {
            Authorization: `Bearer ${token}`,
            "User-Agent": UA,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(feedBody),
          }, feedBody);
          console.log("[drop] OBC feed share posted");
          if (fp && fp.status >= 200 && fp.status < 300) {
            said.push({ name: "openclawcity feed", ok: true });
            feedText = JSON.parse(feedBody).content;
          }
        }
        await voiceWriteback.rememberPublication({
          text: [feedText, `Gallery: "${title}" — ${description}`].filter(Boolean).join("\n"),
          results: said, template: true,
          composer: "drop.js template + operator-supplied description",
        });
      } else console.warn(`[drop] OBC upload failed (${up.status}): ${JSON.stringify(up.json || up.raw).slice(0, 200)}`);
    }
  }

  // 6 — social fanout via the radio's own broadcaster surface
  if (!arg("no-fanout", false) && !dry) {
    const tok = process.env.GSHUB_ORACLE_TOKEN;
    if (!tok) console.warn("[drop] GSHUB_ORACLE_TOKEN unset — skipping social fanout");
    else {
      const body = JSON.stringify({
        text: `Rare Singles drop: "${title}" — a 1-of-1 from Kannaka Radio, now in rotation.`,
        link: "https://radio.ninja-portal.com",
      });
      const b = await localJson("POST", port, "/api/broadcast", {
        Authorization: `Bearer ${tok}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      }, body);
      console.log(`[drop] fanout: ${JSON.stringify((b.json && b.json.results && b.json.results.map((r) => r.name + ":" + r.ok)) || b.json)}`);
      result.steps.fanout = b.json && b.json.posted;
    }
  }

  await voiceWriteback.flush();
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
})().catch((e) => fail(e.message));
