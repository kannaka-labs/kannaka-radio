"use strict";
// lib/on-air-view: what listeners are told is playing, and the seam timing that
// lets the player paint it when THEIR audio gets there (2026-10-13: the text
// changed seconds before the song, and never changed for an oration).
const assert = require("assert");
const { onAirView, stateView, streamLatencyHintSec } = require("../server/lib/on-air-view");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e && e.message}`); }
}
console.log("\non-air-view.test.js");

const song = { file: "A/1.mp3", title: "One", album: "A" };
const next = { file: "B/2.mp3", title: "Two", album: "B" };
const voice = { path: "/tmp/oration.mp3", label: "Peace Oration, noon", kind: "oration", startedAt: 1000 };

check("engine and stream agree: the engine's track, nothing next", () => {
  assert.deepStrictEqual(onAirView(song, song, null), { current: song, upNext: null, swapPending: false });
});
check("stream still on the old song while the engine loaded a show: the song is current, the show next", () => {
  assert.deepStrictEqual(onAirView(next, song, null), { current: song, upNext: next, swapPending: true });
});
check("a voice item on air wins over both, with the engine's track next", () => {
  const v = onAirView(song, song, voice);
  assert.strictEqual(v.voice, true);
  assert.deepStrictEqual(v.current, { title: "Peace Oration, noon", album: "Kannaka Radio", file: "/tmp/oration.mp3", kind: "oration", voice: true });
  assert.strictEqual(v.upNext, song);
});
check("a voice object without a path is not a voice item", () => {
  assert.strictEqual(onAirView(song, song, { label: "x" }).voice, undefined);
});

check("the latency hint is the Icecast burst at the mount's bit rate, overridable by env", () => {
  assert.strictEqual(streamLatencyHintSec({}), 4.1);
  assert.strictEqual(streamLatencyHintSec({ KANNAKA_STREAM_BURST_BYTES: "128000", KANNAKA_STREAM_BITRATE: "128000" }), 8);
});

function engine(current, trackStartedAt = 500, channel = "dj") {
  return { getState: () => ({ current, trackStartedAt, channel }) };
}
function source({ onAir = null, startedAt = null, voice: v = null } = {}) {
  return { onAirTrack: () => onAir, onAirStartedAt: () => startedAt, onAirVoice: () => v };
}

check("stateView: the seam time is the engine's when stream and engine agree", () => {
  const s = stateView(engine(song), source({ onAir: song, startedAt: 900 }), 5000, {});
  assert.strictEqual(s.current, song);
  assert.strictEqual(s.onAirStartedAt, 900, "the stream's own start wins when it is playing the engine's track");
  assert.strictEqual(s.serverNow, 5000);
  assert.strictEqual(s.streamLatencyHintSec, 4.1);
});
check("stateView: a pending swap reports the stream's track and ITS start, not the engine's", () => {
  const s = stateView(engine(next, 4000), source({ onAir: song, startedAt: 900 }), 5000, {});
  assert.strictEqual(s.current, song);
  assert.strictEqual(s.swapPending, true);
  assert.strictEqual(s.onAirStartedAt, 900);
});
check("stateView: a voice item is current and its own start is the seam", () => {
  const s = stateView(engine(song, 500), source({ onAir: song, startedAt: 900, voice }), 5000, {});
  assert.strictEqual(s.voice, true);
  assert.strictEqual(s.current.title, "Peace Oration, noon");
  assert.strictEqual(s.onAirStartedAt, 1000);
});
check("stateView: off the dj channel the stream is ignored and the engine's timing stands", () => {
  const s = stateView(engine(next, 4000, "music"), source({ onAir: song, startedAt: 900, voice }), 5000, {});
  assert.strictEqual(s.current, next);
  assert.strictEqual(s.voice, false);
  assert.strictEqual(s.onAirStartedAt, 4000);
});
check("stateView: no icecast source at all still works", () => {
  const s = stateView(engine(song, 500), null, 5000, {});
  assert.strictEqual(s.current, song);
  assert.strictEqual(s.onAirStartedAt, 500);
});

console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
process.exit(failures ? 1 : 0);
