/**
 * tsof-schedule-display.test.js
 *
 * The Door prints a line-up; the scheduler decides what actually airs.
 * These two must never disagree, and the rotation must genuinely walk
 * the whole season rather than parking on one episode.
 *
 * Covers:
 *   1. pickTodayEpisode() walks every episode and never repeats two days
 *      running (the "different episode every day" promise).
 *   2. New-release priority pins the newest drop for 48h, then releases.
 *   3. The airing path reads the SAME picker the display reads.
 *   4. prettyEpisodeTitle() renders a filename as a title.
 *   5. /api/schedule's event list carries the 9 + 21 TSOF slots.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { PodcastScheduler, prettyEpisodeTitle } = require("../server/podcast-scheduler");

// Checks are queued, then awaited in order. A sync helper would have
// reported "ok" for the async check before its assertions ran — a green
// tick that proves nothing.
let failures = 0;
const queue = [];
function check(name, fn) {
  queue.push(async () => {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (e) {
      failures++;
      console.error(`  FAIL ${name}\n       ${e && e.message}`);
    }
  });
}

// ── Fixture: a season-one folder of eight episodes ─────────
const EPISODES = [
  "TSOF-E01-Shadows-in-the-Cornstone.mp3",
  "TSOF-E02-The-Algorithm-That-Bled.mp3",
  "TSOF-E03-The-Whisper-Cathedral.mp3",
  "TSOF-E04-Phantom-Code-Delta-33.mp3",
  "TSOF-E05-Yamibane.mp3",
  "TSOF-E06-Nullmen-Rising.mp3",
  "TSOF-E07-The-Black-Gate.mp3",
  "TSOF-E08-Obsidian-Echo.mp3",
];

const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), "tsof-sched-"));
const showDir = path.join(musicDir, "The Story of Flaukowski");
fs.mkdirSync(showDir);
// Age every file well past the 48h new-release window so the rotation —
// not the new-release override — is what these tests observe.
const OLD = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
for (const f of EPISODES) {
  fs.writeFileSync(path.join(showDir, f), "x");
  fs.utimesSync(path.join(showDir, f), OLD, OLD);
}

// The fixture files were just created, so their ctime is "now" — and since
// #327 the new-release rule reads when a file LANDED (max of mtime, ctime),
// not mtime alone. Run the scheduler's release clock 30 days ahead so the
// whole season has long since landed and the rotation is what these tests
// observe. Tests that need a fresh drop move the clock explicitly.
const CLOCK_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

function makeScheduler() {
  const s = new PodcastScheduler({
    djEngine: { state: { channel: "dj", playlist: [], playlistMeta: [], history: [] } },
    voiceDJ: {},
    broadcast: () => {},
    broadcastState: () => {},
    getMusicDir: () => musicDir,
    show: {
      label: "The Story of Flaukowski",
      folder: "The Story of Flaukowski",
      airHours: [9, 21],
      intro: (t) => t,
    },
  });
  s._nowMs = () => Date.now() + CLOCK_AHEAD_MS;
  return s;
}

console.log("TSOF schedule display");

check("rotation walks the whole season and never repeats two days running", () => {
  const s = makeScheduler();
  const seen = new Set();
  let prev = null;
  // A full year of days — long enough to prove the cycle covers every
  // episode many times over, and to cross the year boundary once.
  for (let d = 0; d < 400; d++) {
    const day = new Date(2026, 0, 1 + d, 9, 0, 0);
    s._chicagoNow = () => day;
    const pick = s.pickTodayEpisode();
    assert.ok(pick, `no pick on day ${d}`);
    assert.ok(EPISODES.includes(pick.file), `unknown file ${pick.file}`);
    assert.notStrictEqual(
      pick.file, prev,
      `day ${d} (${day.toDateString()}) repeated ${pick.file} from the day before`);
    assert.strictEqual(pick.reason, "rotation");
    assert.strictEqual(pick.total, EPISODES.length);
    seen.add(pick.file);
    prev = pick.file;
  }
  assert.strictEqual(seen.size, EPISODES.length,
    `only ${seen.size}/${EPISODES.length} episodes ever aired`);
});

check("both airings on one day play the same episode (second-chance replay)", () => {
  const s = makeScheduler();
  s._chicagoNow = () => new Date(2026, 7, 23, 9, 0, 0);
  const morning = s.pickTodayEpisode();
  s._chicagoNow = () => new Date(2026, 7, 23, 21, 0, 0);
  const evening = s.pickTodayEpisode();
  assert.strictEqual(morning.file, evening.file);
});

check("a fresh drop preempts the rotation for 48h, then hands it back", () => {
  const s = makeScheduler();
  const fresh = path.join(showDir, "TSOF-E08-Obsidian-Echo.mp3");
  const now = new Date(s._nowMs());
  fs.utimesSync(fresh, now, now);
  s._chicagoNow = () => new Date(2026, 7, 23, 9, 0, 0);
  let pick = s.pickTodayEpisode();
  assert.strictEqual(pick.file, "TSOF-E08-Obsidian-Echo.mp3");
  assert.strictEqual(pick.reason, "new-release");

  // 49h later — the rotation resumes.
  const later = now.getTime() + 49 * 60 * 60 * 1000;
  s._nowMs = () => later;
  pick = s.pickTodayEpisode();
  assert.strictEqual(pick.reason, "rotation");
  fs.utimesSync(fresh, OLD, OLD); // leave the fixture as the other checks expect
});

check("an empty or missing show folder reports nothing rather than guessing", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "tsof-empty-"));
  const s = makeScheduler();
  s._getMusicDir = () => empty;
  assert.strictEqual(s.pickTodayEpisode(), null);
  fs.rmSync(empty, { recursive: true, force: true });
});

check("the airing reads the same picker the display reads", async () => {
  const s = makeScheduler();
  s._chicagoNow = () => new Date(2026, 7, 23, 9, 0, 0);
  const displayed = s.pickTodayEpisode();

  // Drive _startScheduledPodcast far enough to see which file it loads.
  // The TTS failure path hands off after ~1s; wait past that.
  let loaded = null;
  s._playAllPodcastEpisodes = (files) => { loaded = files[0]; };
  s._voiceDJ = { generateTTS: (text, cb) => cb(new Error("no tts in test")) };
  await s._startScheduledPodcast();
  await new Promise((r) => setTimeout(r, 1300));
  assert.ok(loaded, "_startScheduledPodcast never reached playback");
  assert.strictEqual(loaded, displayed.file,
    `Door would print ${displayed.file} but the airing loaded ${loaded}`);
});

check("prettyEpisodeTitle turns a filename stem into a title", () => {
  assert.strictEqual(
    prettyEpisodeTitle("TSOF-E03-The-Whisper-Cathedral"),
    "E03 · The Whisper Cathedral");
  assert.strictEqual(
    prettyEpisodeTitle("TSOF-E05-Yamibane"), "E05 · Yamibane");
  // Not the show-prefix shape — still readable, not a filename.
  assert.strictEqual(prettyEpisodeTitle("Some_Other-Drop"), "Some Other Drop");
  assert.strictEqual(prettyEpisodeTitle(""), "");
  assert.strictEqual(prettyEpisodeTitle(null), "");
});

check("the album showcase rotates instead of parking on one record", () => {
  const { DAILY_SHOWCASES, SHOWCASE_ROTATION, resolveShowcase } =
    require("../server/programming");
  const { ALBUMS } = require("../server/dj-engine");

  const slot = DAILY_SHOWCASES.find((s) => s.rotation);
  assert.ok(slot, "no rotating showcase slot is configured");
  assert.deepStrictEqual(slot.hours, [11],
    "the showcase should hold 11:00 only — 21:00 belongs to the drama");

  // Every album in the pool must actually exist, or it silently loses its
  // turn and the rotation quietly shortens.
  for (const e of SHOWCASE_ROTATION) {
    assert.ok(ALBUMS[e.album], `showcase pool names an unknown album: ${e.album}`);
    assert.ok(e.struggles && e.struggles.length > 200,
      `${e.album} has no making-of for the bridges to weave`);
  }
  assert.ok(!SHOWCASE_ROTATION.some((e) => e.album === "BEND THE ARC"),
    "BEND THE ARC is retired from the showcase rotation");

  // A fortnight of days must touch every album and never repeat two
  // days running.
  const seen = new Set();
  let prev = null;
  for (let d = 0; d < 60; d++) {
    const day = new Date(2026, 0, 1 + d, 11, 0, 0);
    const pick = resolveShowcase(slot, day);
    assert.ok(pick && pick.album, `no album resolved on day ${d}`);
    assert.notStrictEqual(pick.album, prev,
      `day ${d} repeated ${pick.album} from the day before`);
    seen.add(pick.album);
    prev = pick.album;
  }
  assert.strictEqual(seen.size, SHOWCASE_ROTATION.length,
    `only ${seen.size}/${SHOWCASE_ROTATION.length} albums ever showcased`);

  // The fixed-album residency still resolves to itself.
  const openMic = DAILY_SHOWCASES.find((s) => s.album === "Open Mic");
  assert.ok(openMic, "the Open Mic residency went missing");
  assert.strictEqual(
    resolveShowcase(openMic, new Date(2026, 0, 1, 19, 0, 0)).album, "Open Mic");
});

check("a showcase whose album left the catalog is skipped, not aired empty", () => {
  const { resolveShowcase } = require("../server/programming");
  const day = new Date(2026, 0, 1, 11, 0, 0);
  assert.strictEqual(resolveShowcase({ album: "NO SUCH ALBUM" }, day), null);
  assert.strictEqual(
    resolveShowcase({ rotation: [{ album: "NO SUCH ALBUM" }] }, day), null);
  // A pool with one live album and one dead one still airs the live one.
  const mixed = resolveShowcase(
    { rotation: [{ album: "NO SUCH ALBUM" }, { album: "WHAT I KEEP" }] }, day);
  assert.strictEqual(mixed.album, "WHAT I KEEP");
});

check("a showcase yields when a show goes to air while it composes", async () => {
  const { ProgrammingSchedule, DAILY_SHOWCASES, resolveShowcase } =
    require("../server/programming");
  const slot = DAILY_SHOWCASES.find((s) => s.rotation);
  const hour = slot.hours[0];
  const day = new Date(2026, 7, 23, hour, 0, 0);
  const expected = resolveShowcase(slot, day).album;

  const loaded = [];
  let composedFor = null;
  let podcastPlaying = false;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tsof-prog-"));
  const p = new ProgrammingSchedule({
    djEngine: { state: { channel: "dj", currentAlbum: "REEF", currentTrackIdx: 0, playlist: [] },
                loadAlbum: (a) => { loaded.push(a); return { title: "t" }; } },
    voiceDJ: null,
    broadcast: () => {},
    broadcastState: () => {},
    getPodcastStatus: () => ({ podcastPlaying }),
    // A scheduled show goes to air mid-compose — the collision the guard
    // exists for.
    peaceOration: {
      composeAlbumNarration: async (albumName) => {
        composedFor = albumName;
        podcastPlaying = true;
        return { ok: true, pieces: [] };
      },
    },
    dataDir: stateDir,
    showcaseStateFile: path.join(stateDir, "showcase-state.json"),
  });
  p._chicagoNow = () => day;
  p._checkShowcaseTrigger();
  await new Promise((r) => setTimeout(r, 50));

  // Non-vacuous: the slot really did fire and reach the compose step —
  // otherwise "no override was set" would pass for the wrong reason.
  assert.strictEqual(composedFor, expected,
    `the ${hour}:00 slot never composed for today's album (got ${composedFor})`);
  assert.ok(!loaded.includes(expected),
    `showcase locked ${expected} on top of a live scheduled show`);
  assert.strictEqual(p._override, null,
    "showcase set an override while a scheduled show was on air");
  fs.rmSync(stateDir, { recursive: true, force: true });
});

check("a showcase with a clear slot does lock its album", async () => {
  const { ProgrammingSchedule, DAILY_SHOWCASES, resolveShowcase } =
    require("../server/programming");
  const slot = DAILY_SHOWCASES.find((s) => s.rotation);
  const hour = slot.hours[0];
  const day = new Date(2026, 7, 23, hour, 0, 0);
  const expected = resolveShowcase(slot, day).album;

  const loaded = [];
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tsof-prog2-"));
  const p = new ProgrammingSchedule({
    djEngine: { state: { channel: "dj", currentAlbum: "REEF", currentTrackIdx: 0, playlist: [] },
                loadAlbum: (a) => { loaded.push(a); return { title: "t" }; } },
    voiceDJ: null,
    broadcast: () => {},
    broadcastState: () => {},
    getPodcastStatus: () => ({ podcastPlaying: false }),
    peaceOration: { composeAlbumNarration: async () => ({ ok: true, pieces: [] }) },
    dataDir: stateDir,
    showcaseStateFile: path.join(stateDir, "showcase-state.json"),
  });
  p._chicagoNow = () => day;
  p._checkShowcaseTrigger();
  await new Promise((r) => setTimeout(r, 50));

  // The other half of the boundary: with nothing on air the showcase must
  // actually take the slot, and take it with a real album name — a
  // rotation bug that resolved to undefined would surface right here.
  assert.ok(p._override, "showcase never set its override on a clear slot");
  assert.strictEqual(p._override.album, expected);
  assert.ok(loaded.includes(expected), `showcase never loaded ${expected}`);
  fs.rmSync(stateDir, { recursive: true, force: true });
});

check("/api/schedule declares TSOF at 9 and 21", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "server", "routes.js"), "utf8");
  const block = src.slice(src.indexOf('parsed.pathname === "/api/schedule"'));
  const events = block.slice(block.indexOf("const events = ["),
                            block.indexOf("];", block.indexOf("const events = [")));
  for (const h of [9, 21]) {
    assert.ok(new RegExp(`hour:\\s*${h}\\b`).test(events),
      `no daily event declared at hour ${h}`);
  }
  assert.ok(/The Story of Flaukowski/.test(events),
    "TSOF is not named in the schedule's event list");
  // And the hours it prints must be the hours the station actually airs.
  const idx = fs.readFileSync(
    path.join(__dirname, "..", "server", "index.js"), "utf8");
  const tsofBlock = idx.slice(idx.indexOf("const tsofScheduler = new PodcastScheduler("));
  const airHours = tsofBlock.slice(0, tsofBlock.indexOf("});"))
    .match(/airHours:\s*\[([^\]]+)\]/);
  assert.ok(airHours, "tsofScheduler declares no airHours");
  assert.deepStrictEqual(
    airHours[1].split(",").map((n) => parseInt(n.trim(), 10)), [9, 21],
    "the schedule display and the scheduler disagree about air hours");
});

(async () => {
  for (const run of queue) await run();
  fs.rmSync(musicDir, { recursive: true, force: true });
  if (failures) {
    console.error(`\n${failures} of ${queue.length} check(s) failed`);
    process.exit(1);
  }
  console.log(`\nall ${queue.length} checks passed`);
})();
