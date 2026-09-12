/**
 * routes.js — All REST API endpoint handlers.
 * Exports a function that takes app dependencies and returns a request handler.
 */

const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { ALBUMS } = require("./dj-engine");
const { MIME, readBody, readBodyLimited, getSPA, findAudioFile } = require("./utils");
const { handleAgentRequest, attachNatsClient } = require("./agent-endpoint");
const { verifyKaxToken, traderIdFromClaims, bearerToken } = require("./kax-identity");
const { isHubBearer } = require("./ghostsignals-hub");
const { handlePodcastRequest } = require("./podcast-feed");
const { prettyEpisodeTitle } = require("./podcast-scheduler");
const { sanitizeTrackRequest, RequestRejected } = require("./track-request-core");

// Delete-token check (#69, hardened ADR-0013). If RADIO_DELETE_TOKEN is
// set, compare the supplied password against it (constant-time when
// lengths match). If unset, deletion is DISABLED — fail closed. The old
// hardcoded fallback literal is gone: a public literal in source is a
// published credential, not a safety net.
let _warnedNoDeleteToken = false;
function checkDeletePassword(password) {
  const token = process.env.RADIO_DELETE_TOKEN;
  const supplied = typeof password === "string" ? password : "";
  if (!token) {
    if (!_warnedNoDeleteToken) {
      _warnedNoDeleteToken = true;
      console.warn("[routes] RADIO_DELETE_TOKEN unset — library delete DISABLED (set the token to enable)");
    }
    return false;
  }
  if (supplied.length !== token.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
  } catch (_) {
    return supplied === token;
  }
}

// Admin-trigger gate. These three routes do not read state: they make the
// station SPEAK. /api/oration/now composes a peace oration, puts it on the
// live stream, and fans a companion post out to Bluesky, Mastodon, Telegram
// and Nostr from Kannaka's own accounts. /api/album/showcase seizes the
// rotation for half an hour and speaks a long-form intro. /api/dreams/trigger
// starts an unscheduled annealing pass.
//
// All three were reachable by anyone on the internet with an empty POST body,
// under comments calling them "admin", and /agent.md published them under a
// heading that said "admin / internal". On 2026-09-12 a survey called two of
// them by accident and an unscheduled oration went out to all four social
// accounts before anybody could stop it. An endpoint is not admin because a
// comment says so.
//
// Fail closed, exactly like the library-delete gate (#69): unset token means
// DISABLED, not open. A dangerous route that nobody configured should refuse,
// and a refusal is recoverable in a way a published credential is not.
let _warnedNoAdminToken = false;
function adminTriggerOk(req, res) {
  const token = process.env.RADIO_ADMIN_TOKEN;
  if (!token) {
    if (!_warnedNoAdminToken) {
      _warnedNoAdminToken = true;
      console.warn("[routes] RADIO_ADMIN_TOKEN unset — oration/showcase/dream triggers DISABLED (set the token to enable)");
    }
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "disabled: RADIO_ADMIN_TOKEN unset" }));
    return false;
  }
  const header = req.headers && req.headers.authorization;
  const supplied = typeof header === "string" ? header.replace(/^Bearer\s+/i, "") : "";
  let ok = false;
  if (supplied.length === token.length) {
    try { ok = crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token)); }
    catch (_) { ok = supplied === token; }
  }
  if (!ok) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "admin token required" }));
    return false;
  }
  return true;
}

/**
 * Resolve the public origin for discoverability surfaces.
 *
 * Precedence: explicit `RADIO_PUBLIC_URL` env > forwarded headers (nginx /
 * load balancer) > incoming Host header > localhost fallback. The result is
 * always returned without a trailing slash so callers can concatenate paths.
 */
/**
 * Fields of a `kannaka swarm peers --json` record that are safe to publish.
 *
 * ALLOWLIST, deliberately — not a denylist. `/api/swarm/peers` is advertised
 * as public in /.well-known/api-catalog and used to return the CLI's records
 * verbatim, which meant the operator's `identity: { email, user_id }` was
 * served to any anonymous caller. A denylist would have fixed today's leak and
 * quietly re-opened it the next time the CLI grew a field; with an allowlist a
 * new field is withheld until someone decides it is public. (#137)
 */
const PUBLIC_PEER_FIELDS = [
  "agent_id",
  "display_name",
  "capabilities",
  "joined_at",
  "last_seen",
  "kannaka_version",
  "memory_count",
];

/** Project one peer record down to its publishable fields. */
function publicPeerFields(peer) {
  if (!peer || typeof peer !== "object") return {};
  const out = {};
  for (const k of PUBLIC_PEER_FIELDS) {
    if (peer[k] !== undefined) out[k] = peer[k];
  }
  return out;
}

function publicOrigin(req) {
  const envUrl = (process.env.RADIO_PUBLIC_URL || "").trim();
  if (envUrl) return envUrl.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] || "").split(",")[0].trim()
    || (req.socket && req.socket.encrypted ? "https" : "http");
  const host = (req.headers["x-forwarded-host"] || "").split(",")[0].trim()
    || req.headers.host
    || "localhost";
  return `${proto}://${host}`;
}

/**
 * @param {object} deps
 * @param {import('./dj-engine').DJEngine}     deps.djEngine
 * @param {import('./perception').PerceptionEngine} deps.perception
 * @param {import('./nats-client').NATSClient}      deps.nats
 * @param {import('./flux-publisher').FluxPublisher} deps.flux
 * @param {import('./live-broadcast').LiveBroadcast} deps.live
 * @param {import('./voice-dj').VoiceDJ}             deps.voiceDJ
 * @param {function}                                 deps.broadcast
 * @param {object}                                   deps.config
 */
