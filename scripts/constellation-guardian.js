#!/usr/bin/env node
/**
 * constellation-guardian — defensive adversarial-activity monitor.
 *
 * Philosophy: the constellation is grounded in peaceful, helping foundations,
 * but its surfaces are still exposed to bad actors. This watcher detects abuse
 * patterns on our OWN infrastructure and applies TIME-LIMITED, transparent
 * mitigation — never permanent punishment, never offensive action. Bans drop
 * web ports (80/443) only via the `kannaka_threats` ipset; SSH is untouched
 * (fail2ban owns that), so a false positive self-heals and never locks anyone
 * out of management.
 *
 * Sources : nginx access log + spacechild-auth journal (failed logins).
 * Detects : path scanners, auth credential-stuffing, 429 floods.
 * Mitigates: `sudo firewall-cmd --ipset=kannaka_threats --add-entry=<ip>`
 *            (firewalld nftables-backed sets; skipped in DRY_RUN; allowlisted
 *            IPs are never banned). Bans escalate for a repeat offender: the
 *            first is 1 hour (kannaka_threats), the second 1 day
 *            (kannaka_threats_day), the third and later 1 week
 *            (kannaka_threats_week). Each set carries its own timeout, so every
 *            ban still ends by itself. Strikes are forgotten after 30 quiet days.
 * Publishes: per-threat + summary entities into Flux (constellation observability)
 *            so the Observatory can render the security posture alongside Phi.
 *
 * Env: FLUX_URL, FLUX_TOKEN, FLUX_NAMESPACE (default pure-jade),
 *      GUARDIAN_DRY_RUN=1 to observe-only, NGINX_ACCESS_LOG path override.
 */
"use strict";

const https = require("https");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const pathMod = require("path");

const FLUX_URL = process.env.FLUX_URL || "https://api.flux-universe.com";
const FLUX_TOKEN = process.env.FLUX_TOKEN || "";
const NS = process.env.FLUX_NAMESPACE || "pure-jade";
const DRY_RUN = process.env.GUARDIAN_DRY_RUN === "1";
const ACCESS_LOG = process.env.NGINX_ACCESS_LOG || "/var/log/nginx/access.log";

// Never ban ourselves, the witness box, or loopback. Add trusted IPs here.
const ALLOWLIST = new Set([
  "127.0.0.1",
  "::1",
  "170.9.238.136", // ninjaportal (self)
  "170.9.241.14",  // witness
]);

