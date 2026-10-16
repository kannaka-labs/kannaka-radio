/**
 * disk-monitor-creds-off-argv.test.js — scripts/disk-monitor.sh must hand the
 * NATS credentials to `nats` through the environment, never on its command line.
 *
 * A command line is readable by every user on the box (`ps`, /proc/<pid>/cmdline);
 * the cron used to run `nats --user U --password P pub ...` whenever it alerted.
 * The nats CLI reads NATS_USER / NATS_PASSWORD from its environment, and the
 * script exports them from its env file with `set -a`.
 *
 * Drives the real script with a fake `nats` first on PATH that records its argv
 * and the NATS_PASSWORD it was given. DISK_ALERT_THRESHOLD=0 and a stale prune
 * log make both publish paths (disk alert and prune-stale alert) fire.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

let passed = 0;
let failed = 0;
function run(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

console.log("disk-monitor-creds-off-argv.test.js");

const SCRIPT = path.join(__dirname, "..", "scripts", "disk-monitor.sh");
const SENTINEL = "sentinel-pass-" + process.pid;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diskmon-"));
const bin = path.join(tmp, "bin");
const state = path.join(tmp, "state");
fs.mkdirSync(bin);
fs.mkdirSync(state);

const calls = path.join(tmp, "calls.log");
fs.writeFileSync(path.join(bin, "nats"),
  "#!/bin/bash\n" +
  `printf 'ARGV %s\\n' "$*" >> '${calls.replace(/\\/g, "/")}'\n` +
  `printf 'ENVPASS %s\\n' "\${NATS_PASSWORD:-}" >> '${calls.replace(/\\/g, "/")}'\n` +
  "exit 0\n", { mode: 0o755 });

const envFile = path.join(tmp, "nats.env");
fs.writeFileSync(envFile, `NATS_USER=sentinel-user\nNATS_PASSWORD=${SENTINEL}\n`, { mode: 0o600 });

const pruneLog = path.join(tmp, "prune-cron.log");
fs.writeFileSync(pruneLog, "");
const old = (Date.now() - 6 * 3600 * 1000) / 1000;
fs.utimesSync(pruneLog, old, old);

const toBash = (p) => p.replace(/\\/g, "/");
const res = spawnSync("bash", [toBash(SCRIPT)], {
  encoding: "utf8",
  env: {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    NATS_ENV: toBash(envFile),
    NATS_USER: "", NATS_PASSWORD: "",
    STATE_DIR: toBash(state),
    PRUNE_LOG: toBash(pruneLog),
    PRUNE_STALE_HOURS: "1",
    DISK_ALERT_THRESHOLD: "0",
  },
});

const log = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "";
const argvLines = log.split("\n").filter((l) => l.startsWith("ARGV "));
const envLines = log.split("\n").filter((l) => l.startsWith("ENVPASS "));

run("the script runs and calls nats for both alerts", () => {
  assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
  assert.strictEqual(argvLines.length, 2, `expected 2 nats calls, got:\n${log}`);
  assert.ok(argvLines.some((l) => / pub RADIO\.alert\.disk /.test(l)), "disk alert publish");
  assert.ok(argvLines.some((l) => / pub RADIO\.alert\.prune /.test(l)), "prune-stale publish");
});

run("no credential reaches nats's argv", () => {
  for (const l of argvLines) {
    assert.ok(!l.includes(SENTINEL), "password on argv");
    assert.ok(!/--password|--user|--creds/.test(l), `auth flag on argv: ${l.slice(0, 80)}`);
  }
});

run("the password reaches nats through its environment", () => {
  assert.strictEqual(envLines.length, 2);
  for (const l of envLines) assert.strictEqual(l, `ENVPASS ${SENTINEL}`);
});

run("the script source names no auth flag at all", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  assert.ok(!/--password|--user\b/.test(src.replace(/^\s*#.*$/gm, "")),
    "a --user/--password flag is back in disk-monitor.sh");
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
