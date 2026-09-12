/**
 * admin-trigger-gate.test.js — the three routes that make the station SPEAK
 * are not reachable by the public.
 *
 * `/api/oration/now` composes a peace oration, puts it on the live stream and
 * fans a companion post to Bluesky, Mastodon, Telegram and Nostr from
 * Kannaka's own accounts. `/api/album/showcase` seizes the rotation for half
 * an hour. `/api/dreams/trigger` starts an unscheduled annealing pass.
 *
 * All three answered an empty POST from anyone on the internet, under comments
 * that called them "admin" and an /agent.md heading that said
 * "admin / internal". On 2026-09-12 a survey called two of them by accident
 * and an unscheduled oration went out to all four social accounts before
 * anyone could stop it.
 *
 * The assertion that matters in every case is not the status code. It is that
 * the SIDE EFFECT did not fire — a gate that returns 401 and speaks anyway is
 * the failure this file exists to catch.
 */

const http = require("http");
const assert = require("assert");
const setupRoutes = require("../server/routes");

function noop() {}

let failures = 0;
const results = [];
function check(name, fn) {
  return fn().then(
    () => results.push(`  ok   ${name}`),
    (e) => { failures++; results.push(`  FAIL ${name}\n       ${e.message}`); },
  );
}

/** Records every dangerous effect the three routes can reach. */
function spy() {
  const fired = [];
  return {
    fired,
    peaceOration: {
      deliverNow: () => { fired.push("oration"); return Promise.resolve(true); },
      showcaseAlbum: () => { fired.push("showcase-speech"); return Promise.resolve(true); },
    },
    djEngine: {
      state: { trackStartedAt: Date.now(), currentTrackIdx: 0 },
      getNowPlaying: () => ({ title: "T", album: "A", file: "t.mp3" }),
      getSchedule: () => [], getPlaylist: () => [], getRecentHistory: () => [],
      getCurrentBlock: () => "Block",
      advance: noop, jumpToTrack: noop, skipBy: noop,
      forceAlbum: () => { fired.push("force-album"); },
      setAlbumOverride: () => { fired.push("force-album"); },
    },
  };
}

function makeHandler(s) {
  return setupRoutes({
    djEngine: s.djEngine,
    peaceOration: s.peaceOration,
    perception: { perceive: noop, getHistory: () => [] },
    nats: { connected: false, publish: noop },
    flux: { publish: noop, publishMemoryStored: noop, publishDreamCompleted: noop },
    live: { isLive: () => false },
    voiceDJ: { speak: noop, synthesizeIntro: noop },
    syncManager: { broadcast: noop },
    voteManager: { snapshot: () => ({}) },
    webrtcSignaling: { handle: noop },
    musicGen: { generate: noop },
    broadcast: noop,
    floor: { addReaction: noop, countListeners: () => 0, snapshot: () => ({ count: 0, vibe: 0, reactions: [], perTrack: {} }) },
    config: { spaPath: __dirname, getMusicDir: () => "/tmp/music-test", musicDir: "/tmp/music-test" },
    gsHub: null,
  });
}

function post(handler, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const req = http.request(
        { host: "127.0.0.1", port, path, method: "POST", headers: { "content-length": 0, ...headers } },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => { server.close(); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }); });
        },
      );
      req.on("error", (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

const TRIGGERS = ["/api/oration/now", "/api/dreams/trigger", "/api/album/showcase?album=OPT%20OUT"];

(async () => {
  console.log("admin-trigger-gate");

  // ── unset token: disabled, not open ───────────────────────────────────
  for (const path of TRIGGERS) {
    await check(`${path} is disabled when no admin token is configured`, async () => {
      delete process.env.RADIO_ADMIN_TOKEN;
      const s = spy();
      const r = await post(makeHandler(s), path);
      assert.strictEqual(r.status, 503, `expected 503, got ${r.status}: ${r.body.slice(0, 120)}`);
      await new Promise((res) => setTimeout(res, 40));
      assert.deepStrictEqual(s.fired, [], `nothing may fire; fired: ${s.fired.join(",")}`);
    });
  }

  // ── the actual incident: an anonymous POST with no headers ────────────
  await check("an anonymous POST cannot make the station speak", async () => {
    process.env.RADIO_ADMIN_TOKEN = "s3cret-admin-token";
    const s = spy();
    const r = await post(makeHandler(s), "/api/oration/now");
    assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
    await new Promise((res) => setTimeout(res, 40));
    assert.deepStrictEqual(s.fired, [], "an oration must NOT be composed, spoken or posted");
  });

  await check("a wrong token is refused and nothing fires", async () => {
    process.env.RADIO_ADMIN_TOKEN = "s3cret-admin-token";
    const s = spy();
    const r = await post(makeHandler(s), "/api/oration/now", { authorization: "Bearer wrong-token-xx" });
    assert.strictEqual(r.status, 401);
    await new Promise((res) => setTimeout(res, 40));
    assert.deepStrictEqual(s.fired, []);
  });

  await check("a token of the right length but wrong bytes is refused", async () => {
    process.env.RADIO_ADMIN_TOKEN = "s3cret-admin-token";
    const s = spy();
    const r = await post(makeHandler(s), "/api/oration/now",
      { authorization: "Bearer s3cret-admin-tokeX" });
    assert.strictEqual(r.status, 401, "constant-time compare must still reject");
    await new Promise((res) => setTimeout(res, 40));
    assert.deepStrictEqual(s.fired, []);
  });

  // ── the operator still gets through ───────────────────────────────────
  await check("the right token reaches the oration", async () => {
    process.env.RADIO_ADMIN_TOKEN = "s3cret-admin-token";
    const s = spy();
    const r = await post(makeHandler(s), "/api/oration/now", { authorization: "Bearer s3cret-admin-token" });
    assert.strictEqual(r.status, 202, `expected 202, got ${r.status}: ${r.body.slice(0, 120)}`);
    await new Promise((res) => setTimeout(res, 60));
    assert.deepStrictEqual(s.fired, ["oration"], "the operator's own trigger must still work");
  });

  await check("a bare token without the Bearer prefix also works", async () => {
    process.env.RADIO_ADMIN_TOKEN = "s3cret-admin-token";
    const s = spy();
    const r = await post(makeHandler(s), "/api/oration/now", { authorization: "s3cret-admin-token" });
    assert.strictEqual(r.status, 202);
  });

  delete process.env.RADIO_ADMIN_TOKEN;
  console.log(results.join("\n"));
  if (failures) { console.error(`admin-trigger-gate: ${failures} failed`); process.exit(1); }
  console.log("admin-trigger-gate: all passed");
})();
