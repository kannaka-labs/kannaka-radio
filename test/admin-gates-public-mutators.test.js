/**
 * admin-gates-public-mutators.test.js — the 2026-11-01 admin-gate audit.
 *
 * radio.ninja-portal.com proxies the whole port, so every route here answered
 * anyone on the internet: start or stop live capture and recording, silence
 * the DJ voice station-wide, generate a dream track, forward an arbitrary body
 * to the stem server, queue an arbitrary path, and skip tracks by claiming the
 * current one "ended". As in admin-trigger-gate.test.js the assertion that
 * matters is that the SIDE EFFECT did not fire.
 */
const http = require("http");
const assert = require("assert");
const setupRoutes = require("../server/routes");

const noop = () => {};
let failures = 0;
const results = [];
function check(name, fn) {
  return fn().then(
    () => results.push(`  ok   ${name}`),
    (e) => { failures++; results.push(`  FAIL ${name}\n       ${e.message}`); },
  );
}

function spy() {
  const fired = [];
  return {
    fired,
    live: {
      isLive: () => false,
      start: () => fired.push("live-start"), stop: () => fired.push("live-stop"),
      startRecording: () => fired.push("record-start"), stopRecording: () => fired.push("record-stop"),
      getStatus: () => ({ active: false }), getRecordingStatus: () => ({ recording: false }),
    },
    voiceDJ: { speak: noop, synthesizeIntro: noop, isTalking: () => false, toggle: () => { fired.push("voice-toggle"); return false; } },
    musicGen: { generate: () => { fired.push("generate"); return Promise.resolve({ ok: true }); } },
    djEngine: {
      state: { trackStartedAt: Date.now(), currentTrackIdx: 0, channel: "dj" },
      userQueue: [],
      getNowPlaying: () => ({ title: "T", album: "A", file: "t.mp3" }),
      getSchedule: () => [], getPlaylist: () => [], getRecentHistory: () => [],
      getCurrentBlock: () => "Block",
      advance: noop, jumpToTrack: noop, skipBy: noop,
      advanceTrack: () => { fired.push("advance"); return { title: "next" }; },
      addToQueue: (f) => { fired.push(`queue:${f}`); return [f]; },
    },
  };
}

function makeHandler(s) {
  return setupRoutes({
    djEngine: s.djEngine,
    peaceOration: { deliverNow: noop, showcaseAlbum: noop },
    perception: { perceive: noop, getHistory: () => [] },
    nats: { connected: false, publish: noop },
    flux: { publish: noop, publishMemoryStored: noop, publishDreamCompleted: noop, publishLiveStatus: noop },
    live: s.live,
    voiceDJ: s.voiceDJ,
    syncManager: { broadcast: noop },
    voteManager: { snapshot: () => ({}) },
    webrtcSignaling: { handle: noop },
    musicGen: s.musicGen,
    broadcast: noop,
    broadcastState: noop,
    floor: { addReaction: noop, countListeners: () => 0, snapshot: () => ({ count: 0, vibe: 0, reactions: [], perTrack: {} }) },
    config: { spaPath: __dirname, getMusicDir: () => "/tmp/music-test", musicDir: "/tmp/music-test", broadcastState: noop, broadcastQueue: noop },
    gsHub: null,
  });
}

function post(handler, path, { headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const req = http.request(
        { host: "127.0.0.1", port, path, method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers } },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => { server.close(); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }); });
        },
      );
      req.on("error", (e) => { server.close(); reject(e); });
      req.end(body);
    });
  });
}

const settle = () => new Promise((r) => setTimeout(r, 40));
const GATED = ["/api/live/start", "/api/live/stop", "/api/live/record-start", "/api/live/record-stop",
               "/api/dj-voice/toggle", "/api/generate", "/api/orc/resonance/stem-1"];

