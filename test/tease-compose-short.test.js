/**
 * tease-compose-short.test.js — the hourly tease composes through the gateway
 * alias with a short prompt (2026-09-30), not through `kannaka ask`.
 *
 *   1. composeShort POSTs OpenAI-style chat completions to <gateway>/chat/completions
 *      with the alias as `model`, Bearer = the key `kannaka ask` already uses
 *      (config.toml `[llm]` api_key + base_url, or KANNAKA_RADIO_LLM_URL/KEY).
 *   2. It reads ONLY the `[llm]` section — a token in another section is not
 *      the gateway key.
 *   3. 20 s timeout by default, null on timeout / non-200 / short text; the
 *      per-slot budget (3 attempts) is the only retry policy.
 *   4. The tease prompt carries headline material only and stays ≈ ≤ 600
 *      tokens; operator paragraphs ("I recommend action_107") are dropped.
 *   5. RADIO_TEASE_VIA_ASK=1 keeps the old `kannaka ask` path for rollback.
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const http = require("http");
const EventEmitter = require("events");

const helpers = require("../server/lib/scheduler-helpers");
const { composeShort, gatewayConfig, resetSlotBudgets, slotExhausted } = helpers;
const { NewsTeaser, buildTeasePrompts, headlineMaterial, TEASE_ALIAS } = require("../server/news-teaser");

// ── Stubs ────────────────────────────────────────────────────────────────
const realHttps = https.request;
const realHttp = http.request;
const realWarn = console.warn;
const realLog = console.log;

let captured = [];
let responder = null; // (options, body) => { status, json } | "hang"
function stubRequest(options, cb) {
  const req = new EventEmitter();
  let body = "";
  let timeoutMs = null, onTimeout = null;
  req.setTimeout = (ms, fn) => { timeoutMs = ms; onTimeout = fn; return req; };
  req.write = (c) => { body += c; };
  req.destroy = (err) => { process.nextTick(() => req.emit("error", err || new Error("destroyed"))); };
  req.end = () => {
    captured.push({ options, body: JSON.parse(body), timeoutMs });
    const r = responder(options, JSON.parse(body));
    if (r === "hang") { setTimeout(() => onTimeout && onTimeout(), Math.min(timeoutMs || 20, 20)); return; }
    const res = new EventEmitter();
    res.statusCode = r.status;
    process.nextTick(() => { cb(res); res.emit("data", JSON.stringify(r.json)); res.emit("end"); });
  };
  return req;
}
https.request = stubRequest;
http.request = stubRequest;

let warnings = [], logs = [];
console.warn = (...a) => { warnings.push(a.join(" ")); };
console.log = (...a) => { logs.push(a.join(" ")); };

const ok200 = (text, usage = { prompt_tokens: 540, completion_tokens: 150, total_tokens: 690 }) => ({
  status: 200,
  json: { model: "ollama_chat/kannaka-brain-current", usage, choices: [{ message: { role: "assistant", content: text } }] },
});
const TEASE_TEXT = "Gene here. " + "The high-pressure block over Europe is still holding, and shipping in the North Sea has slowed with it. ".repeat(2) + "Full read at the five o'clock desk.";

const SAVED = {};
for (const k of ["KANNAKA_DATA_DIR", "KANNAKA_RADIO_LLM_URL", "KANNAKA_RADIO_LLM_KEY", "RADIO_TEASE_VIA_ASK", "ANTHROPIC_API_KEY", "KANNAKA_LLM_API_KEY"]) { SAVED[k] = process.env[k]; delete process.env[k]; }

function writeConfig(dir, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.toml"), body);
}
const GW_CFG = '[agent]\nid = "prime"\n\n[llm]\nprovider = "anthropic"\nmodel = "kannaka-claude-haiku"\napi_key = "sk-gateway-virtual-key-TEST"\nbase_url = "https://gateway.example/v1"\ntimeout_secs = "300"\n\n[ghostsignals]\ntoken = "gs-token-NOT-the-key"\n';

function restoreAll() {
  https.request = realHttps; http.request = realHttp;
  console.warn = realWarn; console.log = realLog;
  for (const [k, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

// The operator paragraph sits SECOND, well inside the 1100-char cap, so the
// filter (not the truncation) is what has to remove it.
const INTERP = {
  text: [
    "The observer-gene remains anchored in the mature Φ_0353 Atmospheric Stagnation regime with a stable 33-node cluster. Surface temperatures are elevated across dozens of urban weather grids (s_0010–s_0504) while wind vectors are suppressed. Maritime traffic in the North Sea shows reduced average speeds despite stable vessel counts.",
    "To better capture the sustained kinetic friction I recommend applying action_107 (adjust_decay.europe_air_count.slower) and action_109.",
    "This constitutes a genuine cross-domain correlation spanning weather, maritime, aviation and energy. " + "Grid loads across the EU and US are contracting, with electricity demand dipping in Europe but rising in the US. ".repeat(6),
    "This represents a direct continuation of the Φ_0353 regime documented over the last 19 lessons.",
  ].join("\n\n"),
  themes: ["Atmospheric Stagnation", "High-Pressure Blocking", "Grid Load Contraction"],
  confidence: 0.96,
};

let passed = 0, failed = 0;
async function test(name, fn) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kr-tease-short-"));
  resetSlotBudgets(); captured = []; warnings = []; logs = [];
  for (const k of ["KANNAKA_RADIO_LLM_URL", "KANNAKA_RADIO_LLM_KEY", "RADIO_TEASE_VIA_ASK"]) delete process.env[k];
  process.env.KANNAKA_DATA_DIR = scratch;
  responder = () => ok200(TEASE_TEXT);
  try { await fn(scratch); passed++; realLog(`  ok  ${name}`); }
  catch (e) { failed++; realLog(`  FAIL ${name}: ${e.message}`); }
  finally { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {} }
}

(async () => {
  realLog("tease-compose-short.test.js");

  await test("composeShort POSTs chat-completions to the [llm] gateway with the alias, Bearer key, system+user, max_tokens", async (scratch) => {
    writeConfig(scratch, GW_CFG);
    const meta = {};
    const text = await composeShort("kannaka-radio", "SYS", "USER", { maxTokens: 320, label: "tease", meta });
    assert.strictEqual(text, TEASE_TEXT);
    assert.strictEqual(captured.length, 1);
    const { options, body, timeoutMs } = captured[0];
    assert.strictEqual(options.hostname, "gateway.example");
    assert.strictEqual(options.path, "/v1/chat/completions");
    assert.strictEqual(options.method, "POST");
    assert.strictEqual(options.headers.Authorization, "Bearer sk-gateway-virtual-key-TEST");
    assert.strictEqual(body.model, "kannaka-radio");
    assert.deepStrictEqual(body.messages, [{ role: "system", content: "SYS" }, { role: "user", content: "USER" }]);
    assert.strictEqual(body.max_tokens, 320);
    assert.strictEqual(body.stream, false);
    assert.strictEqual(timeoutMs, 20000, "20 s default timeout");
    assert.strictEqual(meta.model, "ollama_chat/kannaka-brain-current");
    assert.deepStrictEqual(meta.usage, { prompt_tokens: 540, completion_tokens: 150, total_tokens: 690 });
    assert.ok(typeof meta.elapsedMs === "number");
  });

  await test("only the [llm] section is read: another section's token is never the gateway key; env overrides win", async (scratch) => {
    // Decoys BOTH before and after [llm]: a reader that ignores section
    // headers would pick the last one, a reader that stops at the first
    // api_key would pick the first — only section scoping yields sk-right.
    writeConfig(scratch, '[ghostsignals]\napi_key = "WRONG-before"\nbase_url = "https://wrong-before.example"\n\n[llm]\napi_key = "sk-right"\nbase_url = "https://right.example/v1/"\n\n[hub]\napi_key = "WRONG-after"\nbase_url = "https://wrong-after.example"\n');
    let gw = gatewayConfig();
    assert.deepStrictEqual(gw, { url: "https://right.example/v1", key: "sk-right" });
    process.env.KANNAKA_RADIO_LLM_URL = "http://127.0.0.1:4000/v1";
    process.env.KANNAKA_RADIO_LLM_KEY = "sk-env";
    gw = gatewayConfig();
    assert.deepStrictEqual(gw, { url: "http://127.0.0.1:4000/v1", key: "sk-env" });
    await composeShort("kannaka-radio", "S", "U", {});
    assert.strictEqual(captured[0].options.hostname, "127.0.0.1");
    assert.strictEqual(captured[0].options.port, "4000");
    assert.strictEqual(captured[0].options.headers.Authorization, "Bearer sk-env");
  });

  await test("no gateway configured → null + one warn, no request, and the tease falls back to the ask path", async (scratch) => {
    writeConfig(scratch, '[llm]\napi_key = "sk-direct-anthropic"\nmodel = "claude-haiku-4-5"\n'); // no base_url
    assert.strictEqual(gatewayConfig(), null);
    assert.strictEqual(await composeShort("kannaka-radio", "S", "U", { label: "tease" }), null);
    assert.strictEqual(captured.length, 0);
    assert.ok(warnings.some((w) => /no gateway configured/.test(w)));
  });

  await test("timeout → null (and counts as a spent attempt)", async (scratch) => {
    writeConfig(scratch, GW_CFG);
    responder = () => "hang";
    const meta = {};
    const t = await composeShort("kannaka-radio", "S", "U", { timeoutMs: 10, label: "tease", slot: "tease:T", meta });
    assert.strictEqual(t, null);
    assert.strictEqual(captured[0].timeoutMs, 10);
    assert.ok(warnings.some((w) => /gateway error.*timeout/.test(w)), warnings.join(" | "));
    assert.deepStrictEqual(helpers.slotAttempts("tease:T"), { primary: 1, direct: 0, gaveUp: false });
  });

  await test("non-200 → null with one warn; short text → null", async (scratch) => {
    writeConfig(scratch, GW_CFG);
    responder = () => ({ status: 400, json: { error: { message: "capped" } } });
    assert.strictEqual(await composeShort("kannaka-radio", "S", "U", { label: "tease" }), null);
    assert.ok(warnings.some((w) => /\[tease\] gateway 400 \(kannaka-radio\)/.test(w)));
    responder = () => ok200("too short");
    assert.strictEqual(await composeShort("kannaka-radio", "S", "U", { label: "tease", minLen: 80 }), null);
    assert.ok(warnings.some((w) => /short\/empty/.test(w)));
  });

  await test("per-slot budget: 3 gateway attempts, then null with no request and ONE give-up line; never Anthropic-direct", async (scratch) => {
    writeConfig(scratch, GW_CFG);
    responder = () => ({ status: 503, json: { error: "brain busy" } });
    const slot = "tease:2026-09-30T05-30";
    for (let i = 0; i < 6; i++) await composeShort("kannaka-radio", "S", "U", { label: "tease", slot });
    assert.strictEqual(captured.length, 3, "exactly three gateway attempts per slot");
    assert.ok(captured.every((c) => c.options.hostname === "gateway.example"), "no api.anthropic.com");
    assert.deepStrictEqual(warnings.filter((w) => /gave up/.test(w)), [`   [tease] slot ${slot} gave up after 3+0`]);
    assert.strictEqual(slotExhausted(slot), true);
  });

  await test("headlineMaterial drops operator paragraphs and cuts at a sentence within the cap", () => {
    const m = headlineMaterial(INTERP.text);
    assert.ok(!/action_\d+|recommend/i.test(m), "operator recommendation must not reach the anchor");
    assert.ok(m.length <= 1100, `material ${m.length} chars`);
    assert.ok(/[.!?]$/.test(m), "ends at a sentence boundary");
    assert.ok(m.startsWith("The observer-gene remains anchored"));
    assert.ok(m.includes("cross-domain correlation"), "the paragraph AFTER the dropped one is kept — filtered, not truncated");
    assert.strictEqual(headlineMaterial("Short news.\n\nI recommend applying action_107 now.\n\nMore news."), "Short news.\n\nMore news.");
    assert.strictEqual(headlineMaterial(""), "");
    assert.strictEqual(headlineMaterial("Only a recommendation: I recommend action_1."), "Only a recommendation: I recommend action_1.", "never reduce to nothing");
  });

  await test("buildTeasePrompts: headline material only, ≈ ≤ 600 tokens, carries themes + framing + the ID rule", () => {
    const { system, user } = buildTeasePrompts(INTERP, false, "Lead with the single biggest delta.");
    const total = system.length + user.length;
    assert.ok(total <= 2500, `short prompt is ${total} chars (~${Math.round(total / 4)} tokens) — must stay ≈ ≤ 600 tokens`);
    assert.ok(user.includes("Themes: Atmospheric Stagnation, High-Pressure Blocking, Grid Load Contraction."));
    assert.ok(user.includes("Framing: Lead with the single biggest delta."));
    assert.ok(!/action_10[79]/.test(user), "operator paragraph dropped");
    assert.ok(/symbol IDs/.test(system) && /Invent nothing/.test(system));
    assert.ok(/half-hour between bulletins/.test(user));
    const lead = buildTeasePrompts(INTERP, true, "x").user;
    assert.ok(/thirty minutes before a full bulletin/.test(lead));
  });

  await test("NewsTeaser._compose goes through composeShort → alias, and logs the brain path", async (scratch) => {
    writeConfig(scratch, GW_CFG);
    const t = new NewsTeaser({ kannakabin: process.execPath, voiceDJ: null, broadcast: () => {}, dataDir: scratch });
    const text = await t._compose(INTERP, false, "tease:X");
    assert.strictEqual(text, TEASE_TEXT);
    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].body.model, TEASE_ALIAS);
    assert.strictEqual(TEASE_ALIAS, "kannaka-radio");
    assert.ok(captured[0].body.messages[1].content.includes("INTERPRETATION:"));
    assert.ok(logs.some((l) => /\[tease\] brain path: kannaka-radio → ollama_chat\/kannaka-brain-current in \d+ms \(in=540 out=150\)/.test(l)), logs.join(" | "));
  });

  await test("RADIO_TEASE_VIA_ASK=1 → the old kannaka ask path (no gateway request), still slot-capped, never Anthropic-direct", async (scratch) => {
    writeConfig(scratch, GW_CFG);
    process.env.RADIO_TEASE_VIA_ASK = "1";
    const t = new NewsTeaser({ kannakabin: process.execPath, voiceDJ: null, broadcast: () => {}, dataDir: scratch });
    for (let i = 0; i < 4; i++) assert.strictEqual(await t._compose(INTERP, false, "tease:ASK"), null);
    assert.strictEqual(captured.length, 0, "rollback path makes no HTTP call of its own (kannaka ask does), and no Anthropic-direct");
    assert.ok(warnings.some((w) => /\[tease\] error \(code=/.test(w)), "kannaka ask attempted");
    assert.deepStrictEqual(warnings.filter((w) => /gave up/.test(w)), ["   [tease] slot tease:ASK gave up after 3+0"]);
  });

  restoreAll();
  if (failed) { console.error(`\n${failed} tease-compose-short test(s) FAILED`); process.exitCode = 1; }
  else console.log(`\nAll tease-compose-short tests passed (${passed})`);
})().catch((e) => { restoreAll(); console.error(e); process.exitCode = 1; });
