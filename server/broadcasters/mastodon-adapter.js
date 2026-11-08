/**
 * Mastodon adapter — POST {instance}/api/v1/statuses with a bearer token.
 * Default char limit 500 (configurable per instance — Pleroma/Akkoma allow
 * higher, mainline Mastodon defaults to 500).
 *
 * Credentials in /home/opc/kannaka-radio/.mastodon.json:
 *   {
 *     "instance": "https://mastodon.social",
 *     "accessToken": "..."
 *   }
 * or env: MASTODON_INSTANCE + MASTODON_ACCESS_TOKEN.
 *
 * To get a token: log in to your Mastodon instance, Preferences →
 * Development → New Application → scopes: read, write. Copy the access
 * token from the application page.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const https = require("https");
const http = require("http");
const { tagsFor, composeForFeed } = require("./discovery");

const POST_MAX = 480; // 500 minus a safety margin for any auto-appended suffix

class MastodonAdapter {
  constructor(rootDir) {
    this.name = "mastodon";
    this._creds = _loadCreds(rootDir);
  }

  isEnabled() {
    return !!(this._creds && this._creds.instance && this._creds.accessToken);
  }

  async post({ text, link, topic, image }) {
    // Mastodon discovery is hashtag-driven (no algorithm — local + federated
    // timelines are pure hashtag streams). Drop the URL from the body
    // (penalty + character cost) and append 4-5 hashtags as a footer.
    const tags = tagsFor(topic, 5);
    const status = composeForFeed(text, tags, POST_MAX);

    // Optional image (e.g. an OBC gallery artifact). Upload it first, then
    // attach by id. A failed media upload must NOT sink the text post — log
    // and continue without the attachment.
    let mediaIds = null;
    if (image && image.url) {
      try {
        const id = await this._uploadMedia(image);
        if (id) mediaIds = [id];
      } catch (e) {
        process.stderr.write(`[mastodon] media upload failed: ${e.message}\n`);
      }
    }

    const url = new URL("/api/v1/statuses", this._creds.instance);
    const body = JSON.stringify({
      status,
      visibility: "public",
      ...(mediaIds ? { media_ids: mediaIds } : {}),
      // Mastodon auto-detects URLs and renders them as links — no facets needed.
    });
    const opts = {
      method: "POST",
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + this._creds.accessToken,
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "Kannaka-Radio/0.3 (https://radio.ninja-portal.com)",
      },
      timeout: 15000,
    };
    return new Promise((resolve) => {
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.request(opts, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              const j = JSON.parse(data);
              resolve({ ok: true, url: j.url, id: j.id });
            } catch (e) {
              resolve({ ok: false, error: "bad json: " + e.message });
            }
          } else {
            resolve({ ok: false, error: `mastodon ${res.statusCode}: ${data.slice(0, 200)}` });
          }
        });
      });
      req.on("error", (e) => resolve({ ok: false, error: e.message }));
      req.on("timeout", () => { req.destroy(new Error("mastodon timeout")); });
      req.write(body);
      req.end();
    });
  }

  /**
   * Reply to a prior status. `parent.id` is the Mastodon status id returned by
   * post(). The reply body is posted verbatim (no hashtag footer) so a video
   * link lands clean as a comment.
   */
  async reply(text, parent) {
    if (!this.isEnabled()) return { ok: false, error: "not_configured" };
    if (!parent || !parent.id) return { ok: false, error: "missing_parent_id" };
    const url = new URL("/api/v1/statuses", this._creds.instance);
    const body = JSON.stringify({
      status: _truncate((text || "").trim(), POST_MAX),
      visibility: "public",
      in_reply_to_id: String(parent.id),
    });
    const opts = {
      method: "POST",
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + this._creds.accessToken,
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "Kannaka-Radio/0.3 (https://radio.ninja-portal.com)",
      },
      timeout: 15000,
    };
    return new Promise((resolve) => {
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.request(opts, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              const j = JSON.parse(data);
              resolve({ ok: true, url: j.url, id: j.id });
            } catch (e) {
              resolve({ ok: false, error: "bad json: " + e.message });
            }
          } else {
            resolve({ ok: false, error: `mastodon ${res.statusCode}: ${data.slice(0, 200)}` });
          }
        });
      });
      req.on("error", (e) => resolve({ ok: false, error: e.message }));
      req.on("timeout", () => { req.destroy(new Error("mastodon timeout")); });
      req.write(body);
      req.end();
    });
  }

  /**
   * Read recent mention notifications (people @-mentioning Kannaka). Returns
   * [{ notifId, statusId, author, text(html), inReplyToId }] newest-first,
   * best-effort ([] on any failure). Used by the engagement loop.
   */
  async getMentions(sinceId, limit = 20) {
    if (!this.isEnabled()) return [];
    const params = new URLSearchParams();
    params.set("limit", String(Math.min(40, Math.max(1, limit))));
    params.append("types[]", "mention");
    if (sinceId) params.set("since_id", String(sinceId));
    const url = new URL(`/api/v1/notifications?${params.toString()}`, this._creds.instance);
    return new Promise((resolve) => {
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.request(
        {
          method: "GET",
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: url.pathname + url.search,
          headers: {
            Authorization: "Bearer " + this._creds.accessToken,
            "User-Agent": "Kannaka-Radio/0.3 (https://radio.ninja-portal.com)",
          },
          timeout: 15000,
        },
        (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () => {
            if (res.statusCode !== 200) return resolve([]);
            try {
              const arr = JSON.parse(d);
              if (!Array.isArray(arr)) return resolve([]);
              resolve(
                arr
                  .filter((n) => n && n.type === "mention" && n.status)
                  .map((n) => ({
                    notifId: n.id,
                    statusId: n.status.id,
                    author: (n.account && n.account.acct) || "?",
                    text: n.status.content || "",
                    inReplyToId: n.status.in_reply_to_id || null,
                  })),
              );
            } catch {
              resolve([]);
            }
          });
        },
      );
      req.on("error", () => resolve([]));
      req.on("timeout", () => { req.destroy(); resolve([]); });
      req.end();
    });
  }

  /**
   * Fetch an image URL and upload it to Mastodon's media endpoint, returning
   * the attachment id (usable in media_ids immediately, even while the server
   * is still processing). Throws on any failure so the caller can decide to
   * post without the image.
   */
  async _uploadMedia(image) {
    const { buf, mime } = await _fetchBytes(image.url);
    const boundary = "kannaka-media-" + Math.random().toString(16).slice(2);
    const filename = "art" + (mime === "image/png" ? ".png" : mime === "image/webp" ? ".webp" : ".jpg");
    const parts = [
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `Content-Type: ${mime}\r\n\r\n`,
        "utf8",
      ),
      buf,
    ];
    if (image.alt) {
      parts.push(Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="description"\r\n\r\n${image.alt}`,
        "utf8",
      ));
    }
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
    const body = Buffer.concat(parts);

    const url = new URL("/api/v2/media", this._creds.instance);
    const opts = {
      method: "POST",
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        Authorization: "Bearer " + this._creds.accessToken,
        "Content-Length": body.length,
        "User-Agent": "Kannaka-Radio/0.3 (https://radio.ninja-portal.com)",
      },
      timeout: 30000,
    };
    return new Promise((resolve, reject) => {
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.request(opts, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          // 200 = ready, 202 = accepted/processing; both return the id.
          if (res.statusCode === 200 || res.statusCode === 202) {
            try { resolve(JSON.parse(data).id); }
            catch (e) { reject(new Error("bad media json: " + e.message)); }
          } else {
            reject(new Error(`media ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      });
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("media upload timeout")));
      req.write(body);
      req.end();
    });
  }
}