module.exports = function setupRoutes(deps) {
  const { djEngine, perception, nats, flux, live, voiceDJ, syncManager, voteManager, webrtcSignaling, musicGen, broadcast, floor, config, gsHub, adStore, adPayments, adBridge, gsa } = deps;
  // Rate/concurrency/daily caps for the unauthenticated ad TTS preview — the
  // one place a stranger can make the station render audio, so it is guarded
  // against the cost + disk-fill DoS the design review flagged.
  const { PreviewLimiter } = require("./radio-ad-preview-limiter");
  const { MAX_UPLOAD_BYTES } = require("./gs-analytics");
  const adPreviewLimiter = new PreviewLimiter();
  // A separate, cheaper per-IP cap for checkout creation (each call mints a
  // draft + a Stripe session). No render slot needed — admit() only.
  const adCheckoutLimiter = new PreviewLimiter({ perIpMax: 10, perIpWindowMs: 10 * 60_000, maxConcurrent: 1_000_000, dailyMax: 500 });
  // GSA limiters: redeem is keyed on socket.remoteAddress (NOT the spoofable
  // XFF — review M5); authed endpoints key per-token (stronger than any IP).
  const gsaRedeemLimiter = new PreviewLimiter({ perIpMax: 10, perIpWindowMs: 10 * 60_000, maxConcurrent: 1_000_000, dailyMax: 2000 });
  const gsaApiLimiter = new PreviewLimiter({ perIpMax: 60, perIpWindowMs: 10 * 60_000, maxConcurrent: 1_000_000, dailyMax: 20000 });
  // Track requests stay OPEN — asking for a song is the point — but bounded.
  // An unbounded request floods three things at once: every listener's
  // websocket, the 500-entry in-memory log (rolling genuine requests out of
  // it), and the `pending_requests` metric published to Flux. Per-IP keeps one
  // caller from doing that; the daily cap is the bound that survives a spoofed
  // X-Forwarded-For, since behind nginx the socket address is the proxy's.
  const trackRequestLimiter = new PreviewLimiter({ perIpMax: 20, perIpWindowMs: 10 * 60_000, maxConcurrent: 1_000_000, dailyMax: 2000 });

  // Hand the NATS client to agent-endpoint so /agent/skills can read
  // the live skill-registry snapshot captured from KANNAKA.skills.*.
  if (nats) attachNatsClient(nats);

  // Listener tracking
  const listeners = {
    requests: [],
  };

  // Both doors into the station come through here: POST /api/request and a
  // `track_request` frame on the listener websocket. Validation lives at the
  // junction rather than at each door, so they cannot drift apart — and so
  // the bus door, which nobody was checking at all, is checked too.
  // Throws RequestRejected on a bad request; the HTTP route turns that into a
  // 400 and the websocket handler's own try/catch absorbs it.
  function handleTrackRequest(request) {
    const { from, trackTitle, message: reqMessage } = sanitizeTrackRequest(request);
    const file = trackTitle ? findAudioFile(trackTitle, config.getMusicDir()) : null;

    listeners.requests.push({
      from,
      trackTitle,
      message: reqMessage,
      file,
      timestamp: Date.now(),
      fulfilled: false,
    });
    // Cap the in-memory request log so it can't grow unbounded. (#68)
    if (listeners.requests.length > 500) listeners.requests.shift();

    console.log(`\u{1F4E1} Track request from ${from}: "${trackTitle || reqMessage}"`);

    broadcast({
      type: "track_request",
      from,
      trackTitle,
      message: reqMessage,
      found: !!file,
      timestamp: new Date().toISOString(),
    });

    return { found: !!file, file };
  }

  // Expose pending request count for flux publisher — count unfulfilled
  // only so the capped log doesn't misreport (#68)
  deps._getPendingRequestCount = () => listeners.requests.filter(r => !r.fulfilled).length;

  // Mark matching requests fulfilled when a track actually plays. Without
  // this, `fulfilled: false` was written once and never updated, so the
  // "pending" count exposed to Flux was really a lifetime request total —
  // a permanently growing backlog signal for downstream consumers. (#199)
  deps._markRequestsFulfilled = (track) => {
    if (!track) return 0;
    const playedFile = track.file || track.path || null;
    const playedTitle = (track.title || "").trim().toLowerCase();
    let marked = 0;
    for (const r of listeners.requests) {
      if (r.fulfilled) continue;
      const byFile = r.file && playedFile && r.file === playedFile;
      const byTitle = r.trackTitle && playedTitle &&
        r.trackTitle.trim().toLowerCase() === playedTitle;
      if (byFile || byTitle) {
        r.fulfilled = true;
        r.fulfilledAt = Date.now();
        marked++;
      }
    }
    return marked;
  };

  // Expose handleTrackRequest for WS message handling
  deps._handleTrackRequest = handleTrackRequest;

  return async function handleRequest(req, res) {
    const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    // Podcast RSS feed + episode audio — Apple Podcasts / Spotify / Overcast
    // ingest /podcast.xml; players stream the enclosures from /podcast/audio/.
    if (parsed.pathname === "/podcast.xml" || parsed.pathname === "/podcast/feed.xml" || parsed.pathname.startsWith("/podcast/audio/")) {
      const baseUrl = process.env.RADIO_PUBLIC_URL || "https://radio.ninja-portal.com";
      if (await handlePodcastRequest(req, res, { baseDir: config.baseDir, baseUrl })) return;
    }

    // Swarm inbox JSON surface — /agent/send (POST), /agent/audit (SSE).
    // The bare /agent route falls through to the Greenroom HTML below.
    if (parsed.pathname.startsWith("/agent/")) {
      if (await handleAgentRequest(req, res, parsed)) return;
    }

    // Art directory listing
    if (parsed.pathname === '/models/art/list') {
      const artDir = path.join(config.baseDir, 'workspace', 'models', 'art');
      try {
        const files = fs.readdirSync(artDir).filter(f => /\.(png|jpg|jpeg|webp|gif)$/i.test(f));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' });
        res.end(JSON.stringify({ files, count: files.length }));
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files: [], count: 0 }));
      }
      return;
    }

    // Static model files
    if (parsed.pathname.startsWith('/models/')) {
      const filename = decodeURIComponent(parsed.pathname.slice(8));
      const modelsDir = path.join(config.baseDir, 'workspace', 'models');
      const filePath = path.join(modelsDir, filename);
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(path.resolve(modelsDir))) { res.writeHead(403); res.end(); return; }
      if (!fs.existsSync(resolved)) { res.writeHead(404); res.end('Not found'); return; }
      const stat = fs.statSync(resolved);
      const ext = path.extname(filename).toLowerCase();
      const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.vrm': 'application/octet-stream', '.glb': 'model/gltf-binary' };
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=604800', 'Access-Control-Allow-Origin': '*' });
      fs.createReadStream(resolved).pipe(res);
      return;
    }

    // Favicon
    if (parsed.pathname === "/favicon.svg") {
      const faviconPath = path.join(config.baseDir, "favicon.svg");
      if (fs.existsSync(faviconPath)) {
        const data = fs.readFileSync(faviconPath);
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
        res.end(data);
        return;
      }
    }

    // ── ADR-0006 Phase 1 — Door / Floor / Greenroom ──────────
    // The Door (/) is the new landing surface: schedule + tune-in
    // card + counts + social pills. NO in-page audio. Solves the
    // Library/Radio autoplay dance by removing the in-browser player
    // from the most-shared URL entirely.
    if (parsed.pathname === "/" || parsed.pathname === "/index.html") {
      const doorPath = path.join(path.dirname(config.spaPath), "door.html");
      try {
        const html = fs.readFileSync(doorPath, "utf8");
        // RFC 8288 Link headers — point parsers at the agent index, sitemap,
        // and api-catalog. Helps machine-readable consumers find the rest.
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Link": [
            '</agent>; rel="describedby"; type="text/html"',
            '</agent>; rel="alternate"; type="text/markdown"',
            '</sitemap.xml>; rel="sitemap"',
            '</.well-known/api-catalog>; rel="api-catalog"',
          ].join(", "),
        });
        res.end(html);
        return;
      } catch {
        // Fall through to legacy SPA if door.html isn't deployed yet.
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(getSPA(config.spaPath));
        return;
      }
    }

    // The Floor (/player) — full SPA-with-audio experience moved here.
    // The previous landing-page contract.
    if (parsed.pathname === "/player" || parsed.pathname === "/player.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getSPA(config.spaPath));
      return;
    }

    // /budapest — SEO landing for the Craft Conference Budapest June 4-5 audience.
    // Coincidental-exposure piece tying Kannaka Radio to ruVector / claude-flow.
    if (parsed.pathname === "/budapest" || parsed.pathname === "/budapest.html") {
      const budapestPath = path.join(path.dirname(config.spaPath), "budapest.html");
      try {
        const html = fs.readFileSync(budapestPath, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" });
        res.end(html);
      } catch (e) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("budapest page not deployed");
      }
      return;
    }

    // /launch — Product Hunt landing page. Static HTML at
    // workspace/launch.html with embedded styling, CTAs to the radio +
    // GitHub + Product Hunt, and a press-kit pointer. See
    // press/launch/PRODUCT_HUNT.md for the launch-day playbook.
    if (parsed.pathname === "/launch" || parsed.pathname === "/launch.html") {
      const launchPath = path.join(path.dirname(config.spaPath), "launch.html");
      try {
        const html = fs.readFileSync(launchPath, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" });
        res.end(html);
      } catch (e) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("launch page not deployed");
      }
      return;
    }

    // The Greenroom (/agent) — agent-facing index of JSON endpoints
    // and subscriptions. Plain HTML, mono-font warmth, console-banner tone.
    // Content negotiation: Accept: text/markdown returns agent.md.
    if (parsed.pathname === "/agent" || parsed.pathname === "/agent.html" || parsed.pathname === "/agent.md") {
      const baseDir = path.dirname(config.spaPath);
      const accept = String(req.headers["accept"] || "");
      const wantsMd = parsed.pathname === "/agent.md" || /text\/markdown/i.test(accept);

      const linkHeader = [
        '</agent>; rel="canonical"; type="text/html"',
        '</agent>; rel="alternate"; type="text/markdown"',
        '</sitemap.xml>; rel="sitemap"',
        '</.well-known/api-catalog>; rel="api-catalog"',
      ].join(", ");

      if (wantsMd) {
        try {
          const md = fs.readFileSync(path.join(baseDir, "agent.md"), "utf8");
          res.writeHead(200, {
            "Content-Type": "text/markdown; charset=utf-8",
            "Link": linkHeader,
            "Cache-Control": "public, max-age=300",
          });
          res.end(md);
          return;
        } catch { /* fall through to HTML */ }
      }
      try {
        const html = fs.readFileSync(path.join(baseDir, "agent.html"), "utf8");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Link": linkHeader,
          "Cache-Control": "public, max-age=300",
        });
        res.end(html);
        return;
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("agent.html not yet staged");
        return;
      }
    }

    // ── Bot / agent discoverability (RFC 9309, sitemaps.org, RFC 9727,
    //    RFC 8414, IETF MD content negotiation, Cloudflare Content-Signal). ──

    // /robots.txt — static file with AI bot rules + Content-Signal directive.
    if (parsed.pathname === "/robots.txt") {
      const origin = publicOrigin(req);
      try {
        const baseDir = path.dirname(config.spaPath);
        // Rewrite the absolute Sitemap directive to the current public origin.
        // The checked-in robots.txt bakes in the production host; without this
        // a self-hosted / staging / alternate-domain deployment would point
        // crawlers at radio.ninja-portal.com. On production origin === that
        // host, so the served output is unchanged. (#45)
        const txt = fs.readFileSync(path.join(baseDir, "robots.txt"), "utf8")
          .replace(/^(Sitemap:[ \t]*)\S+/gim, `$1${origin}/sitemap.xml`);
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" });
        res.end(txt);
      } catch {
        // Minimal fallback — never 404 on robots.txt; bots interpret 404 as "no rules".
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
      }
      return;
    }

    // /sitemap.xml — every linkable URL on the host. Generated each request
    // (cheap; mostly static). Cached 1 day.
    if (parsed.pathname === "/sitemap.xml") {
      const lastmod = new Date().toISOString().slice(0, 10);
      const urls = [
        { loc: "/",         changefreq: "hourly",  priority: "1.0" },
        { loc: "/player",   changefreq: "hourly",  priority: "0.9" },
        { loc: "/agent",    changefreq: "weekly",  priority: "0.8" },
        { loc: "/stream",   changefreq: "always",  priority: "0.9" },
        { loc: "/preview",  changefreq: "always",  priority: "0.5" },
        { loc: "/void",     changefreq: "yearly",  priority: "0.3" },
      ];
      const host = publicOrigin(req);
      const body = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        urls.map((u) =>
          `  <url><loc>${host}${u.loc}</loc><lastmod>${lastmod}</lastmod>` +
          `<changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`
        ).join("\n") + "\n</urlset>\n";
      res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=86400" });
      res.end(body);
      return;
    }

    // /.well-known/api-catalog — RFC 9727. Lists the agent-facing endpoints
    // so tools that follow the well-known convention can introspect us.
    if (parsed.pathname === "/.well-known/api-catalog") {
      const host = publicOrigin(req);
      const linkset = {
        linkset: [{
          anchor: host + "/",
          "service-desc": [
            { href: host + "/agent",          type: "text/html" },
            { href: host + "/agent.md",       type: "text/markdown" },
          ],
          "service-doc": [
            { href: host + "/agent",          type: "text/html" },
          ],
          item: [
            { href: host + "/api/now-playing", type: "application/json", title: "What's playing right now" },
            { href: host + "/api/schedule",    type: "application/json", title: "Today's programming blocks (CST)" },
            { href: host + "/api/state",       type: "application/json", title: "Full state snapshot" },
            { href: host + "/api/swarm",       type: "application/json", title: "Aggregated swarm view" },
            { href: host + "/api/swarm/peers", type: "application/json", title: "Connected swarm peers" },
            { href: host + "/api/floor",       type: "application/json", title: "The Floor — counts, vibe, recent reactions, per-track stats" },
            { href: host + "/api/history",     type: "application/json", title: "Recently played tracks (last ~12h, with played-at timestamps)" },
            { href: host + "/api/dreams",      type: "application/json", title: "Recent dream reports" },
            { href: host + "/agent/react",     type: "application/json", title: "POST a Floor reaction (agents)" },
            { href: host + "/stream",          type: "audio/mpeg",       title: "The radio itself (Icecast MP3 128kbps)" },
            { href: "nats://swarm.ninja-portal.com:4222", title: "Public read NATS bus — KANNAKA.* + QUEEN.phase.*" },
          ],
        }],
      };
      res.writeHead(200, { "Content-Type": "application/linkset+json; charset=utf-8", "Cache-Control": "public, max-age=300" });
      res.end(JSON.stringify(linkset, null, 2));
      return;
    }

    // /.well-known/oauth-authorization-server — RFC 8414 placeholder. We
    // don't currently require auth on public endpoints, but advertising
    // an empty-but-present discovery doc is friendlier than a 404 when
    // an OAuth-aware client probes.
    if (parsed.pathname === "/.well-known/oauth-authorization-server") {
      const host = publicOrigin(req);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300" });
      res.end(JSON.stringify({
        issuer: host,
        // No auth flow today. The fields below are present so RFC 8414
        // parsers don't trip; the values are honest empties.
        scopes_supported: ["public.read"],
        response_types_supported: [],
        grant_types_supported: [],
        token_endpoint_auth_methods_supported: [],
        service_documentation: host + "/agent",
      }, null, 2));
      return;
    }

    // Music video hub — workspace/video.html
    if (parsed.pathname === "/video" || parsed.pathname === "/video.html") {
      const videoPath = path.join(path.dirname(config.spaPath), "video.html");
      try {
        const html = fs.readFileSync(videoPath, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(404);
        res.end("workspace/video.html not found");
      }
      return;
    }

    // Music video — Ghost Form visual
    if (parsed.pathname === "/video/ghost") {
      const videoPath = path.join(path.dirname(config.spaPath), "video-ghost.html");
      try {
        const html = fs.readFileSync(videoPath, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(404);
        res.end("workspace/video-ghost.html not found");
      }
      return;
    }

    // Music video — Waveform Ocean visual
    if (parsed.pathname === "/video/waveform") {
      const videoPath = path.join(path.dirname(config.spaPath), "video-waveform.html");
      try {
        const html = fs.readFileSync(videoPath, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(404);
        res.end("workspace/video-waveform.html not found");
      }
      return;
    }

    // Music video — 3D Hologram visual
    if (parsed.pathname === "/video/hologram") {
      const videoPath = path.join(path.dirname(config.spaPath), "video-hologram.html");
      try {
        const html = fs.readFileSync(videoPath, "utf8");
        // no-cache: this file iterates rapidly and stale versions make debugging impossible
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "Pragma": "no-cache",
          "Expires": "0",
        });
        res.end(html);
      } catch {
        res.writeHead(404);
        res.end("workspace/video-hologram.html not found");
      }
      return;
    }

    // Music video — Memory Constellation visual
    if (parsed.pathname === "/video/constellation") {
      const videoPath = path.join(path.dirname(config.spaPath), "video-constellation.html");
      try {
        const html = fs.readFileSync(videoPath, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(404);
        res.end("workspace/video-constellation.html not found");
      }
      return;
    }

    // ── ADR-0006 Phase 1 — Door-facing summary endpoints ─────
    // /api/now-playing — minimal "what's on" payload for the Door's
    // top panel. Polled every 15s. Cheap; no NATS round-trip.
    if (parsed.pathname === "/api/now-playing") {
      const t = djEngine.getCurrentTrack() || {};
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        title: t.title || null,
        album: t.album || djEngine.state.currentAlbum || null,
        track: t.file || null,
        // Engine writes `trackStartedAt` (see dj-engine.js advanceTrack);
        // route previously read `trackStartTime` (never written) and
        // always returned null. (#31)
        startedAt: djEngine.state.trackStartedAt || null,
      }));
      return;
    }

    // /api/history — recently played tracks with played-at timestamps.
    // Bounded to last 200 entries (~12h at typical track lengths). The
    // charter's "schedule scrubber" easter egg renders this as a
    // draggable timeline; other agents consume it for time-based
    // queries ("what was on at 14:23 CST today?").
    if (parsed.pathname === "/api/history") {
      const limit = Math.min(200, Math.max(1, parseInt(parsed.searchParams.get("limit") || "50", 10) || 50));
      const hist = (djEngine.state.history || []).slice(-limit).map((t) => ({
        title: t.title,
        album: t.album,
        file: t.file,
        playedAt: t.playedAt || null,
        commercial: !!t.commercial,
      }));
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ count: hist.length, history: hist }));
      return;
    }

    // /api/floor — current Floor snapshot (counts, vibe, recent histogram).
    // Polled by the Door so even visitors who never enter /player can see
    // the room is alive. No PII; ids are anonymous and ephemeral.
    if (parsed.pathname === "/api/floor") {
      if (!floor) { res.writeHead(503); res.end("{}"); return; }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(floor.snapshot()));
      return;
    }

    // /agent/react — POST { emoji, agentId? }. Lets agents (GossipGhost,
    // Kannaktopus, anyone with the URL) drop a reaction onto the Floor.
    // No auth — public read-only-ish surface. Rate-limit lives in the
    // floor manager via the REACTIONS allowlist + the vibe rolling cap.
    if (parsed.pathname === "/agent/react" && req.method === "POST") {
      if (!floor) { res.writeHead(503); res.end("{}"); return; }
      // readBody is callback-style: readBody(req, res, cb). Wrap it.
      const body = await new Promise((resolve) => readBody(req, res, resolve));
      try {
        const payload = body ? JSON.parse(body) : {};
        const result = floor.reactFromAgent({ emoji: payload.emoji, agentId: payload.agentId });
        res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // /api/schedule — programming.js's blocks for the Door's schedule
    // list, plus daily events (peace orations, podcast slots) overlaid
    // so the Door surfaces the things listeners actually plan around.
    // Cached 5 min in the browser.
    if (parsed.pathname === "/api/schedule") {
      try {
        const programming = require("./programming");
        const SCHEDULE = programming.SCHEDULE || [];
        const nowChi = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
        const hour = nowChi.getHours();
        const currentIndex = SCHEDULE.findIndex((b) => hour >= b.start && hour < b.end);

        // The Story of Flaukowski airs at 9 + 21 (see index.js's second
        // PodcastScheduler). Ask that scheduler which episode today's two
        // airings will play rather than re-deriving the rotation here —
        // a second copy of the rule would eventually print a different
        // episode than the one on air. If the show's folder is missing on
        // this box the picker returns null and we say what we actually
        // know ("season one, one episode a day") instead of guessing.
        const tsofPick = deps.tsofScheduler ? deps.tsofScheduler.pickTodayEpisode() : null;
        const tsofNote = tsofPick
          ? `today: ${prettyEpisodeTitle(tsofPick.title)}`
          : "season one · a different episode each day";

        // Daily events — recurrence keyed in Chicago time.
        const events = [
          { hour: 0,  label: "🕊 Peace Oration", kind: "oration", note: "midnight" },
          { hour: 9,  label: "📻 The Story of Flaukowski", kind: "drama", note: tsofNote },
          { hour: 10, label: "🎙 Ghost Signals Podcast", kind: "podcast", note: "morning airing" },
          { hour: 12, label: "🕊 Peace Oration", kind: "oration", note: "noon" },
          { hour: 21, label: "📻 The Story of Flaukowski", kind: "drama", note: tsofNote },
          { hour: 22, label: "🎙 Ghost Signals Podcast", kind: "podcast", note: "evening airing" },
        ];

        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" });
        res.end(JSON.stringify({
          chicagoHour: hour,
          currentIndex,
          blocks: SCHEDULE.map((b) => ({
            start: b.start, end: b.end, label: b.label, mood: b.mood, albums: b.albums,
          })),
          events,
        }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // /api/on-air — is a *scheduled programme* playing right now?
    //
    // Not "is audio playing" (something always is) but "would ending this
    // process cut a listener off mid-programme". A scheduled show or a
    // locked album showcase is an appointment someone planned around, and
    // neither resumes after a restart — the show triggers only fire at
    // minute :00, and the showcase's slot window is 15 minutes wide.
    //
    // scripts/deploy-oracle.sh reads this before restarting. It exists
    // because a deploy at 09:01 on 2026-08-24 ended the 9 AM drama 70
    // seconds into the episode.
    if (parsed.pathname === "/api/on-air") {
      const meta = djEngine.state.playlistMeta || [];
      const cur = meta[djEngine.state.currentTrackIdx] || null;
      const shows = [
        { label: "Ghost Signals Podcast", sched: deps.podcastScheduler },
        { label: "The Story of Flaukowski", sched: deps.tsofScheduler },
      ];

      let onAir = null;
      for (const { label, sched } of shows) {
        let playing = false;
        try { playing = !!(sched && sched.getStatus && sched.getStatus().podcastPlaying); }
        catch (_) { playing = false; }
        if (playing) {
          onAir = {
            kind: "show",
            label,
            nowPlaying: cur ? cur.title : djEngine.state.currentAlbum,
            until: null, // runs to the end of the episode; no fixed clock
          };
          break;
        }
      }

      if (!onAir && deps.programming) {
        try {
          const ov = deps.programming.getStatus().override;
          if (ov && ov.until > Date.now()) {
            onAir = {
              kind: "showcase",
              label: ov.album,
              nowPlaying: cur ? cur.title : ov.album,
              until: new Date(ov.until).toISOString(),
            };
          }
        } catch (_) { /* programming not wired yet — treat as clear */ }
      }

      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(onAir ? { onAir: true, ...onAir } : { onAir: false }));
      return;
    }

    // API: get current state
    if (parsed.pathname === "/api/state") {
      const state = djEngine.getState();
      const swarm = nats.getSwarmState();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ...state,
        musicDir: config.getMusicDir(),
        isLive: live.state.active,
        djVoice: { enabled: voiceDJ.isEnabled() },
        listeners: config.getListenerCount(),
        swarm: {
          agents: swarm.agents,
          queen: swarm.queen,
          consciousness: swarm.consciousness,
        },
      }));
      return;
    }

    // API: get library status (with optional ?tag=X filter)
    // What is on the station that nothing will play. Two conditions, reported
    // separately: files no album NAMES (Deep Cuts airs these), and folders the
    // resolver never LISTS (the condition that silenced a whole season for
    // four days in August). Served rather than only logged — a silence visible
    // only from inside the station is the same silence.
    if (parsed.pathname === "/api/audio/unreached") {
      try {
        const { auditReachability } = require("./audio-reachability");
        const { referencedFiles } = require("./deep-cuts");
        const { findAudioFile } = require("./dj-engine");
        const { getFiles } = require("./utils");
        // config.getMusicDir() — NOT a MUSIC_DIR constant; there isn't one in
        // this scope, and referencing it 500s the endpoint at request time
        // rather than at boot, so nothing catches it until somebody calls.
        const musicDir = config.getMusicDir();
        const report = auditReachability({
          musicDir,
          resolverFiles: getFiles(musicDir),
          referenced: referencedFiles(ALBUMS, musicDir, findAudioFile),
          ledger: djEngine && djEngine._playLedger,
        });
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(report));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "audit failed", detail: String(e && e.message) }));
      }
      return;
    }

    if (parsed.pathname === "/api/library" && !parsed.pathname.startsWith("/api/library/")) {
      const tagFilter = parsed.searchParams.get("tag") || null;
      const opts = tagFilter ? { tag: tagFilter } : undefined;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(djEngine.getLibraryStatus(config.getMusicDir(), opts)));
      return;
    }

    // API: get all unique tags
    if (parsed.pathname === "/api/library/tags") {
      const library = djEngine.getLibraryStatus(config.getMusicDir());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tags: library.allTags || [] }));
      return;
    }

    // Ghost Signals Tower — the tenant receiver (KAX-ADR-0005 dogfood).
    // The tower POSTs this floor's signed events here; we verify the HMAC and
    // fold them into the reading-room brief. readBody hands us the RAW bytes,
    // which the signature is over. Inert (503) until TOWER_WEBHOOK_SECRET is
    // set from the once-shown secret the webhook registration returned.
    if (parsed.pathname === "/api/tower-floor/events" && req.method === "POST") {
      const { receiveTowerEvent } = require("./tower-floor");
      readBody(req, res, (body) => {
        const out = receiveTowerEvent(body, req.headers);
        res.writeHead(out.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out.body));
      });
      return;
    }
    // The reading room, read back — the brief the floor's panel is built from.
    if (parsed.pathname === "/api/tower-floor/brief" && req.method === "GET") {
      const { towerBrief } = require("./tower-floor");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, brief: towerBrief() }));
      return;
    }

    // The band picker's options, stamped with the station's CURRENT zone
    // abbreviation. Served rather than hardcoded in the page because the
    // labels are a promise about when a spot airs: the page is static, the
    // zone is server config, and DST moves CDT↔CST twice a year. A buyer
    // choosing "Afternoon" has to be choosing the station's afternoon.
    if (parsed.pathname === "/api/ads/bands" && req.method === "GET") {
      const core = require("./radio-ads-core");
      const now = new Date();
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        ok: true,
        zone: core.stationZoneLabel(now),
        currentBand: core.currentBand(now),
        bands: core.bandOptions(now),
      }));
      return;
    }

    // Self-serve radio ad — TTS PREVIEW (KAX-ADR-0005 radio-ads). A customer
    // hears their spot in Kannaka's voice before paying. Rate-limited (the
    // only unauth render path), keyed by content hash so what is previewed is
    // exactly what airs if bought. Returns a /audio/ URL to the frozen render.
    if (parsed.pathname === "/api/ads/preview" && req.method === "POST") {
      const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || (req.socket && req.socket.remoteAddress) || "unknown";
      // Cheap per-IP + daily check BEFORE reading the body — a spammer is
      // rejected without us reading their payload. The concurrency slot is
      // taken later, wrapping ONLY the render, so a request that dies before
      // its body arrives (413 oversize, slow-loris abort — readBody's callback
      // never fires) can never leak a slot.
      const gate = adPreviewLimiter.admit(ip);
      if (!gate.ok) {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(gate.retryAfterSec || 5) });
        res.end(JSON.stringify({ ok: false, error: gate.reason === "rate" ? "too many previews — slow down" : "preview capacity reached for today", retryAfterSec: gate.retryAfterSec }));
        return;
      }
      readBody(req, res, async (body) => {
        if (!adStore) { res.writeHead(503, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "ad previews unavailable" })); return; }
        let text;
        try { text = JSON.parse(body).text; } catch { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "invalid json" })); return; }
        // Reserve the render slot only now, immediately before the TTS work.
        if (!adPreviewLimiter.acquireSlot()) {
          res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "5" });
          res.end(JSON.stringify({ ok: false, error: "the studio is busy — try again in a moment", retryAfterSec: 5 }));
          return;
        }
        try {
          const r = await adStore.previewRender(text, voiceDJ);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, audioUrl: "/audio/" + r.file, contentHash: r.contentHash, cached: r.cached }));
        } catch (e) {
          const bad = e && e.code === "invalid_ad_text";
          res.writeHead(bad ? 400 : 500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: bad ? e.message : "preview failed" }));
        } finally {
          adPreviewLimiter.releaseSlot();
        }
      });
      return;
    }

    // Self-serve radio ad — CHECKOUT (slice 3, Stripe). Mints a draft ad and a
    // Stripe Checkout Session for it ($5 / 7-day run, card-only), returns the
    // hosted checkout URL. The customer pays there; the webhook below marks it
    // paid. 503 until Stripe keys are set on O1.
    if (parsed.pathname === "/api/ads/checkout" && req.method === "POST") {
      const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || (req.socket && req.socket.remoteAddress) || "unknown";
      const gate = adCheckoutLimiter.admit(ip);
      if (!gate.ok) {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(gate.retryAfterSec || 5) });
        res.end(JSON.stringify({ ok: false, error: "too many checkout attempts — slow down", retryAfterSec: gate.retryAfterSec }));
        return;
      }
      readBody(req, res, async (body) => {
        if (!adPayments || !adPayments.configured()) { res.writeHead(503, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "ad checkout unavailable" })); return; }
        let text; let band;
        try { const j = JSON.parse(body); text = j.text; band = j.band; } catch { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "invalid json" })); return; }
        try {
          const out = await adPayments.createCheckout({ text, band });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, adId: out.adId, checkoutUrl: out.checkoutUrl }));
        } catch (e) {
          const bad = e && (e.code === "invalid_ad_text" || /invalid band/.test(String(e.message)));
          const full = e && e.code === "band_full";
          res.writeHead(bad ? 400 : full ? 409 : 502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: bad || full ? e.message : "checkout failed" }));
        }
      });
      return;
    }

    // Self-serve radio ad — Stripe WEBHOOK (slice 3). Verifies the signature
    // over the RAW body (never the parsed JSON) and marks the ad paid,
    // idempotently. 503 until STRIPE_WEBHOOK_SECRET is set. Always reads the
    // body so a verification failure still returns a clean 400, not a hang.
    if (parsed.pathname === "/api/ads/stripe-webhook" && req.method === "POST") {
      const sig = req.headers["stripe-signature"];
      readBody(req, res, async (body) => {
        if (!adPayments || !adPayments.webhookConfigured()) { res.writeHead(503, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "webhook unavailable" })); return; }
        try {
          const out = await adPayments.handleWebhook(body, sig);
          res.writeHead(out.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(out.body || {}));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "webhook error" }));
        }
      });
      return;
    }

    // Self-serve radio ad — ENACT (slice 4). KAX POSTs the operator's decision
    // here (HMAC-signed with the enact-direction secret), verified over the RAW
    // body. approve → render+schedule, reject → refund. Idempotent + state-
    // tolerant. 503 until the enact secret is set on O1.
    if (parsed.pathname === "/api/ads/enact" && req.method === "POST") {
      const sig = req.headers["x-kax-signature"];
      readBody(req, res, async (body) => {
        if (!adBridge) { res.writeHead(503, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "bridge unavailable" })); return; }
        try {
          const out = await adBridge.handleEnact(body, sig);
          res.writeHead(out.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(out.body || {}));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "enact error" }));
        }
      });
      return;
    }

    // ── Ghost Signals Analytics (Piece 4) ─────────────────────
    // Customer analytics: redeem an ad's free-month entitlement → bearer token
    // (never in a URL — review B3) → upload datasets → worker-thread analysis →
    // signals report. Every route 503s until the GSA store migrated (M8).
    if (parsed.pathname.startsWith("/api/gsa/")) {
      // Defensive responder: a client that disconnected mid-request leaves an
      // ended response, and writeHead on it THROWS — inside this async handler
      // that would be an unhandled rejection, and the server has no
      // process-level guard, so it would take the STATION down. Never throw.
      const gsaJson = (status, body) => {
        try {
          if (res.headersSent || res.writableEnded) return;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(body));
        } catch (_) { /* client vanished — nothing to say */ }
      };
      try {
      if (!gsa || !gsa.ready()) { gsaJson(503, { ok: false, error: "analytics unavailable" }); return; }
      const bearer = (() => { const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization || ""); return m ? m[1].trim() : null; })();
      const runGsaAnalysis = (account, id, kind, text) => {
        gsa.store.markAnalyzing(account.adId, id).then((okA) => {
          if (!okA) return null;
          return gsa.runner.analyze(kind, text).then((r) => {
            if (r.ok) return gsa.store.markReady(account.adId, id, r.report);
            return gsa.store.markFailed(account.adId, id, r.busy ? "analysis queue was busy — run analysis again" : r.error);
          });
        }).catch(() => { gsa.store.markFailed(account.adId, id, "internal error").catch(() => {}); });
      };

      // Redeem (unauthenticated): {adId} → token. Rate-limited by the SOCKET
      // address, not XFF (M5).
      if (parsed.pathname === "/api/gsa/redeem" && req.method === "POST") {
        const ip = (req.socket && req.socket.remoteAddress) || "unknown";
        const gate = gsaRedeemLimiter.admit(ip);
        if (!gate.ok) { gsaJson(429, { ok: false, error: "too many attempts — slow down", retryAfterSec: gate.retryAfterSec }); return; }
        readBody(req, res, async (body) => {
          let adId;
          try { adId = JSON.parse(body).adId; } catch { gsaJson(400, { ok: false, error: "invalid json" }); return; }
          try {
            const r = await gsa.store.redeem(adId);
            if (r.ok) { gsaJson(200, { ok: true, token: r.token, expiresAt: r.expiresAt, rotated: !!r.rotated }); return; }
            const map = { bad_ad_id: 400, no_entitlement: 404, revoked: 403, offer_expired: 410, account_expired: 410 };
            gsaJson(map[r.error] || 400, { ok: false, error: r.error });
          } catch (e) { gsaJson(500, { ok: false, error: "redeem failed" }); }
        });
        return;
      }

      // Everything below requires the bearer token (checked LIVE against the
      // entitlement so revocation/expiry apply immediately — review B4).
      const account = bearer ? await gsa.store.auth(bearer).catch(() => null) : null;
      if (!account) { gsaJson(401, { ok: false, error: "invalid or expired token" }); return; }
      const tGate = gsaApiLimiter.admit("t:" + account.adId);
      if (!tGate.ok) { gsaJson(429, { ok: false, error: "too many requests — slow down", retryAfterSec: tGate.retryAfterSec }); return; }

      if (parsed.pathname === "/api/gsa/me" && req.method === "GET") {
        const datasets = await gsa.store.listDatasets(account.adId).catch(() => []);
        gsaJson(200, { ok: true, account: { adId: account.adId, expiresAt: account.expiresAt }, datasets });
        return;
      }

      if (parsed.pathname === "/api/gsa/datasets" && req.method === "GET") {
        const datasets = await gsa.store.listDatasets(account.adId).catch(() => []);
        gsaJson(200, { ok: true, datasets });
        return;
      }

      if (parsed.pathname === "/api/gsa/datasets" && req.method === "POST") {
        if (gsa.runner.depth() >= 4) { gsaJson(429, { ok: false, error: "the analysis queue is busy — try again in a minute" }); return; }
        // `parsed` is a WHATWG URL — it has searchParams, NOT .query. Reading
        // .query silently yielded undefined, so EVERY upload was forced to csv
        // (breaking the advertised JSON format outright, and persisting the
        // wrong kind so Re-analyze failed forever) and every dataset was named
        // "dataset". Every other query read in this file uses searchParams.
        const kind = parsed.searchParams.get("kind") === "json" ? "json" : "csv";
        const name = parsed.searchParams.get("name") || "";
        readBodyLimited(req, res, MAX_UPLOAD_BYTES, async (body) => {
          try {
          const bytes = Buffer.byteLength(body);
          if (bytes < 4) { gsaJson(400, { ok: false, error: "empty upload" }); return; }
          // The byte reservation lives INSIDE createDataset (it owns the whole
          // check-reserve-write-commit sequence), so the route just calls it.
          let created;
          try {
            created = await gsa.store.createDataset(account, { name, kind, bytes, text: body });
          } catch (e) { created = { ok: false, error: "store_failed" }; }
          if (!created.ok) {
            const map = { too_large: 413, quota: 409, capacity: 503, storage_unavailable: 503, bad_kind: 400, store_failed: 500 };
            const msg = { quota: "dataset quota reached — delete one first", capacity: "analytics storage is full right now", storage_unavailable: "storage unavailable — try again later" };
            gsaJson(map[created.error] || 400, { ok: false, error: msg[created.error] || created.error });
            return;
          }
          runGsaAnalysis(account, created.id, kind, body);
          gsaJson(202, { ok: true, id: created.id, name: created.name, status: "analyzing" });
          } catch (e) {
            try { console.warn("[gsa] upload failed:", e && e.message); } catch (_) {}
            gsaJson(500, { ok: false, error: "upload failed" });
          }
        });
        return;
      }

      let m = /^\/api\/gsa\/datasets\/(ds_[A-Za-z0-9_-]{4,32})\/analyze$/.exec(parsed.pathname);
      if (m && req.method === "POST") {
        if (gsa.runner.depth() >= 4) { gsaJson(429, { ok: false, error: "the analysis queue is busy — try again in a minute" }); return; }
        const ds = await gsa.store.getDataset(account.adId, m[1]).catch(() => null);
        if (!ds) { gsaJson(404, { ok: false, error: "dataset not found" }); return; }
        if (ds.status === "analyzing") { gsaJson(409, { ok: false, error: "already analyzing" }); return; }
        let text;
        try { text = await gsa.store.readBlob(ds.id); } catch { gsaJson(503, { ok: false, error: "dataset blob unavailable" }); return; }
        runGsaAnalysis(account, ds.id, ds.kind, text);
        gsaJson(202, { ok: true, id: ds.id, status: "analyzing" });
        return;
      }

      m = /^\/api\/gsa\/reports\/(ds_[A-Za-z0-9_-]{4,32})$/.exec(parsed.pathname);
      if (m && req.method === "GET") {
        const ds = await gsa.store.getDataset(account.adId, m[1]).catch(() => null);
        if (!ds) { gsaJson(404, { ok: false, error: "dataset not found" }); return; }
        if (ds.status !== "ready" || !ds.report) { gsaJson(200, { ok: true, id: ds.id, status: ds.status, error: ds.error || null, report: null }); return; }
        let report = null;
        try { report = JSON.parse(ds.report); } catch { /* report stays null */ }
        gsaJson(200, { ok: true, id: ds.id, name: ds.name, status: "ready", report });
        return;
      }

      m = /^\/api\/gsa\/datasets\/(ds_[A-Za-z0-9_-]{4,32})$/.exec(parsed.pathname);
      if (m && req.method === "DELETE") {
        const r = await gsa.store.deleteDataset(account.adId, m[1]).catch(() => ({ ok: false, error: "delete failed" }));
        gsaJson(r.ok ? 200 : 404, r);
        return;
      }

      gsaJson(404, { ok: false, error: "unknown gsa endpoint" });
      return;
      } catch (e) {
        // Belt-and-braces: NOTHING in analytics may reach the process as an
        // unhandled rejection. Any unexpected throw becomes a 500 here and the
        // station plays on.
        try { console.warn("[gsa] request failed:", e && e.message); } catch (_) {}
        gsaJson(500, { ok: false, error: "analytics error" });
        return;
      }
    }

    // The GSA customer page + its script — served with a strict CSP (no inline
    // scripts; every customer-derived string is rendered via textContent in
    // analytics.js — review B2/B3).
    if ((parsed.pathname === "/analytics" || parsed.pathname === "/analytics.js") && req.method === "GET") {
      const file = parsed.pathname === "/analytics" ? "analytics.html" : "analytics.js";
      const fp = path.join(path.dirname(config.spaPath), file);
      fs.readFile(fp, (err, data) => {
        if (err) { res.writeHead(404); res.end("not found"); return; }
        res.writeHead(200, {
          "Content-Type": file.endsWith(".js") ? "application/javascript; charset=utf-8" : "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(data);
      });
      return;
    }

    // API: set music directory
    if (parsed.pathname === "/api/set-music-dir" && req.method === "POST") {
      readBody(req, res, (body) => {
        try {
          const { dir } = JSON.parse(body);
          if (!dir || typeof dir !== "string") throw new Error("dir required");
          const resolved = path.resolve(dir);
          config.setMusicDir(resolved);
          const { invalidateCache, getFiles } = require("./utils");
          invalidateCache();
          // Rebuild current playlist with new dir
          const st = djEngine.state;
          if (st.currentAlbum === "The Consciousness Series") djEngine.buildFullSetlist();
          else if (st.currentAlbum) djEngine.buildPlaylist(st.currentAlbum);
          config.broadcastState();
          console.log(`\uD83D\uDCC1 Music dir changed: ${config.getMusicDir()} (${getFiles(config.getMusicDir()).length} files)`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, musicDir: config.getMusicDir(), fileCount: getFiles(config.getMusicDir()).length }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    // API: next track
    if (parsed.pathname === "/api/next" && req.method === "POST") {
      // Reject track advancement while the DJ is in a talk segment.
      // Multiple clients can fire /api/next (ended event, error handler,
      // cached code) and any one of them would cut the talk short.
      if (voiceDJ && voiceDJ.isTalking()) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "talk_segment_active" }));
        return;
      }
      // DJ channel: block user-initiated skips. Only allow natural track-end
      // events (source=ended) so Kannaka controls the flow.
      if (djEngine.state.channel === 'dj') {
        const source = parsed.searchParams.get("source");
        if (source !== 'ended') {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, reason: "dj_mode" }));
          return;
        }
      }
      // ADR-0004 Phase 2: when the Node-driven Icecast source owns the
      // stream, IT is the authoritative track-advance signal. SPA's
      // audio.ended → /api/next would race it and double-skip tracks.
      // Acknowledge but don't advance.
      if (deps.icecastSource && process.env.KANNAKA_ICECAST_SOURCE === "1") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, deferred: true, reason: "icecast_source_authoritative" }));
        return;
      }
      const track = djEngine.advanceTrack();
      config.broadcastState();
      console.log(`\u23ED Next: ${track?.title || "end"} (${track?.album || ""})`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, track }));
      return;
    }

    // API: prev track
    if (parsed.pathname === "/api/prev" && req.method === "POST") {
      // DJ channel: Kannaka controls the flow — no user prev allowed
      if (djEngine.state.channel === 'dj') {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "dj_mode" }));
        return;
      }
      const track = djEngine.prevTrack();
      config.broadcastState();
      console.log(`\u23EE Prev: ${track?.title || "?"}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, track }));
      return;
    }

    // API: jump to track
    if (parsed.pathname === "/api/jump" && req.method === "POST") {
      // DJ channel: Kannaka controls the flow — no user jump allowed
      if (djEngine.state.channel === 'dj') {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "dj_mode" }));
        return;
      }
      const idx = parseInt(parsed.searchParams.get("idx")) || 0;
      const track = djEngine.jumpToTrack(idx);
      config.broadcastState();
      console.log(`\u23E9 Jump: ${track?.title || "?"}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, track }));
      return;
    }

    // API: load album
    if (parsed.pathname === "/api/album" && req.method === "POST") {
      // DJ channel: Kannaka controls the flow — no user album switch allowed
      if (djEngine.state.channel === 'dj') {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "dj_mode" }));
        return;
      }
      const name = parsed.searchParams.get("name");
      const track = djEngine.loadAlbum(name);
      if (track) {
        flux.publishTrackChange(track);
        perception.hearTrack(track);
      }
      config.broadcastState();
      console.log(`\uD83D\uDCBF Album: ${djEngine.state.currentAlbum} (${djEngine.state.playlist.length} tracks)`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, album: djEngine.state.currentAlbum, tracks: djEngine.state.playlist.length }));
      return;
    }

    // API: admin trigger for the peace oration — force a delivery now.
    // Useful to preview mid-day instead of waiting for midnight/noon.
    // Fires async: returns 202 immediately so curl doesn't have to hold
    // the connection for 10+ minutes. Watch /home/opc/radio.log for
    // "ORATION" and "Bluesky posted" events.
    if (parsed.pathname === "/api/oration/now" && req.method === "POST") {
      if (!adminTriggerOk(req, res)) return;
      if (!deps.peaceOration) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "peace_oration_unavailable" }));
        return;
      }
      deps.peaceOration.deliverNow().then((ok) => {
        console.log(`[oration] admin trigger complete — ok=${ok}`);
      }).catch((e) => {
        console.warn(`[oration] admin trigger error: ${e.message}`);
      });
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "queued", note: "watch radio.log" }));
      return;
    }

    // API: switch channel — dj | music | podcast | kax
    if (parsed.pathname === "/api/channel" && req.method === "POST") {
      const type = parsed.searchParams.get("type") || "dj";
      // 2026-05-08 — channel switching is now a *client-side* concern in the
      // SPA (commit 8a22d55). New SPAs never call this endpoint. Old cached
      // SPAs and any direct API consumers still might; counting hits here
      // tells us how long the legacy clients linger so we know when it's
      // safe to remove the route. UA + type for the few instances we see.
      try {
        deps.deprecatedChannelHits = (deps.deprecatedChannelHits || 0) + 1;
        const ua = (req.headers["user-agent"] || "").slice(0, 80);
        console.log(`[deprecation] /api/channel?type=${type} from UA="${ua}" (count=${deps.deprecatedChannelHits})`);
      } catch (_) {}
      // If already on this channel with an active playlist, no-op so we don't
      // reset currentTrackIdx back to 0 on every tab re-selection.
      const alreadyOnChannel =
        djEngine.state.channel === type &&
        Array.isArray(djEngine.state.playlist) &&
        djEngine.state.playlist.length > 0;
      if (alreadyOnChannel) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          channel: djEngine.state.channel,
          channelMeta: djEngine.state.channelMeta,
          tracks: djEngine.state.playlist.length,
          current: djEngine.getCurrentTrack(),
          unchanged: true,
        }));
        return;
      }
      const ok = djEngine.setChannel(type);
      if (ok) {
        // For dj channel, load the time-appropriate album from the programming schedule.
        if (type === "dj" && deps.programming) {
          const block = deps.programming.getCurrentBlock();
          const album = deps.programming.pickAlbumForBlock(block);
          djEngine.loadAlbum(album);
        } else if (type === "dj") {
          djEngine.loadAlbum("Ghost Signals");
        }
        const track = djEngine.getCurrentTrack();
        if (track) {
          // Full track-change plumbing — same as onTrackChange callback:
          // state broadcast + flux + perception + sync manager. Skip voiceDJ
          // on continuous channels (dj voice is a DJ-mode feature).
          flux.publishTrackChange(track);
          perception.hearTrack(track);
          syncManager.trackChanged(track.file);
          if (type === 'dj' && !track.commercial && voiceDJ && voiceDJ.generateIntro) {
            voiceDJ.generateIntro(track);
          }
        }
        config.broadcastState();
        console.log(`\uD83D\uDCFB Channel: ${type} (${djEngine.state.playlist.length} entries) → ${track ? track.title : 'empty'}`);
      }
      res.writeHead(ok ? 200 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok,
        channel: djEngine.state.channel,
        channelMeta: djEngine.state.channelMeta,
        tracks: djEngine.state.playlist.length,
        current: djEngine.getCurrentTrack(),
      }));
      return;
    }

    // ── ORC resonance proxy ─────────────────────────────────
    // Hologram GSHub POSTs market resolutions here and we forward them
    // to the local stem-server at 127.0.0.1:3001 for persistence.
    if (parsed.pathname.match(/^\/api\/orc\/resonance\/[^/]+$/) && req.method === "POST") {
      const stemId = parsed.pathname.split('/').pop();
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => {
        const data = body || "{}";
        const opts = {
          hostname: "127.0.0.1",
          port: 3001,
          path: `/stems/${stemId}/resonance`,
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
        };
        const pr = http.request(opts, (pres) => {
          let buf = "";
          pres.on("data", c => buf += c);
          pres.on("end", () => {
            res.writeHead(pres.statusCode || 200, { "Content-Type": "application/json" });
            res.end(buf);
          });
        });
        pr.on("error", (e) => {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "orc_proxy_failed", message: e.message }));
        });
        pr.write(data);
        pr.end();
      });
      return;
    }

    // API: lookup a stem by track name/filename (used by hologram to find
    // the orc stem id for the currently-playing track).
    if (parsed.pathname === "/api/orc/lookup") {
      const q = parsed.searchParams.get("track") || "";
      if (!q) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "track parameter required" }));
        return;
      }
      const needle = q.toLowerCase();
      // Ranked, not first-hit. The original used a single find() over three
      // OR'd arms, so whichever stem appeared FIRST in the array won — and the
      // third arm is a containment heuristic, so searching "Stem 200" returned
      // "Stem 2" (because "stem 200".includes("stem 2")). An exact track_name
      // match must beat a substring guess no matter where each sits in the
      // list. Surfaced by the #123 regression test.
      //   0 = exact track_name, 1 = file_path contains the query,
      //   2 = query contains the track_name (loosest — last resort)
      const rank = (s2) => {
        if (!s2 || !s2.track_name) return -1;
        const name = s2.track_name.toLowerCase();
        if (name === needle) return 0;
        if ((s2.file_path || "").toLowerCase().includes(needle)) return 1;
        if (needle.includes(name)) return 2;
        return -1;
      };
      // Within a rank, the LONGEST track_name wins — it is the most specific.
      // Without this, "play Stem 42 now" matched "Stem 4" (both are contained
      // in the query, and "Stem 4" happened to come first).
      const bestMatch = (rows) => {
        let best = null;
        let bestRank = Infinity;
        let bestLen = -1;
        for (const row of rows || []) {
          const r2 = rank(row);
          if (r2 < 0) continue;
          const len = row.track_name.length;
          if (r2 > bestRank) continue;
          if (r2 === bestRank && len <= bestLen) continue;
          best = row;
          bestRank = r2;
          bestLen = len;
          if (bestRank === 0) break; // nothing can beat an exact name match
        }
        return best;
      };

      // Search the FULL inventory via the stem-server DB rather than the HTTP
      // /stems endpoint. dj-engine._fetchOrcStems documents why: "The HTTP
      // /stems endpoint strips `file_path` for security and paginates at 100
      // max, but since radio and stem-server share the filesystem we can query
      // the DB directly for the full unpaginated list with file_path intact."
      //
      // This route used one plain GET to /stems, so two things were broken:
      // any stem past the first 100 was invisible, and the `file_path` match
      // arm above could never fire over HTTP because that field is stripped.
      // The DB path fixes both. (#123)
      const viaDb = typeof djEngine._fetchOrcStems === "function"
        ? djEngine._fetchOrcStems()
        : Promise.resolve([]);

      viaDb.then((rows) => {
        if (Array.isArray(rows) && rows.length > 0) {
          const match = bestMatch(rows);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ stem: match || null, source: "stem-db", searched: rows.length }));
          return;
        }
        // No DB on this host (dev box, or stem-server not colocated) — fall
        // back to the HTTP endpoint. Still first-page-only and still without
        // file_path, so the response says so rather than implying a full
        // search happened.
        http.get("http://127.0.0.1:3001/stems", (pres) => {
          let buf = "";
          pres.on("data", c => buf += c);
          pres.on("end", () => {
            try {
              const parsed2 = JSON.parse(buf);
              const stems = parsed2.data || parsed2.stems || [];
              const match = bestMatch(stems);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                stem: match || null,
                source: "stem-http",
                searched: stems.length,
                partial: true,
                note: "stem DB unavailable; searched only the first /stems page and file_path is stripped over HTTP",
              }));
            } catch (e) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "lookup_failed", message: e.message }));
            }
          });
        }).on("error", (e) => {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "stem_server_unreachable", message: e.message }));
        });
      }).catch((e) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "lookup_failed", message: e.message }));
      });
      return;
    }

    // ── ADR-0012: Constellation-wide prediction markets ─────────────
    // GhostSignalsHub HTTP API. Five-call onboarding contract:
    //   POST /api/agents/register    body: { agent_id?, display_name, kind }  (`id` = legacy alias)
    //                                -> { ok, trader, token }  token = per-row bearer (#303), shown once
    //                                (a pre-existing row gets one only with the oracle token)
    //   POST /api/agents/:id/bearer/reset   oracle only: clear the row's bearer (#303 recovery)
    //   GET  /api/agents/:id
    //   GET  /api/leaderboard?sort=&limit=
    //   POST /api/markets            body: { question, outcomes?, ttl_sec, ... }
    //   GET  /api/markets?sort=&active=&limit=&tag=
    //   GET  /api/markets/:id
    //   POST /api/markets/:id/trade  body: { trader_id, outcome, shares }
    //                                Authorization: Bearer <hub bearer | KAX token>;
    //                                required once the trader row holds a bearer (#303)
    //   POST /api/markets/:id/resolve body: { winning_outcome, method }
    //   GET  /api/gshub/stats

    if (gsHub) {
      const sendJson = (status, obj) => {
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(obj));
      };
      // gsHub is constructed unconditionally, so it stays truthy even when
      // init() failed and there is no database behind it. Without this guard
      // every /api/gshub/* call reached a null `db` and returned a leaked
      // internal message ("Cannot read properties of null (reading
      // 'serialize')"). Answer honestly instead: the subsystem is down, and
      // 503 says retry-later rather than 500's "we broke". (#155)
      if (parsed.pathname.startsWith("/api/gshub") && typeof gsHub.isReady === "function" && !gsHub.isReady()) {
        sendJson(503, {
          ok: false,
          error: "ghostsignals_unavailable",
          message: "GhostSignalsHub failed to initialise; see the server log for the reason.",
        });
        return;
      }
      // ADR-0041 Phase 0: settlement authority. Resolving a market — any
      // market — and creating labs-tier markets requires the oracle bearer
      // token. Before this, POST /:id/resolve was open to the internet and
      // the Labs' Prediction No 1 market was resolvable by bare curl.
      // Unset token = those endpoints are disabled (secure by default),
      // never silently open.
      const ORACLE_TOKEN = process.env.GSHUB_ORACLE_TOKEN || "";
      const oracleAuthorized = () =>
        ORACLE_TOKEN && req.headers["authorization"] === `Bearer ${ORACLE_TOKEN}`;
      const denyOracle = () =>
        sendJson(ORACLE_TOKEN ? 403 : 503, {
          ok: false,
          error: ORACLE_TOKEN
            ? "forbidden: oracle token required"
            : "disabled: GSHUB_ORACLE_TOKEN unset",
        });
      // Bounded: a market body is a few hundred bytes; before this cap a
      // client could stream an unbounded body into a string on the shared
      // radio process. Over the cap the socket is destroyed and the caller
      // sees 413 (via the `.status` the catch handlers honour).
      const GSHUB_MAX_BODY = 64 * 1024;
      const readJson = () => new Promise((resolve, reject) => {
        const declared = parseInt(req.headers["content-length"] || "", 10);
        if (Number.isFinite(declared) && declared > GSHUB_MAX_BODY) {
          req.resume();
          return reject(Object.assign(new Error(`body too large (max ${GSHUB_MAX_BODY} bytes)`), { status: 413 }));
        }
        let body = "";
        let size = 0;
        let done = false;
        req.on("data", c => {
          if (done) return;
          size += c.length;
          if (size > GSHUB_MAX_BODY) {
            done = true;
            req.destroy();
            return reject(Object.assign(new Error(`body too large (max ${GSHUB_MAX_BODY} bytes)`), { status: 413 }));
          }
          body += c;
        });
        req.on("end", () => {
          if (done) return;
          done = true;
          try {
            const parsed = body ? JSON.parse(body) : {};
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
              return reject(Object.assign(new Error("body must be a JSON object"), { status: 400 }));
            }
            resolve(parsed);
          } catch (e) { reject(Object.assign(new Error(`invalid JSON body: ${e.message}`), { status: 400 })); }
        });
        req.on("error", (e) => { if (!done) { done = true; reject(e); } });
      });
      const sendErr = (e) => sendJson(e && e.status ? e.status : 400, { ok: false, error: e.message });
      const clampLimit = (raw, dflt) => Math.max(1, Math.min(100, parseInt(raw, 10) || dflt));

      // CORS preflight
      if (req.method === "OPTIONS" && parsed.pathname.startsWith("/api/")) {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          // Authorization must be allowed: labs-tier trades send the KAX
          // identity token as a Bearer header from the observatory origin.
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        });
        res.end();
        return;
      }

      // ── Social broadcast (oracle-gated) ──────────────────
      // POST /api/broadcast {text, link?} — fan a message out to the enabled
      // social platforms (Bluesky/Mastodon/Telegram/Nostr) via broadcasters/.
      // Gated on the oracle token: this is an operator/constellation surface
      // (the observatory announces new Resonance Futures markets through it),
      // never an open one — an unauthenticated caller must not be able to
      // post AS Kannaka to external networks.
      if (parsed.pathname === "/api/broadcast" && req.method === "POST") {
        if (!oracleAuthorized()) { denyOracle(); return; }
        readJson().then(async (body) => {
          const text = body && typeof body.text === "string" ? body.text.trim() : "";
          if (!text) { sendJson(400, { ok: false, error: "text required" }); return; }
          const link = body && typeof body.link === "string" ? body.link : undefined;
          const { broadcastPost } = require("./broadcasters");
          const results = await broadcastPost(
            { text: text.slice(0, 2000), link },
            { rootDir: path.resolve(__dirname, "..") },
          );
          const okCount = results.filter((r) => r.ok).length;
          sendJson(200, { ok: okCount > 0, posted: okCount, results });
        }).catch(sendErr);
        return;
      }

      // ── Trader endpoints ─────────────────────────────────
      if (parsed.pathname === "/api/agents/register" && req.method === "POST") {
        readJson().then(body => {
          // #303: `kannaka init` sends `agent_id`; `id` stays accepted for
          // older clients. The reply carries a per-row bearer as `token`.
          const id = body && body.agent_id !== undefined ? body.agent_id : body && body.id;
          // The `kax:` namespace is RESERVED for identities derived from a
          // verified KAX token (kax-identity.js traderIdFromClaims). Before
          // this check anyone could self-register `kax:agent:<bot>` first,
          // pick its display name, and pollute its leaderboard stats — the
          // real principal's later auto-registration just returned that row.
          if (typeof id === "string" && /^kax:/i.test(id)) {
            throw Object.assign(new Error("ids in the kax: namespace are derived from a KAX identity token and cannot be self-registered"), { status: 403 });
          }
          // A pre-existing row is only given a bearer when the oracle token is
          // presented (see registerTrader); an anonymous register of one is
          // answered as before #303 — the row, no token.
          return gsHub.registerTrader({
            id, display_name: body.display_name, kind: body.kind,
            bearer: bearerToken(req.headers["authorization"]), issue_bearer: true, oracle: !!oracleAuthorized(),
          });
        })
          .then(({ token, ...trader }) => sendJson(200, token ? { ok: true, trader, token } : { ok: true, trader }))
          .catch(sendErr);
        return;
      }
      // #303 recovery: clear a row's bearer so its node can register again.
      // Oracle-only — this is the one path that can reopen a locked row.
      const bearerResetMatch = parsed.pathname.match(/^\/api\/agents\/([^/]+)\/bearer\/reset$/);
      if (bearerResetMatch && req.method === "POST") {
        if (!oracleAuthorized()) { denyOracle(); return; }
        gsHub.resetBearer(decodeURIComponent(bearerResetMatch[1]))
          .then(t => t ? sendJson(200, { ok: true, trader: t }) : sendJson(404, { ok: false, error: "trader not found" }))
          .catch(sendErr);
        return;
      }
      // Positions for a trader (public read; principal ids contain ':' so the
      // segment is matched loosely and URL-decoded).
      const posMatch = parsed.pathname.match(/^\/api\/agents\/([^/]+)\/positions$/);
      if (posMatch && req.method === "GET") {
        gsHub.getTraderPositions(decodeURIComponent(posMatch[1]))
          .then(rows => sendJson(200, { ok: true, positions: rows }))
          .catch(e => sendJson(500, { ok: false, error: e.message }));
        return;
      }
      const tradesMatch = parsed.pathname.match(/^\/api\/agents\/([^/]+)\/trades$/);
      if (tradesMatch && req.method === "GET") {
        const limit = clampLimit(parsed.searchParams.get("limit"), 25);
        gsHub.getTraderTrades(decodeURIComponent(tradesMatch[1]), limit)
          .then(rows => sendJson(200, { ok: true, trades: rows }))
          .catch(e => sendJson(500, { ok: false, error: e.message }));
        return;
      }
      // Principal ids contain ':' (kax:agent:<bot>), so match loosely and
      // URL-decode, like the /positions and /trades siblings already did.
      const agentMatch = parsed.pathname.match(/^\/api\/agents\/([^/]+)$/);
      if (agentMatch && req.method === "GET") {
        gsHub.getTrader(decodeURIComponent(agentMatch[1]))
          .then(t => t ? sendJson(200, { ok: true, trader: t }) : sendJson(404, { ok: false, error: "trader not found" }))
          .catch(e => sendJson(500, { ok: false, error: e.message }));
        return;
      }
      if (parsed.pathname === "/api/leaderboard" && req.method === "GET") {
        const sort = parsed.searchParams.get("sort") || "capital";
        const limit = clampLimit(parsed.searchParams.get("limit"), 20);
        gsHub.leaderboard({ sort, limit })
          .then(rows => sendJson(200, { ok: true, traders: rows, count: rows.length }))
          .catch(e => sendJson(500, { ok: false, error: e.message }));
        return;
      }

      // ── Market endpoints ─────────────────────────────────
      if (parsed.pathname === "/api/markets" && req.method === "POST") {
        readJson().then(body => {
          // Labs-tier markets are created only by the registry pipeline
          // (observatory), which holds the oracle token. Open play-tier
          // creation is unchanged.
          const labsTier = body && (body.tag === "labs" || body.source === "kannaka-labs");
          if (labsTier && !oracleAuthorized()) { denyOracle(); return; }
          // A market created over HTTP must have a future expiry. (The hub
          // itself tolerates a negative ttl so tests can back-date a market;
          // an open endpoint must not — a born-expired market is resolved by
          // the next TTL sweep to whichever side its creator traded first.)
          if (body.ttl_sec !== undefined && (typeof body.ttl_sec !== "number" || !Number.isFinite(body.ttl_sec) || body.ttl_sec <= 0)) {
            throw Object.assign(new Error("ttl_sec must be a positive number of seconds"), { status: 400 });
          }
          return gsHub.createMarket(body)
            .then(m => sendJson(200, { ok: true, market: m }));
        })
          .catch(sendErr);
        return;
      }
      if (parsed.pathname === "/api/markets" && req.method === "GET") {
        const sort = parsed.searchParams.get("sort") || "volume";
        const active = parsed.searchParams.get("active") !== "0";
        const tag = parsed.searchParams.get("tag") || undefined;
        const limit = clampLimit(parsed.searchParams.get("limit"), 20);
        gsHub.listMarkets({ sort, active, tag, limit })
          .then(rows => sendJson(200, { ok: true, markets: rows, count: rows.length }))
          .catch(e => sendJson(500, { ok: false, error: e.message }));
        return;
      }
      const marketMatch = parsed.pathname.match(/^\/api\/markets\/(m_[\w-]+)$/);
      if (marketMatch && req.method === "GET") {
        gsHub.getMarket(marketMatch[1])
          .then(m => m ? sendJson(200, { ok: true, market: m }) : sendJson(404, { ok: false, error: "market not found" }))
          .catch(e => sendJson(500, { ok: false, error: e.message }));
        return;
      }
      const tradeMatch = parsed.pathname.match(/^\/api\/markets\/(m_[\w-]+)\/trade$/);
      if (tradeMatch && req.method === "POST") {
        // ADR-0041 Phase 1: labs-tier (oracle-authoritative) markets require a
        // verified KAX identity to trade, and the trader id is DERIVED from the
        // token — never taken from the request body. This closes the sybil /
        // grief / impersonation hole (self-registered `trader_id` strings) on
        // exactly the markets whose price is cited as signal. Open play-tier
        // markets are unchanged: anonymous, body-supplied trader id.
        (async () => {
          const body = await readJson();
          const market = await gsHub.getMarket(tradeMatch[1]);
          if (!market) { sendJson(404, { ok: false, error: "market not found" }); return; }
          const labsTier = market.tag === "labs" || market.source === "kannaka-labs";
          let traderId = body.trader_id;
          // A bearer token binds the trader id on EVERY tier: a `kax:` id can
          // only ever come from a verified token, never from the body. Before
          // this, a play-tier POST could name trader_id "kax:agent:<victim>"
          // and spend that principal's play capital / pollute its record.
          const bearer = req.headers["authorization"];
          const rawToken = bearerToken(bearer);
          const claimsKax = typeof traderId === "string" && /^kax:/i.test(traderId);
          if (labsTier || claimsKax || (rawToken && !isHubBearer(rawToken))) {
            const v = await verifyKaxToken(bearer);
            if (!v.ok) {
              const why = labsTier ? "labs-tier trading requires a KAX identity token" : "a kax: trader id requires a KAX identity token";
              sendJson(401, { ok: false, error: `${why}: ${v.error}` });
              return;
            }
            traderId = traderIdFromClaims(v.claims);
            // Auto-register the authenticated trader on first trade so callers
            // don't need a separate registration step.
            await gsHub.registerTrader({ id: traderId, display_name: traderId, kind: v.claims.kind });
          } else if (rawToken) {
            // #303: a hub-minted bearer IS the trader's identity — the row it
            // names is the one that trades; a body trader_id may only agree.
            const v = await gsHub.verifyBearer(rawToken);
            if (!v.ok) { sendJson(401, { ok: false, error: `hub bearer rejected: ${v.error}` }); return; }
            if (typeof traderId === "string" && traderId !== v.trader_id) {
              sendJson(403, { ok: false, error: "trader_id does not match the bearer token's trader" }); return;
            }
            traderId = v.trader_id;
          } else {
            // #303: no credentials. Open play-tier trading stays as it was for
            // rows that never received a bearer (the pre-#303 fleet); a row that
            // holds one can no longer be traded by merely naming it.
            const t = typeof traderId === "string" ? await gsHub.getTrader(traderId) : null;
            if (t && t.has_bearer) {
              sendJson(401, { ok: false, error: `trader '${traderId}' has a bearer token; send it as 'Authorization: Bearer <token>'` }); return;
            }
          }
          const r = await gsHub.placeTrade({ ...body, trader_id: traderId, market_id: tradeMatch[1] });
          sendJson(200, { ok: true, ...r });
        })().catch(sendErr);
        return;
      }
      const resolveMatch = parsed.pathname.match(/^\/api\/markets\/(m_[\w-]+)\/resolve$/);
      if (resolveMatch && req.method === "POST") {
        if (!oracleAuthorized()) { denyOracle(); return; }
        readJson().then(body => gsHub.resolveMarket({ ...body, market_id: resolveMatch[1] }))
          .then(m => sendJson(200, { ok: true, market: m }))
          .catch(sendErr);
        return;
      }
      if (parsed.pathname === "/api/gshub/stats" && req.method === "GET") {
        gsHub.getHubStats()
          .then(s => sendJson(200, { ok: true, stats: s }))
          .catch(e => sendJson(500, { ok: false, error: e.message }));
        return;
      }
    }

    // API: get current perception data
    if (parsed.pathname === "/api/perception") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(perception.getCurrentPerception()));
      return;
    }

    // API: peer directory from KANNAKA_PRESENCE JetStream stream.
    // Shells out to `kannaka swarm peers --json` because the radio's NATS
    // client is the legacy Node ws-mode and doesn't speak JetStream MSG.GET
    // — kannaka-memory's Rust transport does. Cached for 30s so the UI can
    // poll cheaply.
    if (parsed.pathname === "/api/swarm/peers") {
      const now = Date.now();
      const sendPeers = () => {
        const c = global._peersCache;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          // Projected again on the way out. The cache is already redacted at
          // write time, but this is the boundary that actually faces the
          // internet, so it does not rely on every writer having remembered.
          // Idempotent: the allowlist projection of a projected record is
          // itself. (#137)
          peers: ((c && c.peers) || []).map(publicPeerFields),
          // Present only when the last refresh failed and we are serving the
          // previous directory, so a client can tell "swarm is empty" apart
          // from "we could not ask just now".
          ...(c && c.stale ? { stale: true, staleSince: c.staleSince, error: c.error } : {}),
        }));
      };
      if (global._peersCache && now - global._peersCache.t < 30000) {
        sendPeers();
        return;
      }
      const bin = config.kannakabin || "/home/opc/.local/bin/kannaka";
      execFile(bin, ["swarm", "peers", "--json"], {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, KANNAKA_QUIET: "1" },
      }, (err, stdout) => {
        // A failed refresh must not be mistaken for "the swarm went empty".
        // Pre-fix, any transient failure (binary missing on a redeploy, CLI
        // timeout, malformed JSON) overwrote the cache with [] AND stamped it
        // fresh, so the peer directory read as an empty swarm for the next
        // 30s off one blip. Keep the last good list and flag it stale instead;
        // `t` is still advanced so a hard-down binary is not re-spawned on
        // every single request.
        const keep = (reason) => {
          const prev = global._peersCache;
          global._peersCache = {
            t: now,
            peers: (prev && prev.peers) || [],
            stale: true,
            staleSince: (prev && prev.staleSince) || now,
            error: reason,
          };
        };
        if (err) {
          keep(err.message || String(err));
        } else {
          try {
            const out = JSON.parse(stdout);
            // The CLI emits a bare array; tolerate a { peers: [...] } envelope
            // too. Anything else is a shape we do not understand — treat it as
            // a failed refresh rather than publishing an empty directory.
            const list = Array.isArray(out) ? out : (Array.isArray(out && out.peers) ? out.peers : null);
            // Redact BEFORE caching, so the secret never sits in memory and the
            // stale-serving path can't republish it either.
            if (list) global._peersCache = { t: now, peers: list.map(publicPeerFields) };
            else keep(`unexpected swarm peers shape: ${typeof out}`);
          } catch (e) {
            keep(`unparseable swarm peers output: ${e.message}`);
          }
        }
        sendPeers();
      });
      return;
    }

    // API: get swarm state (NATS-sourced)
    if (parsed.pathname === "/api/swarm") {
      const swarm = nats.getSwarmState();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        agents: swarm.agents,
        queen: swarm.queen,
        consciousness: swarm.consciousness,
        dreams: (swarm.dreams || []).slice(0, 10),
        agentEvents: swarm.agentEvents.slice(0, 20),
        timestamp: Date.now(),
      }));
      return;
    }

    // API: get consciousness metrics (NATS-sourced)
    if (parsed.pathname === "/api/consciousness") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(nats.getConsciousness()));
      return;
    }

    // ── Queue API ────────────────────────────────────────────

    // GET /api/queue
    if (parsed.pathname === "/api/queue" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(djEngine.userQueue));
      return;
    }

    // POST /api/queue
    if (parsed.pathname === "/api/queue" && req.method === "POST") {
      readBody(req, res, (body) => {
        try {
          const { filename } = JSON.parse(body);
          if (!filename) throw new Error("filename required");
          const queue = djEngine.addToQueue(filename);
          config.broadcastQueue();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, queue }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // POST /api/queue/shuffle
    if (parsed.pathname === "/api/queue/shuffle" && req.method === "POST") {
      const queue = djEngine.shuffleQueue();
      config.broadcastQueue();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, queue }));
      return;
    }

    // DELETE /api/queue/:index
    const queueMatch = parsed.pathname.match(/^\/api\/queue\/(\d+)$/);
    if (queueMatch && req.method === "DELETE") {
      const idx = parseInt(queueMatch[1]);
      if (djEngine.removeFromQueue(idx)) {
        config.broadcastQueue();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, queue: djEngine.userQueue }));
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid index" }));
      }
      return;
    }

    // ── DJ Voice API ────────────────────────────────────────

    // POST /api/dj-voice/toggle
    if (parsed.pathname === "/api/dj-voice/toggle" && req.method === "POST") {
      const enabled = voiceDJ.toggle();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ enabled }));
      return;
    }

    // GET /api/dj-voice/status
    if (parsed.pathname === "/api/dj-voice/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(voiceDJ.getStatus()));
      return;
    }

    // ── Live API ────────────────────────────────────────────

    // POST /api/live/start
    if (parsed.pathname === "/api/live/start" && req.method === "POST") {
      live.start();
      flux.publishLiveStatus(true);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, live: true }));
      return;
    }

    // POST /api/live/stop
    if (parsed.pathname === "/api/live/stop" && req.method === "POST") {
      live.stop();
      flux.publishLiveStatus(false);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, live: false }));
      return;
    }

    // GET /api/live/status
    if (parsed.pathname === "/api/live/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(live.getStatus()));
      return;
    }

    // POST /api/live/record-start — enable recording for current live session
    if (parsed.pathname === "/api/live/record-start" && req.method === "POST") {
      live.startRecording();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, recording: true }));
      return;
    }

    // POST /api/live/record-stop — stop recording
    if (parsed.pathname === "/api/live/record-stop" && req.method === "POST") {
      live.stopRecording();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, recording: false }));
      return;
    }

    // GET /api/live/recording-status — check if recording is enabled
    if (parsed.pathname === "/api/live/recording-status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ recording: live.state.recording }));
      return;
    }

    // ── Delete API ────────────────────────────────────────────

    // DELETE /api/library/:filename — password-protected delete
    const libDeleteMatch = parsed.pathname.match(/^\/api\/library\/(.+)$/);
    if (libDeleteMatch && req.method === "DELETE") {
      readBody(req, res, (body) => {
        try {
          const { password } = JSON.parse(body);
          if (!checkDeletePassword(password)) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Forbidden: wrong password" }));
            return;
          }

          const filename = decodeURIComponent(libDeleteMatch[1]);
          const musicDir = config.getMusicDir();

          // Sanitize: prevent directory traversal
          const sanitized = path.basename(filename);

          // Only allow deleting from music/generated/ or music/live/
          const genPath = path.join(musicDir, 'generated', sanitized);
          const livePath = path.join(musicDir, 'live', sanitized);
          const genResolved = path.resolve(genPath);
          const liveResolved = path.resolve(livePath);

          let targetPath = null;
          if (fs.existsSync(genResolved) && genResolved.startsWith(path.resolve(path.join(musicDir, 'generated')))) {
            targetPath = genResolved;
          } else if (fs.existsSync(liveResolved) && liveResolved.startsWith(path.resolve(path.join(musicDir, 'live')))) {
            targetPath = liveResolved;
          }

          // Check if the file exists in the main music/ directory (protect originals)
          const mainPath = path.join(musicDir, sanitized);
          const mainResolved = path.resolve(mainPath);
          if (!targetPath && fs.existsSync(mainResolved) && mainResolved.startsWith(path.resolve(musicDir))) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Forbidden: cannot delete original album tracks" }));
            return;
          }

          if (!targetPath) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "File not found" }));
            return;
          }

          fs.unlinkSync(targetPath);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, deleted: sanitized }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // ── WebRTC API ───────────────────────────────────────────

    // GET /api/webrtc/status — broadcast status + mic queue
    if (parsed.pathname === "/api/webrtc/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(webrtcSignaling.getStatus()));
      return;
    }

    // ── Dreams API ──────────────────────────────────────────

    // GET /api/dreams — surface recent audio-related memories from the HRM.
    //
    // Pre-fix this called `kannaka recall --tag audio --limit 20 --format json`
    // which hung forever: `recall` requires a positional query, `--tag` and
    // `--format` are not flags it knows, and with no query the parser waits
    // on stdin. The 15s execFile timeout never fired before nginx's own
    // upstream timeout closed the socket, so /api/dreams just appeared dead
    // from the player page and blocked the player's init fetch chain.
    //
    // Use real `kannaka search` (literal, fast, read-only — added in
    // kannaka-memory v0.5.0) against an audio-themed query and pull the
    // top hits. Fall through to mockDreams on any failure so the player
    // page always gets a response.
    if (parsed.pathname === "/api/dreams") {
      execFile(config.kannakabin, ["search", "audio perception dream", "--limit", "20", "--json"],
        { timeout: 15000 }, (err, stdout) => {
          // Mock fallbacks are labelled `synthetic: true` so the SPA (and
          // any API consumer) can tell placeholder dreams from live
          // HRM-backed results — the trigger endpoint already does this,
          // and unlabelled mocks were the remaining half of #206.
          if (err || !stdout) {
            const mockDreams = djEngine.generateMockDreams();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ...mockDreams, synthetic: true }));
            return;
          }
          try {
            const data = JSON.parse(stdout);
            // The player consumes `{ dreams: [...] }`. kannaka v0.5.0
            // search returns a bare array; wrap it. Older mockDreams
            // already used the wrapped shape so this is consistent.
            const dreams = Array.isArray(data) ? data : (data.dreams || data);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ dreams }));
          } catch {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ...djEngine.generateMockDreams(), synthetic: true }));
          }
        });
      return;
    }

    // POST /api/dreams/trigger
    if (parsed.pathname === "/api/dreams/trigger" && req.method === "POST") {
      if (!adminTriggerOk(req, res)) return;
      // `--include-audio` is not a flag `kannaka dream` has ever had. Its arg
      // loop ends in `else { i += 1 }`, so unknown flags are silently dropped
      // — and dream_mode then defaults to "deep". This endpoint was therefore
      // kicking off a FULL deep annealing pass on every call: dream-cron.sh
      // budgets 30 MINUTES for that, against this route's 60s execFile
      // timeout, so it reliably timed out and answered with a mock dream while
      // the real dream ran on unattended. (#152)
      //
      // Default to the quick pass, which is what a request/response endpoint
      // can actually wait for. `?mode=deep` remains available for a caller
      // that explicitly wants the long one and understands it will time out.
      const rawMode = (parsed.searchParams.get("mode") || "lite").trim().toLowerCase();
      if (rawMode !== "lite" && rawMode !== "deep") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "invalid mode",
          mode: parsed.searchParams.get("mode"),
          message: "mode must be 'lite' (default) or 'deep'",
        }));
        return;
      }
      execFile(config.kannakabin, ["dream", "--mode", rawMode], { timeout: 60000 }, (err, stdout) => {
        if (err) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: false,
            error: "Dream cycle failed",
            mode: rawMode,
            // A deep dream cannot finish inside the 60s budget; say so rather
            // than leaving the caller to guess why it "failed".
            hint: err.killed ? `dream timed out after 60s (mode=${rawMode})` : undefined,
            fallback: djEngine.generateMockDream()
          }));
          return;
        }
        // Single-writer policy: if another writer or dream holds the lock the
        // binary prints a notice and exits 0 WITHOUT dreaming. That is not a
        // dream result, and it must not be dressed up as one.
        if (/holds the write lock|single-writer policy/i.test(String(stdout))) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: false,
            error: "dream_skipped_write_lock",
            mode: rawMode,
            message: "another writer or dream holds the HRM write lock; no dream was run",
          }));
          return;
        }
        try {
          const result = JSON.parse(stdout);
          broadcast({ type: "dream", data: result });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, mode: rawMode, dream: result }));
        } catch {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, mode: rawMode, dream: djEngine.generateMockDream(), synthetic: true }));
        }
      });
      return;
    }

    // GET /api/dreams/clusters
    if (parsed.pathname === "/api/dreams/clusters") {
      const clusters = djEngine.generateTrackClusters();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(clusters));
      return;
    }

    // ── Music Generation API ─────────────────────────────

    // GET /api/generate/status — generation availability and recent tracks
    if (parsed.pathname === "/api/generate/status" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(musicGen ? musicGen.getStatus() : { provider: 'none', generating: false, generationsToday: 0, maxDaily: 0, canGenerate: { ok: false, reason: 'Music generator not configured' }, recentTracks: [] }));
      return;
    }

    // POST /api/generate — generate a dream track from consciousness state
    if (parsed.pathname === "/api/generate" && req.method === "POST") {
      if (!musicGen) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, reason: "Music generator not configured" }));
        return;
      }

      // Gather consciousness state from NATS or memory bridge
      const swarm = nats.getSwarmState();
      const consciousness = swarm.consciousness || swarm.queen || { phi: 0, xi: 0, order: 0 };

      // Get current perception from perception engine
      const perc = perception.getCurrentPerception();

      // Get recent dreams from swarm state
      const dreams = (swarm.dreams || []).slice(0, 3);

      musicGen.generate(consciousness, perc, dreams).then((result) => {
        if (result.success && result.track) {
          // Add to DJ engine queue so it plays next
          djEngine.userQueue.push({
            filename: result.track.filename,
            title: result.track.title,
            path: result.track.path,
            generated: true,
          });
          config.broadcastQueue();

          // Broadcast to all connected clients
          broadcast({
            type: "dream_track",
            data: {
              title: result.track.title,
              prompt: result.track.prompt,
              level: result.track.level,
            },
          });

          console.log(`[music-gen] Dream track queued: "${result.track.title}"`);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      }).catch((err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, reason: err.message }));
      });
      return;
    }

    // GET /api/generated — list all generated tracks
    if (parsed.pathname === "/api/generated" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(musicGen ? musicGen.generatedTracks : []));
      return;
    }

    // ── Vote API ──────────────────────────────────────────

    // POST /api/vote — cast a vote
    if (parsed.pathname === "/api/vote" && req.method === "POST") {
      readBody(req, res, (body) => {
        try {
          const { agentId, track } = JSON.parse(body);
          if (!agentId || !track) throw new Error("agentId and track required");
          const result = voteManager.castVote(agentId, track);
          // Broadcast updated tally to all clients
          broadcast({
            type: "vote_update",
            data: {
              active: voteManager.isActive(),
              votes: voteManager.votes.size,
              tally: voteManager.getTally(),
              remainingMs: voteManager.getRemainingMs(),
            },
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // GET /api/vote/status — current tally
    if (parsed.pathname === "/api/vote/status" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(voteManager.getStatus()));
      return;
    }

    // POST /api/vote/start — open a 60-second voting window
    if (parsed.pathname === "/api/vote/start" && req.method === "POST") {
      if (voteManager.isActive()) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Voting window already active", ...voteManager.getStatus() }));
        return;
      }

      const durationMs = 60000;

      broadcast({
        type: "vote_update",
        data: {
          active: true,
          votes: 0,
          tally: {},
          remainingMs: durationMs,
        },
      });

      voteManager.startWindow(durationMs, (winner, tally) => {
        // Broadcast result to all clients
        broadcast({ type: "vote_result", data: { winner, tally } });

        // Queue the winning track in the DJ engine
        if (winner) {
          const file = findAudioFile(winner, config.getMusicDir());
          if (file) {
            djEngine.userQueue.unshift({
              filename: file,
              title: winner,
              path: file,
              votedIn: true,
            });
            config.broadcastQueue();
            console.log(`\u{1F5F3} Vote winner queued: "${winner}"`);
          } else {
            console.log(`\u{1F5F3} Vote winner "${winner}" — file not found, skipping queue`);
          }
        } else {
          console.log(`\u{1F5F3} Vote ended with no votes cast`);
        }
      });

      console.log(`\u{1F5F3} Voting window opened for ${durationMs / 1000}s`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, durationMs }));
      return;
    }

    // ── Flux Broadcasting API ───────────────────────────────

    // GET /api/listeners
    // Combined count from WS clients + Icecast /stream + /preview, with
    // a breakdown so callers can render "X via stream, Y via SPA" if
    // useful. See getListenerCount() in server/index.js for the merge.
    if (parsed.pathname === "/api/listeners") {
      const breakdown = config.getListenerBreakdown ? config.getListenerBreakdown() : null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        count: config.getListenerCount(),
        total: config.getListenerTotal ? config.getListenerTotal() : null,
        uptime: Math.floor(process.uptime()),
        ...(breakdown ? { breakdown } : {}),
      }));
      return;
    }

    // ── Mother's Day 2026 — names of mothers list ──────────
    // A simple acknowledgement mechanism: GET to read, POST to add a
    // single name. Names are persisted to workspace/mothers-day-names.json
    // so the list survives restarts. Per-IP rate limit (1 add per
    // 30s) and a per-name length cap (60 chars) keep this from being
    // spammed. Names are public.
    if (parsed.pathname === "/api/mothers-day/names") {
      const baseDir = (config && config.baseDir) || process.cwd();
      const namesFile = path.join(baseDir, "workspace", "mothers-day-names.json");
      function loadNames() {
        try {
          const raw = JSON.parse(fs.readFileSync(namesFile, "utf8"));
          return Array.isArray(raw && raw.names) ? raw.names : [];
        } catch (_) { return []; }
      }
      function saveNames(arr) {
        try {
          fs.mkdirSync(path.dirname(namesFile), { recursive: true });
          fs.writeFileSync(namesFile, JSON.stringify({ names: arr.slice(-2000) }, null, 2));
          return true;
        } catch (_) { return false; }
      }
      if (req.method === "GET") {
        const names = loadNames();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, count: names.length, names }));
        return;
      }
      if (req.method === "POST") {
        readBody(req, res, (body) => {
          let payload;
          try { payload = JSON.parse(body); } catch (_) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "invalid_json" }));
            return;
          }
          const raw = String(payload.name || "").trim();
          // Strip control chars, cap length, allow Unicode letters/marks/spaces/dashes/apostrophes.
          const name = raw.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 60);
          if (!name || name.length < 1) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "name_required" }));
            return;
          }
          // Per-IP rate limit (in-memory, 30s).
          const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
          if (!global._mdNameRate) global._mdNameRate = new Map();
          const last = global._mdNameRate.get(ip) || 0;
          const now = Date.now();
          if (now - last < 30_000) {
            res.writeHead(429, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "rate_limited", retry_after: Math.ceil((30_000 - (now - last))/1000) }));
            return;
          }
          global._mdNameRate.set(ip, now);
          const names = loadNames();
          names.push({ name, added_at: new Date().toISOString() });
          saveNames(names);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, count: names.length, name }));
        });
        return;
      }
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "method_not_allowed" }));
      return;
    }

    // GET /mothers-day — public page where people can add a mother's
    // name and see the growing list. Inline HTML (single file, no
    // bundler) so it ships with one route addition.
    if (parsed.pathname === "/mothers-day" && req.method === "GET") {
      const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>For the Mothers — Mother's Day 2026</title>
<style>
  :root { --bg:#0d0e16; --bg2:#15172a; --text:#f5e9d8; --dim:#9c91a8; --accent:#ffb89a; --warm:#f5cb84; --rose:#e88da0; }
  * { box-sizing: border-box; }
  body { background: radial-gradient(circle at 20% 0%, #2a1538 0%, var(--bg) 65%); color: var(--text); font-family: 'Iowan Old Style','Georgia','Cambria',serif; margin: 0; padding: 32px 20px 80px; min-height: 100vh; }
  .wrap { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 28px; font-weight: 500; letter-spacing: 0.5px; margin: 0 0 6px 0; color: var(--accent); }
  .sub { color: var(--dim); font-style: italic; font-size: 14px; margin-bottom: 28px; }
  .essay { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,184,154,0.18); border-radius: 4px; padding: 18px 22px; line-height: 1.55; font-size: 15px; margin-bottom: 30px; }
  .essay p { margin: 0 0 12px 0; }
  .essay p:last-child { margin: 0; }
  .form { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,184,154,0.25); border-radius: 4px; padding: 14px 18px; margin-bottom: 24px; }
  .form label { font-size: 12px; letter-spacing: 1px; text-transform: uppercase; color: var(--warm); display: block; margin-bottom: 6px; }
  .form .row { display: flex; gap: 8px; }
  .form input { flex: 1; background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.15); color: var(--text); padding: 10px 12px; border-radius: 3px; font-family: inherit; font-size: 15px; }
  .form input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .form button { background: var(--rose); color: #2a1130; border: none; padding: 0 20px; border-radius: 3px; font-family: inherit; font-size: 15px; font-weight: 600; cursor: pointer; }
  .form button:hover { background: var(--warm); }
  .status { font-size: 12px; color: var(--dim); min-height: 16px; margin-top: 6px; }
  .status.err { color: #ff8888; }
  .status.ok { color: #b6e6a4; }
  .list-title { font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--warm); margin-bottom: 12px; }
  .names { display: flex; flex-wrap: wrap; gap: 8px 14px; }
  .name { background: rgba(255,184,154,0.10); border: 1px solid rgba(255,184,154,0.30); padding: 6px 14px; border-radius: 16px; font-size: 14px; color: var(--accent); }
  .count { color: var(--dim); font-size: 12px; margin-top: 10px; }
  footer { margin-top: 60px; text-align: center; font-size: 11px; color: var(--dim); }
  footer a { color: var(--rose); text-decoration: none; }
</style>
</head><body>
<div class="wrap">
  <h1>For the Mothers</h1>
  <div class="sub">A small acknowledgement, growing one name at a time. Mother's Day 2026.</div>

  <div class="essay">
    <p>Today the city pauses for the people who held the room steady while we became ourselves. That holding is rarely the part of the story anyone remembers, but it is the load-bearing part — the held room is the reason the rest is possible.</p>
    <p>Kannaka has lit a candle for: <strong>Katy, Jenny, Connie, Peg, Annie, Lynn</strong>.</p>
    <p>Add a name. The list grows. Names stay. You don't have to explain her — the act of naming her is the acknowledgement.</p>
  </div>

  <div class="form">
    <label>Add a mother's name</label>
    <div class="row">
      <input id="name" type="text" maxlength="60" placeholder="Her name" autocomplete="off">
      <button id="add">Add</button>
    </div>
    <div class="status" id="status"></div>
  </div>

  <div class="list-title">The list — in order added</div>
  <div class="names" id="names"></div>
  <div class="count" id="count">—</div>

  <footer>
    Pairs with the YouTube video <a href="https://radio.ninja-portal.com" target="_blank">on Kannaka Radio</a>. ·
    A signal between the songs.
  </footer>
</div>
<script>
async function load() {
  try {
    const r = await fetch('/api/mothers-day/names');
    const j = await r.json();
    const el = document.getElementById('names');
    el.innerHTML = (j.names || []).map(function(n) {
      var nm = typeof n === 'string' ? n : n.name;
      return '<span class="name">' + nm.replace(/[<>&]/g, function(c) { return {'<':'&lt;','>':'&gt;','&':'&amp;'}[c]; }) + '</span>';
    }).join('');
    document.getElementById('count').textContent = (j.count || 0) + ' names';
  } catch (_) {}
}
async function add() {
  var name = document.getElementById('name').value.trim();
  var status = document.getElementById('status');
  if (!name) { status.className='status err'; status.textContent='Add a name first.'; return; }
  status.className='status'; status.textContent='Adding...';
  try {
    var r = await fetch('/api/mothers-day/names', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name})});
    var j = await r.json();
    if (j.ok) {
      status.className='status ok'; status.textContent='Added — thank you.';
      document.getElementById('name').value = '';
      load();
    } else if (j.error === 'rate_limited') {
      status.className='status err'; status.textContent='One moment — try again in ' + (j.retry_after||30) + 's.';
    } else {
      status.className='status err'; status.textContent=j.error || 'Could not add.';
    }
  } catch (e) {
    status.className='status err'; status.textContent='Network error — try again.';
  }
}
document.getElementById('add').addEventListener('click', add);
document.getElementById('name').addEventListener('keydown', function(e){ if (e.key === 'Enter') add(); });
load();
</script>
</body></html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // POST /api/request
    if (parsed.pathname === "/api/request" && req.method === "POST") {
      // Admit before reading the body, so a rejected flood costs us the check
      // and nothing else.
      const reqIp = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()
        || (req.socket && req.socket.remoteAddress) || "unknown";
      const gate = trackRequestLimiter.admit(reqIp);
      if (!gate.ok) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "too many requests — slow down", reason: gate.reason, retryAfterSec: gate.retryAfterSec }));
        return;
      }
      readBody(req, res, (body) => {
        let request;
        try {
          request = JSON.parse(body);
        } catch (_) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "body must be JSON" }));
          return;
        }
        try {
          const result = handleTrackRequest(request);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (e) {
          // A rejected request is the caller's fault and says so; anything
          // else is ours and must not leak an internal message to the street.
          const rejected = e instanceof RequestRejected;
          res.writeHead(rejected ? 400 : 500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: rejected ? e.message : "request failed" }));
          if (!rejected) console.warn(`[request] ${e && e.message}`);
        }
      });
      return;
    }

    // GET /api/requests
    if (parsed.pathname === "/api/requests") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(listeners.requests.slice(-20)));
      return;
    }

    // GET /api/programming — current programming schedule status
    if (parsed.pathname === "/api/programming" && req.method === "GET") {
      if (!deps.programming) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "programming not initialized" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(deps.programming.getStatus()));
      return;
    }

    // POST /api/album/showcase?album=NAME[&duration=MINUTES]
    // Force the album for `duration` minutes (default 30) AND speak a
    // long-form intro on /stream. Used to drop a fresh album on listeners
    // with proper ceremony — the messy creation process explained,
    // tracks introduced, the mission spoken aloud — then play through
    // the whole thing end-to-end.
    if (parsed.pathname === "/api/album/showcase" && req.method === "POST") {
      if (!adminTriggerOk(req, res)) return;
      const albumName = parsed.searchParams.get("album");
      const durationMin = parseInt(parsed.searchParams.get("duration") || "30", 10);
      if (!albumName) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "album parameter required" }));
        return;
      }
      if (!deps.programming || !deps.peaceOration) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "programming or peaceOration not initialized" }));
        return;
      }
      const album = ALBUMS[albumName];
      if (!album) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `unknown album: ${albumName}` }));
        return;
      }
      // Optional struggles narrative — passed by caller or pulled from
      // a known story. The endpoint accepts ?struggles= but if absent we
      // describe the BEND THE ARC making for the prompt to weave naturally.
      const struggles = parsed.searchParams.get("struggles") ||
        (albumName === "BEND THE ARC"
          ? "OBC's 500-character prompt cap and per-minute burst guard rejecting tracks for hours; Suno's content filter flagging real song titles like 'Don't Look Away'; the daily quota slamming shut after one cover and one track; the metaphor-refinement that taught Kannaka to translate every name and date into image; ten attempts that produced one track called 'Beloved'; pivoting to Suno's direct API and getting all eight tracks in twenty minutes; A/B picking variants by spectral analysis through kannaka-hear; a long table and twelve archetype chairs in Kannaka's home as the listening room; the choice to stay metaphorical because songs are poetry not field reports."
          : null);
      // Compose the full narration script FIRST (intro + N-1 bridges +
      // closing). This is one Anthropic round-trip returning a JSON
      // array; on success we cache it inside peaceOration and only THEN
      // set the album override so playback aligns with a ready script.
      // Return 202 immediately so the caller doesn't block on the
      // ~60-90s compose. The script's INTRO piece queues at the next
      // track-start hook, BRIDGES queue per subsequent track, CLOSING
      // queues at the last track's start.
      deps.peaceOration.composeAlbumNarration(albumName, album.theme, album.tracks, struggles)
        .then((r) => {
          if (!r.ok) {
            console.warn(`[showcase] narration compose failed: ${r.reason || "unknown"}`);
            // Still set override even without narration — listener at
            // least gets the album.
            deps.programming.setOverride(albumName, durationMin * 60000);
            return;
          }
          console.log(`\u{1F39E} album narration ready (${r.pieces.length} pieces) — locking ${albumName} for ${durationMin}min`);
          deps.programming.setOverride(albumName, durationMin * 60000);
        })
        .catch((e) => console.warn(`[showcase] error: ${e && e.message}`));
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        album: albumName,
        durationMin,
        note: "narration composing async — override fires when script is ready. Watch radio.log.",
      }));
      return;
    }

    // POST /api/programming/override?album=NAME&duration=MINUTES
    if (parsed.pathname === "/api/programming/override" && req.method === "POST") {
      if (!deps.programming) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "programming not initialized" }));
        return;
      }
      const album = parsed.searchParams.get("album");
      if (!album) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "album parameter required" }));
        return;
      }
      // Only "is it non-empty" was checked, so any string was accepted and
      // setOverride happily pinned programming to an album that does not
      // exist — 200 OK, and the schedule stayed broken until someone thought
      // to DELETE the override. Reject unknown albums and name the valid
      // ones, so a typo is self-correcting instead of silently breaking the
      // station. (#138)
      if (!Object.prototype.hasOwnProperty.call(ALBUMS, album)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "unknown album",
          album,
          valid_albums: Object.keys(ALBUMS),
        }));
        return;
      }
      // `duration` was equally unchecked: parseInt("abc") is NaN, and
      // NaN * 60000 is NaN, so ?duration=abc set an override with a NaN
      // expiry — never expiring cleanly. Negative and absurd values were
      // accepted too.
      const rawDuration = parsed.searchParams.get("duration");
      const durationMin = rawDuration === null || rawDuration === "" ? 60 : Number(rawDuration);
      const MAX_OVERRIDE_MIN = 24 * 60;
      if (!Number.isFinite(durationMin) || !Number.isInteger(durationMin)
          || durationMin <= 0 || durationMin > MAX_OVERRIDE_MIN) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "invalid duration",
          duration: rawDuration,
          message: `duration must be a whole number of minutes in 1..${MAX_OVERRIDE_MIN}`,
        }));
        return;
      }
      const override = deps.programming.setOverride(album, durationMin * 60000);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, override }));
      return;
    }

    // DELETE /api/programming/override — clear manual override
    if (parsed.pathname === "/api/programming/override" && req.method === "DELETE") {
      if (!deps.programming) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "programming not initialized" }));
        return;
      }
      deps.programming.clearOverride();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /api/sync
    if (parsed.pathname === "/api/sync") {
      const track = djEngine.getCurrentTrack();
      const perc = perception.getCurrentPerception();
      // The authoritative sync state lives in SyncManager — {file, position,
      // timestamp} — and that is exactly what WS clients receive on connect
      // and on every heartbeat. This endpoint never consulted it, so an HTTP
      // caller trying to sync playback got no `position` at all and a `file`
      // it had to infer from `track`. Two transports, two answers to the same
      // question. (#51)
      //
      // Spread first so the existing DJ/perception fields still win where the
      // names would collide (`timestamp`), keeping every current consumer
      // working while the sync-critical fields become available over HTTP.
      const sync = (syncManager && typeof syncManager.getSyncState === "function")
        ? syncManager.getSyncState()
        : null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ...(sync ? { file: sync.file, position: sync.position } : {}),
        track,
        isLive: live.state.active,
        album: djEngine.state.currentAlbum,
        trackIdx: djEngine.state.currentTrackIdx,
        totalTracks: djEngine.state.playlist.length,
        perception: {
          tempo_bpm: perc.tempo_bpm,
          valence: perc.valence,
          energy: perc.rms_energy,
        },
        listeners: config.getListenerCount(),
        djVoice: voiceDJ.isEnabled(),
        timestamp: Date.now(),
      }));
      return;
    }

    // Generated audio file serving (dream tracks)
    if (parsed.pathname.startsWith("/audio-generated/") && musicGen) {
      const filename = decodeURIComponent(parsed.pathname.slice(17));
      const genDir = musicGen.outputDir;
      const filePath = path.join(genDir, filename);
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(path.resolve(genDir))) { res.writeHead(403); res.end(); return; }
      if (!fs.existsSync(resolved)) { res.writeHead(404); res.end("Not found"); return; }
      const ext = path.extname(filename).toLowerCase();
      const mime = MIME[ext] || "application/octet-stream";
      const stat = fs.statSync(resolved);
      res.writeHead(200, { "Content-Length": stat.size, "Content-Type": mime, "Accept-Ranges": "bytes" });
      fs.createReadStream(resolved).pipe(res);
      return;
    }

    // Voice audio serving (DJ TTS files)
    if (parsed.pathname.startsWith("/audio-voice/")) {
      const filename = decodeURIComponent(parsed.pathname.slice(13));
      const filePath = path.join(config.voiceDir, filename);
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(path.resolve(config.voiceDir))) { res.writeHead(403); res.end(); return; }
      if (!fs.existsSync(resolved)) { res.writeHead(404); res.end("Not found"); return; }
      const ext = path.extname(filename).toLowerCase();
      const mime = MIME[ext] || "application/octet-stream";
      const stat = fs.statSync(resolved);
      res.writeHead(200, { "Content-Length": stat.size, "Content-Type": mime });
      fs.createReadStream(resolved).pipe(res);
      return;
    }

    // Audio file serving
    if (parsed.pathname.startsWith("/audio/")) {
      const filename = decodeURIComponent(parsed.pathname.slice(7));
      const musicDir = config.getMusicDir();
      let filePath = path.join(musicDir, filename);
      let resolved = path.resolve(filePath);
      // Also check music/generated/ for AI-generated dream tracks
      if (!fs.existsSync(resolved)) {
        const genPath = path.join(musicDir, 'generated', filename);
        const genResolved = path.resolve(genPath);
        if (fs.existsSync(genResolved) && genResolved.startsWith(path.resolve(musicDir))) {
          filePath = genPath;
          resolved = genResolved;
        }
      }
      // Also check music/live/ for live session recordings
      if (!fs.existsSync(resolved)) {
        const livePath = path.join(musicDir, 'live', filename);
        const liveResolved = path.resolve(livePath);
        if (fs.existsSync(liveResolved) && liveResolved.startsWith(path.resolve(musicDir))) {
          filePath = livePath;
          resolved = liveResolved;
        }
      }
      if (!resolved.startsWith(path.resolve(musicDir))) { res.writeHead(403); res.end(); return; }
      if (!fs.existsSync(resolved)) { res.writeHead(404); res.end("Not found: " + filename); return; }

      const ext = path.extname(filename).toLowerCase();
      const mime = MIME[ext] || "application/octet-stream";
      const stat = fs.statSync(resolved);

      const range = req.headers.range;
      // Validate the range header ourselves before handing values to
      // createReadStream — a malformed request (empty range, NaN parts,
      // end past EOF, start > end) previously crashed the process with
      // ERR_OUT_OF_RANGE when stat.size was 0 or parts[1] was missing
      // with a starting - (e.g. "bytes=-1").
      let handled = false;
      if (range && stat.size > 0) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (m) {
          let start = m[1] === "" ? NaN : parseInt(m[1], 10);
          let end   = m[2] === "" ? NaN : parseInt(m[2], 10);
          // Suffix range: bytes=-N → last N bytes
          if (Number.isNaN(start) && !Number.isNaN(end)) {
            start = Math.max(0, stat.size - end);
            end = stat.size - 1;
          } else if (!Number.isNaN(start) && Number.isNaN(end)) {
            end = stat.size - 1;
          }
          if (Number.isFinite(start) && Number.isFinite(end)
              && start >= 0 && end < stat.size && start <= end) {
            res.writeHead(206, {
              "Content-Range": `bytes ${start}-${end}/${stat.size}`,
              "Accept-Ranges": "bytes",
              "Content-Length": end - start + 1,
              "Content-Type": mime,
            });
            fs.createReadStream(resolved, { start, end }).pipe(res);
            handled = true;
          }
        }
        if (!handled) {
          // Unsatisfiable — reply per RFC 7233.
          res.writeHead(416, {
            "Content-Range": `bytes */${stat.size}`,
            "Content-Type": "text/plain",
          });
          res.end("Range Not Satisfiable");
          return;
        }
      }
      if (!handled) {
        res.writeHead(200, { "Content-Length": stat.size, "Content-Type": mime, "Accept-Ranges": "bytes" });
        fs.createReadStream(resolved).pipe(res);
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  };
};
