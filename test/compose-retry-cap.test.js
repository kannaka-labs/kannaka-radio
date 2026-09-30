/**
 * compose-retry-cap.test.js — composeResilient spends at most 3 primary + 1
 * direct attempts per slot, then gives up with ONE log line (2026-09-30).
 *
 * Every segment scheduler ticks every 30 s inside its retry window and, before
 * this, called compose on every tick until it got text: during the Anthropic
 * account cap of 2026-09-28..30 that was up to 30 `kannaka ask` attempts plus
 * 30 Anthropic-direct attempts per slot (~700 HTTP-400 calls a day). The
 * direct-Anthropic fallback is also OPT-IN now — tease/news/gossip never fall
 * to api.anthropic.com; only a caller passing `allowDirect: true` does.
 *
 * The primary path is exercised for real: `kannakabin` is node itself, so
 * `node ask --no-tools ...` fails fast ("Cannot find module ask") on every
 * platform, which is exactly a failed `kannaka ask`. The direct path is a
 * stubbed https.request that answers 400.
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const EventEmitter = require("events");

const helpers = require("../server/lib/scheduler-helpers");
const { composeResilient, slotExhausted, slotAttempts, resetSlotBudgets, SLOT_CAP } = helpers;

// ── Stubs ────────────────────────────────────────────────────────────────
const realRequest = https.request;
const realWarn = console.warn;
const realHomedir = os.homedir;

let directCalls = 0;
https.request = (options, cb) => {
  directCalls += 1;
  const req = new EventEmitter();
  req.setTimeout = () => req;
  req.write = () => {};
  req.destroy = () => {};
  req.end = () => {
    const res = new EventEmitter();
    res.statusCode = 400;
    process.nextTick(() => {
      cb(res);
      res.emit("data", JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "capped" } }));
      res.emit("end");
    });
  };
  return req;
};

let warnings = [];
console.warn = (...a) => { warnings.push(a.join(" ")); };

// A config.toml with an api_key so the direct path is actually attempted.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kr-retry-cap-"));
fs.writeFileSync(path.join(scratch, "config.toml"), '[llm]\napi_key = "sk-test-not-real"\nmodel = "claude-haiku-4-5"\n');
const SAVED = {};
for (const k of ["ANTHROPIC_API_KEY", "KANNAKA_LLM_API_KEY", "KANNAKA_DATA_DIR"]) { SAVED[k] = process.env[k]; delete process.env[k]; }
process.env.KANNAKA_DATA_DIR = scratch;

function restoreAll() {
  https.request = realRequest;
  console.warn = realWarn;
  os.homedir = realHomedir;
  for (const [k, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {}
}

const NODE = process.execPath; // `node ask ...` → exit 1 fast: a failed kannaka ask
const PROMPT = "compose something";
const giveUps = () => warnings.filter((w) => /gave up after/.test(w));

let passed = 0, failed = 0;
async function test(name, fn) {
  resetSlotBudgets(); warnings = []; directCalls = 0;
  try { await fn(); passed++; realWarn(`  ok  ${name}`); }
  catch (e) { failed++; realWarn(`  FAIL ${name}: ${e.message}`); }
}

(async () => {
  realWarn("compose-retry-cap.test.js");

  await test("the cap is 3 primary + 1 direct", () => {
    assert.deepStrictEqual({ ...SLOT_CAP }, { primary: 3, direct: 1 });
  });

  await test("allowDirect: a failing slot spends exactly 3 primary + 1 direct, then ONE give-up line", async () => {
    const slot = "test:2026-09-30T02-30";
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await composeResilient(NODE, PROMPT, { label: "tease", slot, allowDirect: true, timeoutMs: 20000 }));
    }
    assert.deepStrictEqual(results, [null, null, null, null, null, null]);
    assert.deepStrictEqual(slotAttempts(slot), { primary: 3, direct: 1, gaveUp: true });
    assert.strictEqual(directCalls, 1, "direct Anthropic must be attempted exactly once per slot");
    assert.deepStrictEqual(giveUps(), [`   [tease] slot ${slot} gave up after 3+1`]);
    assert.strictEqual(slotExhausted(slot), true);
  });

  await test("default (no allowDirect): never touches Anthropic-direct; give-up reads 3+0", async () => {
    const slot = "news:2026-09-30T07";
    for (let i = 0; i < 5; i++) await composeResilient(NODE, PROMPT, { label: "news", slot });
    assert.strictEqual(directCalls, 0, "tease/news/gossip must not fall to api.anthropic.com");
    assert.deepStrictEqual(slotAttempts(slot), { primary: 3, direct: 0, gaveUp: true });
    assert.deepStrictEqual(giveUps(), [`   [news] slot ${slot} gave up after 3+0`]);
    assert.ok(!warnings.some((w) => /falling back to direct Anthropic/.test(w)), "no fallback warn without opt-in");
  });

  await test("the give-up line fires on the failing attempt that spends the budget, not a tick later", async () => {
    const slot = "gossip:2026-09-30T04";
    await composeResilient(NODE, PROMPT, { label: "gossip", slot });
    await composeResilient(NODE, PROMPT, { label: "gossip", slot });
    assert.strictEqual(giveUps().length, 0, "two of three attempts: not given up yet");
    assert.strictEqual(slotExhausted(slot), false);
    await composeResilient(NODE, PROMPT, { label: "gossip", slot });
    assert.strictEqual(giveUps().length, 1);
    assert.strictEqual(slotExhausted(slot), true);
  });

  await test("an exhausted slot returns null without spawning or logging anything more", async () => {
    const slot = "tease:2026-09-30T03-30";
    for (let i = 0; i < 3; i++) await composeResilient(NODE, PROMPT, { label: "tease", slot });
    const before = warnings.length;
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) assert.strictEqual(await composeResilient(NODE, PROMPT, { label: "tease", slot }), null);
    assert.ok(Date.now() - t0 < 500, "no child process is spawned once the slot has given up");
    assert.strictEqual(warnings.length, before, "silent after the one give-up line");
    assert.deepStrictEqual(slotAttempts(slot), { primary: 3, direct: 0, gaveUp: true });
  });

  await test("slots are independent: one slot giving up does not touch another", async () => {
    for (let i = 0; i < 4; i++) await composeResilient(NODE, PROMPT, { label: "tease", slot: "tease:A" });
    await composeResilient(NODE, PROMPT, { label: "tease", slot: "tease:B" });
    assert.strictEqual(slotExhausted("tease:A"), true);
    assert.strictEqual(slotExhausted("tease:B"), false);
    assert.deepStrictEqual(slotAttempts("tease:B"), { primary: 1, direct: 0, gaveUp: false });
  });

  await test("no slot (manual trigger): one primary attempt, direct only when opted in, no budget kept", async () => {
    assert.strictEqual(await composeResilient(NODE, PROMPT, { label: "manual" }), null);
    assert.strictEqual(directCalls, 0);
    assert.strictEqual(await composeResilient(NODE, PROMPT, { label: "manual", allowDirect: true }), null);
    assert.strictEqual(directCalls, 1);
    assert.strictEqual(giveUps().length, 0, "nothing to give up on without a slot");
    assert.strictEqual(slotAttempts(undefined), null);
  });

  await test("slotExhausted is false for an unknown slot", () => {
    assert.strictEqual(slotExhausted("never-seen"), false);
    assert.strictEqual(slotExhausted(null), false);
  });

  restoreAll();
  if (failed) { console.error(`\n${failed} compose-retry-cap test(s) FAILED`); process.exitCode = 1; }
  else console.log(`\nAll compose-retry-cap tests passed (${passed})`);
})().catch((e) => { restoreAll(); console.error(e); process.exitCode = 1; });