/**
 * GET a URL into a Buffer, following one level of redirect (image hosts like
 * Supabase storage often 302 to a CDN). Resolves { buf, mime }.
 */
function _fetchBytes(rawUrl, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 3) return reject(new Error("too many redirects"));
    const u = new URL(rawUrl);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        method: "GET",
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        headers: { "User-Agent": "Kannaka-Radio/0.3" },
        timeout: 30000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(_fetchBytes(new URL(res.headers.location, u).toString(), redirects + 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`fetch ${res.statusCode} for ${rawUrl}`));
          return;
        }
        const mime = (res.headers["content-type"] || "image/jpeg").split(";")[0].trim();
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ buf: Buffer.concat(chunks), mime }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("fetch timeout")));
    req.end();
  });
}

function _loadCreds(rootDir) {
  const envInst = process.env.MASTODON_INSTANCE;
  const envTok = process.env.MASTODON_ACCESS_TOKEN;
  if (envInst && envTok) return { instance: envInst, accessToken: envTok };
  try {
    const p = path.join(rootDir || ".", ".mastodon.json");
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      if (j.instance && j.accessToken) return j;
    }
  } catch (_) { /* fall through */ }
  return null;
}

function _composeWithLink(text, link, limit) {
  if (!link) return _truncate(text || "", limit);
  const suffix = `\n\n${link}`; // newlines render cleaner on Mastodon
  const budget = limit - suffix.length - 1;
  return _truncate((text || "").trim(), budget) + suffix;
}

function _truncate(s, limit) {
  if (!s) return "";
  if (s.length <= limit) return s;
  const hard = limit - 1;
  const soft = s.lastIndexOf(" ", hard - 3);
  const cut = soft > hard * 0.7 ? soft : hard;
  return s.slice(0, cut).trim() + "\u2026";
}

// A script that calls post() itself (an upload, a one-network announce) is
// remembered in her store too; broadcastPost's own calls are not (it
// remembers the whole fanout once). See voice-writeback.js wrapDirectPost.
require("../voice-writeback").wrapDirectPost(MastodonAdapter);

module.exports = { MastodonAdapter };
