/**
 * podcast-feed-aired-folder.test.js — #328
 *
 * The scheduler airs every file in <MUSIC_DIR>/Ghost Signals Podcast/. The
 * RSS feed used to publish only episodes.json rows whose mp3 sat under
 * workspace/podcasts/. On the radio host the mp3s are only in the aired
 * folder, so the live feed had zero items, and GSP-040/041 aired without
 * ever reaching a subscriber. These tests pin the feed to what airs.
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const {
  buildPodcastFeed,
  handlePodcastRequest,
  resolveEpisodes,
  gspNumber,
  titleFromFileName,
} = require("../server/podcast-feed");

let failures = 0;
const queue = [];
function check(name, fn) {
  queue.push(async () => {
    try { await fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.error(`  FAIL ${name}: ${e.message}`); }
  });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "podfeed-"));
  const baseDir = path.join(root, "repo");
  const musicDir = path.join(root, "music");
  const podcastDir = path.join(baseDir, "workspace", "podcasts");
  const airedDir = path.join(musicDir, "Ghost Signals Podcast");
  fs.mkdirSync(podcastDir, { recursive: true });
  fs.mkdirSync(airedDir, { recursive: true });
  const win = "C:/Users/nickf/Source/kannaka-radio/workspace/podcasts";
  fs.writeFileSync(path.join(podcastDir, "episodes.json"), JSON.stringify([
    { num: 39, title: "The Count and the Correction", audio: `${win}/039/GSP-039-The-Count-and-the-Correction.mp3` },
    { num: 40, title: "The Weight and the Measure", audio: `${win}/040/GSP-040-The-Weight-and-the-Measure.mp3` },
    { num: 41, title: "The Wish and the Gate", audio: `${win}/041/GSP-041-The-Wish-and-the-Gate.mp3` },
    { num: 101, title: "Shadows in the Cornstone", audio: "C:/x/workspace/tsof/E01/TSOF-E01-Shadows-in-the-Cornstone.mp3" },
    { num: 141, title: "Outtakes: The Bench", audio: `${win}/041/GSP-041-Outtakes-The-Bench.mp3` },
  ]));
  // 039 is synced into workspace/podcasts (the old, only path).
  fs.mkdirSync(path.join(podcastDir, "039"));
  fs.writeFileSync(path.join(podcastDir, "039", "GSP-039-The-Count-and-the-Correction.mp3"), "a".repeat(39));
  // What the host actually airs. 040 under a different name than the
  // catalogue records, to exercise the number match.
  fs.writeFileSync(path.join(airedDir, "GSP-040-Weight-and-Measure.mp3"), "b".repeat(40));
  fs.writeFileSync(path.join(airedDir, "GSP-041-The-Wish-and-the-Gate.mp3"), "c".repeat(41));
  fs.writeFileSync(path.join(airedDir, "GSP-041-Outtakes-The-Bench.mp3"), "d".repeat(141));
  // Dropped in, never catalogued: must still be published.
  fs.writeFileSync(path.join(airedDir, "GSP-043-The-Door-and-the-Key.mp3"), "e".repeat(43));
  fs.writeFileSync(path.join(airedDir, "notes.txt"), "not audio");
  return { root, baseDir, musicDir, airedDir };
}

console.log("podcast-feed-aired-folder.test.js");

check("gspNumber / titleFromFileName parse release filenames", () => {
  assert.strictEqual(gspNumber("GSP-040-The-Weight.mp3"), 40);
  assert.strictEqual(gspNumber("gsp_7 x.mp3"), 7);
  assert.strictEqual(gspNumber("TSOF-E01-x.mp3"), null);
  assert.strictEqual(gspNumber("GSP-0401x.mp3"), null);
  assert.strictEqual(titleFromFileName("GSP-043-The-Door-and-the-Key.mp3"), "The Door and the Key");
});

check("every aired episode resolves, catalogued or not; B-side keeps its own file", () => {
  const f = fixture();
  const eps = resolveEpisodes({ baseDir: f.baseDir, musicDir: f.musicDir });
  const byNum = Object.fromEntries(eps.map((e) => [e.num, e]));
  assert.deepStrictEqual(eps.map((e) => e.num), [141, 43, 41, 40, 39]);
  assert.strictEqual(byNum[39].urlPath, "/podcast/audio/039/GSP-039-The-Count-and-the-Correction.mp3");
  assert.strictEqual(byNum[40].urlPath, "/podcast/aired/GSP-040-Weight-and-Measure.mp3");
  assert.strictEqual(byNum[40].title, "The Weight and the Measure", "catalogue title overlays the file");
  assert.strictEqual(byNum[41].urlPath, "/podcast/aired/GSP-041-The-Wish-and-the-Gate.mp3");
  assert.strictEqual(byNum[141].urlPath, "/podcast/aired/GSP-041-Outtakes-The-Bench.mp3");
  assert.strictEqual(byNum[43].title, "The Door and the Key");
});

check("the feed lists GSP-040 and GSP-041 when their mp3s exist only in the aired folder", async () => {
  const f = fixture();
  const xml = await buildPodcastFeed({ baseUrl: "https://radio.example", baseDir: f.baseDir, musicDir: f.musicDir });
  for (const t of ["GSP-039: The Count", "GSP-040: The Weight", "GSP-041: The Wish", "GSP-043: The Door", "GSP-141: Outtakes"]) {
    assert.ok(xml.includes(`<title>${t}`), `missing ${t}`);
  }
  assert.ok(xml.includes('url="https://radio.example/podcast/aired/GSP-040-Weight-and-Measure.mp3" length="40"'));
  assert.ok(xml.includes('<guid isPermaLink="false">ghost-signals-40</guid>'));
  assert.strictEqual((xml.match(/<item>/g) || []).length, 5);
});

check("without a music dir the feed still works from workspace/podcasts alone", async () => {
  const f = fixture();
  const xml = await buildPodcastFeed({ baseUrl: "https://radio.example", baseDir: f.baseDir });
  assert.strictEqual((xml.match(/<item>/g) || []).length, 1);
});

async function get(server, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    http.get({ host: "127.0.0.1", port, path: urlPath, headers }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on("error", reject);
  });
}

check("/podcast/aired/ serves aired audio (with ranges) and refuses anything else", async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.root, "secret.mp3"), "nope");
  const server = http.createServer(async (req, res) => {
    const handled = await handlePodcastRequest(req, res, { baseDir: f.baseDir, baseUrl: "https://radio.example", musicDir: f.musicDir });
    if (!handled) { res.writeHead(418); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const ok = await get(server, "/podcast/aired/GSP-040-Weight-and-Measure.mp3");
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body, "b".repeat(40));
    const part = await get(server, "/podcast/aired/GSP-040-Weight-and-Measure.mp3", { Range: "bytes=0-9" });
    assert.strictEqual(part.status, 206);
    assert.strictEqual(part.body.length, 10);
    assert.strictEqual((await get(server, "/podcast/aired/..%2Fsecret.mp3")).status, 403);
    assert.strictEqual((await get(server, "/podcast/aired/..%5C..%5Csecret.mp3")).status, 403);
    assert.strictEqual((await get(server, "/podcast/aired/notes.txt")).status, 404);
    assert.strictEqual((await get(server, "/podcast/aired/%E0%A4%A")).status, 400);
    assert.strictEqual((await get(server, "/podcast/audio/..%2F..%2F..%2Fsecret.mp3")).status, 403);
    const feed = await get(server, "/podcast.xml");
    assert.strictEqual(feed.status, 200);
    assert.ok(feed.body.includes("GSP-041: The Wish and the Gate"));
  } finally {
    server.close();
  }
});

(async () => {
  for (const t of queue) await t();
  if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
})();