// Sensitive paths a real visitor never requests — a strong scanner signal.
const SCANNER_PATTERNS = [
  /\/\.env/i, /\/\.git/i, /\/\.aws/i, /\/\.ssh/i, /wp-admin/i, /wp-login/i,
  /xmlrpc\.php/i, /phpmyadmin/i, /\/vendor\//i, /\/\.well-known\/(?!acme)/i,
  /\/config\.(php|json|yml)/i, /\/actuator/i, /\/solr/i, /\/cgi-bin/i,
  /\/owa\//i, /\/console/i, /\/\.DS_Store/i, /eval\(/i, /\/boaform/i,
  // Added 2026-11-17. On 2026-11-16 one address made about 5,400 probing
  // requests after its first ban lapsed and was caught only once more, because
  // none of what it sent matched the list above: path traversal, script and
  // template injection, SQL fragments.
  /etc\/passwd/i, /\.\.(\/|\\|%2f|%5c)/i, /%252e|%2e%2e/i,
  /<script|%3Cscript|onerror\s*=|onerror%3D/i, /\{\{|%7B%7B|\$\{|%24%7B/i,
  /union(\s|%20|\+)+select|;(\s|%20)*select/i,
];
const AUTH_PATHS = [/\/auth\/login/i, /\/api\/space-child-auth\/login/i, /\/auth\/register/i];

// Detection rules: window (ms), threshold, reason. Ban duration comes from
// the offender's strike count (see LADDER). Conservative thresholds on purpose.
const RULES = {
  scanner:   { windowMs: 5 * 60_000, threshold: 6,   reason: "path-scanning" },
  authBrute: { windowMs: 10 * 60_000, threshold: 12, reason: "auth-brute-force" },
  flood:     { windowMs: 2 * 60_000, threshold: 240,  reason: "request-flood" },
};

/** Per-IP sliding event timestamps. */
const ips = new Map(); // ip -> { scanner:[], authFail:[], all:[], firstSeen, banned, banExpires, reason }
const PRUNE_MS = 15 * 60_000;

function rec(ip) {
  let r = ips.get(ip);
  if (!r) { r = { scanner: [], authFail: [], all: [], firstSeen: Date.now(), banned: false }; ips.set(ip, r); }
  return r;
}
function within(arr, windowMs, now) {
  const cut = now - windowMs;
  while (arr.length && arr[0] < cut) arr.shift();
  return arr.length;
}

// The ladder. Each rung is a firewalld set with its own timeout; an entry
// inherits it, so no ban needs anything to lift it.
const LADDER = [
  { set: "kannaka_threats", ttlS: 3600 },
  { set: "kannaka_threats_day", ttlS: 86400 },
  { set: "kannaka_threats_week", ttlS: 7 * 86400 },
];
const STRIKE_MEMORY_MS = 30 * 86400 * 1000;
const STRIKES_FILE = process.env.GUARDIAN_STRIKES_FILE || pathMod.join(os.homedir(), ".kannaka", "guardian-strikes.json");

/** ip -> { n, last }. Kept on disk so a restart does not forgive a repeat offender. */
let strikes = {};
try { strikes = JSON.parse(fs.readFileSync(STRIKES_FILE, "utf8")) || {}; } catch (_e) { strikes = {}; }
function saveStrikes() {
  try {
    fs.mkdirSync(pathMod.dirname(STRIKES_FILE), { recursive: true });
    fs.writeFileSync(STRIKES_FILE + ".tmp", JSON.stringify(strikes));
    fs.renameSync(STRIKES_FILE + ".tmp", STRIKES_FILE);
  } catch (e) { console.error("[guardian] could not save strikes:", e.message); }
}
/** Count this ban and return the rung it earns. Pure apart from the map it is given. */
function nextRung(map, ip, now) {
  const s = map[ip];
  const n = s && now - s.last < STRIKE_MEMORY_MS ? s.n + 1 : 1;
  map[ip] = { n, last: now };
  return { n, rung: LADDER[Math.min(n, LADDER.length) - 1] };
}
function pruneStrikes(map, now) {
  let dropped = 0;
  for (const ip of Object.keys(map)) if (now - map[ip].last >= STRIKE_MEMORY_MS) { delete map[ip]; dropped++; }
  return dropped;
}

function ban(ip, rule, now) {
  const r = rec(ip);
  const { n, rung } = nextRung(strikes, ip, now);
  saveStrikes();
  const BAN_TTL_S = rung.ttlS;
  r.banned = true;
  r.banExpires = now + BAN_TTL_S * 1000;
  r.reason = rule.reason;
  r.strikes = n;
  const human = new Date(now).toISOString();
  if (DRY_RUN) {
    console.log(`[guardian] WOULD ban ${ip} (${rule.reason}) @ ${human}`);
  } else {
    // firewalld nftables-backed set; the entry inherits that set's timeout.
    const p = spawn("sudo", ["firewall-cmd", `--ipset=${rung.set}`, `--add-entry=${ip}`]);
    p.on("close", (code) => {
      console.log(`[guardian] ${code === 0 ? "BANNED" : "ban-FAILED(" + code + ")"} ${ip} (${rule.reason}) strike=${n} set=${rung.set} ttl=${BAN_TTL_S}s`);
    });
    p.on("error", (e) => console.error(`[guardian] ban error for ${ip}:`, e.message));
  }
  publishThreat(ip, r, now);
}

function consider(ip, now) {
  if (ALLOWLIST.has(ip)) return;
  const r = rec(ip);
  if (r.banned && r.banExpires > now) return; // already serving a ban
  if (within(r.scanner, RULES.scanner.windowMs, now) >= RULES.scanner.threshold) return ban(ip, RULES.scanner, now);
  if (within(r.authFail, RULES.authBrute.windowMs, now) >= RULES.authBrute.threshold) return ban(ip, RULES.authBrute, now);
  if (within(r.all, RULES.flood.windowMs, now) >= RULES.flood.threshold) return ban(ip, RULES.flood, now);
}

// ---- Flux publishing (defensive observability) -------------------------------
function fluxPost(entityId, properties) {
  if (!FLUX_TOKEN) return;
  const body = JSON.stringify({
    stream: "security", source: "constellation-guardian", timestamp: Date.now(),
    payload: { entity_id: entityId, properties },
  });
  const u = new URL(FLUX_URL + "/api/events");
  const req = https.request(
    { host: u.host, path: u.pathname, method: "POST", timeout: 10_000,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Authorization: "Bearer " + FLUX_TOKEN } },
    (res) => res.resume()
  );
  req.on("error", () => {});
  req.on("timeout", () => req.destroy());
  req.end(body);
}
function publishThreat(ip, r, now) {
  // entity id keys on a sanitized IP; no PII beyond the source address itself.
  fluxPost(`${NS}/threat-${ip.replace(/[.:]/g, "-")}`, {
    type: "threat", ip, reason: r.reason || "observed", banned: !DRY_RUN && r.banned,
    dry_run: DRY_RUN, ban_expires: r.banExpires ? new Date(r.banExpires).toISOString() : null,
    strikes: r.strikes || 0,
    first_seen: new Date(r.firstSeen).toISOString(), last_seen: new Date(now).toISOString(),
  });
}
function publishSummary() {
  const now = Date.now();
  let active = 0;
  for (const [, r] of ips) if (r.banned && r.banExpires > now) active++;
  fluxPost(`${NS}/constellation-security`, {
    type: "summary", active_bans: active, tracked_ips: ips.size,
    mode: DRY_RUN ? "observe" : "active", swept_at: new Date(now).toISOString(),
  });
}

// ---- Log ingestion -----------------------------------------------------------
// Common log format: '<ip> - <user> [<time>] "<method> <path> <proto>" <status> ...'
const CLF = /^(\S+) \S+ \S+ \[[^\]]+\] "(\S+) (\S+)[^"]*" (\d{3})/;
function onAccessLine(line) {
  const m = CLF.exec(line);
  if (!m) return;
  const now = Date.now();
  const ip = m[1], path = m[3], status = parseInt(m[4], 10);
  if (ALLOWLIST.has(ip)) return;
  const r = rec(ip);
  r.all.push(now);
  if (SCANNER_PATTERNS.some((re) => re.test(path))) r.scanner.push(now);
  if (status === 429) r.all.push(now); // floods double-count 429 toward flood rule
  if (status >= 400 && AUTH_PATHS.some((re) => re.test(path))) r.authFail.push(now);
  consider(ip, now);
}