(async () => {
  console.log("admin-gates-public-mutators");

  for (const path of GATED) {
    await check(`${path}: anonymous POST is refused and nothing fires`, async () => {
      process.env.RADIO_ADMIN_TOKEN = "s3cret-admin-token";
      const s = spy();
      const r = await post(makeHandler(s), path, { body: "{}" });
      assert.strictEqual(r.status, 401, `expected 401, got ${r.status}: ${r.body.slice(0, 100)}`);
      await settle();
      assert.deepStrictEqual(s.fired, [], `fired: ${s.fired.join(",")}`);
    });
    await check(`${path}: disabled (503) when no admin token is configured`, async () => {
      delete process.env.RADIO_ADMIN_TOKEN;
      const s = spy();
      const r = await post(makeHandler(s), path, { body: "{}" });
      assert.strictEqual(r.status, 503, `expected 503, got ${r.status}`);
      await settle();
      assert.deepStrictEqual(s.fired, []);
    });
  }

  await check("the admin token still reaches the live and voice controls", async () => {
    process.env.RADIO_ADMIN_TOKEN = "s3cret-admin-token";
    const s = spy();
    const h = { authorization: "Bearer s3cret-admin-token" };
    await post(makeHandler(s), "/api/live/start", { headers: h });
    await post(makeHandler(s), "/api/dj-voice/toggle", { headers: h });
    await settle();
    assert.deepStrictEqual(s.fired, ["live-start", "voice-toggle"]);
  });

  await check("/api/orc/resonance rejects a stem id that is not a bare token", async () => {
    process.env.RADIO_ADMIN_TOKEN = "s3cret-admin-token";
    const s = spy();
    const r = await post(makeHandler(s), "/api/orc/resonance/..%2Fetc", { headers: { authorization: "Bearer s3cret-admin-token" }, body: "{}" });
    assert.strictEqual(r.status, 400, `expected 400, got ${r.status}`);
  });

  for (const bad of ["../../etc/passwd", "a/b.mp3", "a\\b.mp3"]) {
    await check(`/api/queue refuses a path-shaped name: ${JSON.stringify(bad)}`, async () => {
      const s = spy();
      const r = await post(makeHandler(s), "/api/queue", { body: JSON.stringify({ filename: bad }) });
      assert.strictEqual(r.status, 400, `expected 400, got ${r.status}: ${r.body.slice(0, 100)}`);
      await settle();
      assert.deepStrictEqual(s.fired, [], `fired: ${s.fired.join(",")}`);
    });
  }
  await check("/api/queue still takes a bare library name", async () => {
    const s = spy();
    const r = await post(makeHandler(s), "/api/queue", { body: JSON.stringify({ filename: "01 - Song.mp3" }) });
    assert.strictEqual(r.status, 200, `expected 200, got ${r.status}: ${r.body.slice(0, 100)}`);
    await settle();
    assert.deepStrictEqual(s.fired, ["queue:01 - Song.mp3"]);
  });

  await check("/api/next?source=ended within 30 s of a track start is not a track end", async () => {
    delete process.env.KANNAKA_ICECAST_SOURCE;
    const s = spy();
    s.djEngine.state.trackStartedAt = Date.now() - 5000;
    const r = await post(makeHandler(s), "/api/next?source=ended");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(JSON.parse(r.body).reason, "too_early", r.body);
    await settle();
    assert.deepStrictEqual(s.fired, [], "the track must not advance");
  });
  await check("/api/next?source=ended after 30 s still advances (the natural end)", async () => {
    delete process.env.KANNAKA_ICECAST_SOURCE;
    const s = spy();
    s.djEngine.state.trackStartedAt = Date.now() - 45000;
    const r = await post(makeHandler(s), "/api/next?source=ended");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(JSON.parse(r.body).ok, true, r.body);
    await settle();
    assert.deepStrictEqual(s.fired, ["advance"]);
  });

  console.log(results.join("\n"));
  if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
  console.log("\nall passed");
})().catch((e) => { console.error(e); process.exit(1); });
