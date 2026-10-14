"use strict";
// The /player page holds a now-playing change until this listener's audio
// reaches the server's seam (2026-10-13: the text changed before the song did).
// Runs the REAL onAirDisplayDelayMs() out of workspace/index.html, and checks
// that applyState routes its painting through it.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const INDEX = fs.readFileSync(path.join(__dirname, "..", "workspace", "index.html"), "utf8");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e && e.message}`); }
}
function functionSource(name) {
  const start = INDEX.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `${name} not found in index.html`);
  let i = INDEX.indexOf("{", start), depth = 0;
  for (let j = i; j < INDEX.length; j++) {
    if (INDEX[j] === "{") depth++;
    else if (INDEX[j] === "}") { depth--; if (depth === 0) return INDEX.slice(start, j + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}
console.log("\nplayer-on-air-delay.test.js");

const delay = new Function(`${functionSource("onAirDisplayDelayMs")}; return onAirDisplayDelayMs;`)();

check("a fresh seam is held for the whole latency: burst plus what the page has buffered", () => {
  assert.strictEqual(delay(10_000, 10_000, 4.1, 2.4), 6500);
});
check("an older seam is held for what remains, never negative", () => {
  assert.strictEqual(delay(10_000, 13_000, 4.1, 2.4), 3500);
  assert.strictEqual(delay(10_000, 30_000, 4.1, 2.4), 0);
});
check("no timing from the server, or a page not playing /stream (null buffer), paints at once", () => {
  assert.strictEqual(delay(null, 13_000, 4.1, 2.4), 0);
  assert.strictEqual(delay(10_000, null, 4.1, 2.4), 0);
  assert.strictEqual(delay(10_000, 10_000, 4.1, null), 0);
  assert.strictEqual(delay(10_000, 10_000, 4.1, undefined), 0);
});
check("a zero buffer still honours the burst; a future seam counts as age 0", () => {
  assert.strictEqual(delay(10_000, 10_000, 4.1, 0), 4100);
  assert.strictEqual(delay(10_000, 9_000, 4.1, 0), 4100);
});

check("applyState paints the now-playing text through the delay, and clears the previous hold", () => {
  const src = functionSource("applyState");
  assert.ok(/onAirDisplayDelayMs\(s\.onAirStartedAt, s\.serverNow, s\.streamLatencyHintSec, liveBufferedAheadSec\(\)\)/.test(src), "delay computed from the server's seam timing and the page's buffer");
  assert.ok(/clearTimeout\(_npPaintTimer\)/.test(src), "an earlier pending paint is cancelled");
  assert.ok(/setTimeout\(paintNowPlaying, npDelay\)/.test(src), "the paint is deferred by the delay");
  assert.ok(/else paintNowPlaying\(\)/.test(src), "and painted at once when there is nothing to wait for");
  assert.ok(/setTimeout\(function\(\) \{ updateMediaSession\(c, s\); \}, msDelay\)/.test(src), "the lock-screen metadata is held by the same delay");
  assert.ok(!/^\s*updateMediaSession\(c, s\);\s*$/m.test(src), "and never painted unconditionally");
});
check("liveBufferedAheadSec reports null when not on /stream and the buffered-ahead seconds when it is", () => {
  const fn = new Function("document", `${functionSource("liveBufferedAheadSec")}; return liveBufferedAheadSec;`);
  const mk = (a) => fn({ getElementById: () => a })();
  assert.strictEqual(mk(null), null);
  assert.strictEqual(mk({ paused: true, src: "/stream", buffered: { length: 0 } }), null);
  assert.strictEqual(mk({ paused: false, src: "/x.mp3", buffered: { length: 0 } }), null);
  assert.strictEqual(mk({ paused: false, src: "https://radio/stream", buffered: { length: 0 } }), 0);
  assert.strictEqual(mk({ paused: false, currentSrc: "https://radio/stream", currentTime: 10, buffered: { length: 1, end: () => 12.5 } }), 2.5);
});

console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
process.exit(failures ? 1 : 0);
