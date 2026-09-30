/**
 * tease-symbol-ids.test.js — no knowledge-gene symbol id reaches the anchor voice.
 *
 * The tease prompt has said "never read symbol IDs (Φ_0353, s_0190,
 * action_107) aloud" since the desk was built, and the 2026-09-30 brain-path
 * measurement still had 2 of 10 teases reading one. A prompt line is a request;
 * this is the guarantee, applied twice:
 *
 *   1. headlineMaterial() strips ids from what the model is shown, so there is
 *      nothing to copy.
 *   2. NewsTeaser._scrub() strips them from what the model returns, on both the
 *      gateway path and the `kannaka ask` rollback path, and logs how many.
 *
 * The id shape is 1–12 letters (Latin or Greek), an underscore, 2–5 digits,
 * standing alone. Ordinary words with underscores (snake_case_words) and
 * numbers without a letter prefix are left alone.
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { stripSymbolIds, headlineMaterial, NewsTeaser } = require("../server/news-teaser");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

console.log("tease-symbol-ids.test.js");

test("removes Latin- and Greek-prefixed ids and counts them", () => {
  const r = stripSymbolIds("Signal Φ_0353 climbed while action_107 waits; the Φ_0229 node and s_0504 held.");
  assert.strictEqual(r.removed, 4);
  assert.ok(!/[Φ]_\d|action_\d|s_\d/.test(r.text), r.text);
  assert.strictEqual(r.text, "Signal climbed while waits; the node and held.");
});

test("tidies the brackets and spacing an id leaves behind", () => {
  const r = stripSymbolIds("The cluster (s_0190) cooled , and Φ_0353 , too.");
  assert.strictEqual(r.removed, 2);
  assert.strictEqual(r.text, "The cluster cooled, and, too.");
});

test("leaves prose without ids byte-identical, with removed 0", () => {
  const src = "Plain words, snake_case_words, a year like 2026, and version 0.16.14 all stay.";
  const r = stripSymbolIds(src);
  assert.strictEqual(r.removed, 0);
  assert.strictEqual(r.text, src);
});

test("does not bite inside longer identifiers or after digits", () => {
  const r = stripSymbolIds("kannaka_radio_2026 stays; x_12345678 stays (too many digits); s_0190x stays (glued).");
  assert.strictEqual(r.removed, 0, r.text);
});

test("handles null and empty input", () => {
  assert.deepStrictEqual(stripSymbolIds(null), { text: "", removed: 0 });
  assert.deepStrictEqual(stripSymbolIds(""), { text: "", removed: 0 });
});

test("headlineMaterial shows the model no ids", () => {
  const out = headlineMaterial("Φ_0353 rose across the grid.\n\nI recommend action_107 for decay.\n\nThe s_0190 cluster cooled.");
  assert.ok(!/Φ_\d|s_\d|action_\d/.test(out), out);
  assert.ok(/rose across the grid/.test(out) && /cluster cooled/.test(out), out);
  assert.ok(!/recommend/.test(out), "operator paragraph still dropped");
});

test("_scrub cleans the returned text and logs one line; clean text is silent", () => {
  const t = Object.create(NewsTeaser.prototype);
  const logs = [];
  const realLog = console.log;
  console.log = (m) => logs.push(String(m));
  try {
    assert.strictEqual(t._scrub("Gene here. Φ_0353 and s_0190 moved."), "Gene here. and moved.");
    assert.strictEqual(t._scrub("Nothing to strip here."), "Nothing to strip here.");
    assert.strictEqual(t._scrub(null), null);
  } finally { console.log = realLog; }
  assert.deepStrictEqual(logs, ["   [tease] stripped 2 symbol ids from the tease text"]);
});

test("both compose paths route their result through _scrub", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server", "news-teaser.js"), "utf8");
  const gateway = src.indexOf("return this._scrub(text);");
  const ask = src.indexOf(".then((text) => this._scrub(text));");
  assert.ok(gateway > 0, "gateway path scrubs");
  assert.ok(ask > 0 && ask > gateway, "kannaka ask rollback path scrubs");
});

if (failed) { console.error(`\n${failed} tease-symbol-ids test(s) FAILED`); process.exitCode = 1; }
else console.log(`\nAll tease-symbol-ids tests passed (${passed})`);