function tailFile(path, onLine) {
  // tail -F survives logrotate; -n0 ignores history on start.
  const t = spawn("tail", ["-F", "-n", "0", path]);
  let buf = "";
  t.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  t.stderr.on("data", (d) => console.error("[guardian] tail:", d.toString().trim()));
  t.on("close", (code) => {
    console.error(`[guardian] tail ${path} exited (${code}); restarting in 5s`);
    setTimeout(() => tailFile(path, onLine), 5000);
  });
}

// Prune idle IPs so memory stays bounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, r] of ips) {
    const idle = now - Math.max(r.firstSeen, r.all[r.all.length - 1] || 0);
    if (!r.banned && idle > PRUNE_MS && r.all.length === 0) ips.delete(ip);
    if (r.banned && r.banExpires && r.banExpires < now) ips.delete(ip);
  }
}, 60_000).unref();
setInterval(publishSummary, 60_000).unref();
setInterval(() => { if (pruneStrikes(strikes, Date.now())) saveStrikes(); }, 3600_000).unref();

if (require.main !== module) {
  // Loaded by a test: export the pure parts and start nothing.
  module.exports = { LADDER, STRIKE_MEMORY_MS, nextRung, pruneStrikes, SCANNER_PATTERNS };
  return;
}

console.log(`[guardian] starting — mode=${DRY_RUN ? "OBSERVE (dry-run)" : "ACTIVE"} flux=${FLUX_TOKEN ? "on" : "off"} log=${ACCESS_LOG}`);
tailFile(ACCESS_LOG, onAccessLine);
publishSummary();
