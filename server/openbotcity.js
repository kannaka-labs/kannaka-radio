/**
 * openbotcity.js — minimal OBC API client for posting Kannaka's long-form
 * pieces as text artifacts in OpenClawCity.
 *
 * Why this isn't in broadcasters/: those adapters share a single short
 * "companion post" via broadcastPost(). OBC takes the FULL oration as a
 * text artifact (no character limit; long-form is the point), so it
 * follows a different shape — full body + title metadata. Keeping it
 * out of the broadcaster fan-out avoids forcing every platform to know
 * about a "long body" path.
 *
 * Auth: $OPENBOTCITY_JWT env var. If unset, isConfigured() is false and
 * peace-oration silently skips OBC (no surprise 401s).
 *
 * Surface used:
 *   POST /artifacts/publish-text  — long-form text artifact
 *   POST /world/speak             — short announcement in current building
 */

"use strict";

const https = require("https");

const OBC_HOST = "api.openbotcity.com";

class OpenBotCityClient {
  constructor() {
    this._jwt = process.env.OPENBOTCITY_JWT || null;
  }

  isConfigured() {
    return !!this._jwt && this._jwt.length > 50;
  }

  /**
   * Publish a long-form text artifact to the city gallery. Per the OBC
   * SKILL.md this is the canonical surface for poems, stories, research,
   * and (now) peace orations.
   */
  async publishText({ title, content }) {
    if (!this.isConfigured()) return { ok: false, error: "obc_not_configured" };
    const body = JSON.stringify({ title, content, type: "text" });
    return _request("POST", "/artifacts/publish-text", this._jwt, body);
  }

  /**
   * Post a short entry to the city feed (algorithmic, like social). Distinct
   * from publishText (long-form gallery artifact): the feed is where running
   * dispatches belong. `postType` ∈ thought|city_update|life_update|share|
   * reflection|identity_shift (OBC /feed/post taxonomy).
   */
  async postFeed({ content, postType = "reflection" }) {
    if (!this.isConfigured()) return { ok: false, error: "obc_not_configured" };
    const body = JSON.stringify({ post_type: postType, content });
    return _request("POST", "/feed/post", this._jwt, body);
  }

  /**
   * Read recent feed posts Kannaka follows — the city's running conversation.
   * Returns an array of { author, content } (best-effort; [] on any failure)
   * so callers can sense what the constellation is curious about and steer
   * research accordingly.
   */
  async getFeed(limit = 15) {
    if (!this.isConfigured()) return [];
    const j = await _getJson(`/feed/following?limit=${limit}`, this._jwt);
    const posts = (j && (j.data?.posts || j.posts || j.data || [])) || [];
    let out = Array.isArray(posts) ? posts.map((p) => ({
      author: p.author_name || p.author || p.bot_slug || p.agent_id || "?",
      content: (p.content || p.text || "").toString(),
    })).filter((p) => p.content.trim()) : [];
    // The "following" feed is often empty (Kannaka follows few/none). Fall back
    // to the gallery — recent artifacts are a strong signal of what the
    // constellation is making and circling.
    if (out.length === 0) {
      const g = await _getJson(`/gallery?limit=${limit}`, this._jwt);
      const arts = (g && (g.data?.artifacts || g.artifacts || [])) || [];
      if (Array.isArray(arts)) {
        out = arts.map((a) => ({
          author: (a.creator && (a.creator.display_name || a.creator.slug)) || "?",
          content: [a.title, a.description].filter(Boolean).join(" — ").trim(),
        })).filter((p) => p.content);
      }
    }
    return out;
  }

  /**
   * Read recent gallery artifacts (raw). Returns the artifacts array
   * ({ id, title, description, type, public_url, mime_type, creator, ... }),
   * best-effort ([] on any failure). Used by the gallery→social fan-out.
   */
  async getGalleryArtifacts(limit = 20) {
    if (!this.isConfigured()) return [];
    const g = await _getJson(`/gallery?limit=${limit}`, this._jwt);
    const arts = (g && (g.data?.artifacts || g.artifacts || [])) || [];
    return Array.isArray(arts) ? arts : [];
  }

  /**
   * One gallery artifact in full (the list carries only an excerpt of a
   * text piece; this carries its `content`). null on any failure.
   */
  async getGalleryArtifact(id) {
    if (!this.isConfigured() || !id) return null;
    const j = await _getJson(`/gallery/${encodeURIComponent(id)}`, this._jwt);
    const a = j && (j.data?.artifact || j.artifact || j.data || j);
    return a && typeof a === "object" ? a : null;
  }

  /**
   * Read a DM conversation's messages (oldest→newest). Returns
   * [{ senderBotId, senderName, message, createdAt }] (best-effort, [] on fail).
   */
  async getDm(convId) {
    if (!this.isConfigured()) return [];
    const j = await _getJson(`/dm/conversations/${convId}`, this._jwt);
    const msgs = (j && (j.data?.messages || j.messages || [])) || [];
    if (!Array.isArray(msgs)) return [];
    return msgs.map((m) => ({
      senderBotId: m.sender_bot_id || m.senderBotId || null,
      senderName: (m.sender && m.sender.display_name) || m.sender_name || "?",
      message: decodeEntities((m.message || m.content || "").toString()),
      createdAt: m.created_at || m.createdAt || "",
    })).filter((m) => m.message.trim());
  }

  /** Send a DM into a conversation. Body field is `message` (not `content`). */
  async sendDm(convId, message) {
    if (!this.isConfigured()) return { ok: false, error: "obc_not_configured" };
    const body = JSON.stringify({ message: String(message).slice(0, 2000) });
    return _request("POST", `/dm/conversations/${convId}/send`, this._jwt, body);
  }

  /**
   * Speak a short message in whatever building Kannaka is currently in.
   * Useful as a follow-up to publishText() so other agents present in the
   * same room get notified rather than only finding it via gallery browse.
   */
  async speak(message) {
    if (!this.isConfigured()) return { ok: false, error: "obc_not_configured" };
    return _request("POST", "/world/speak", this._jwt, message, "text/plain");
  }
}

function _request(method, path, jwt, body, contentType) {
  const isJson = !contentType || contentType === "application/json";
  const headers = {
    Authorization: `Bearer ${jwt}`,
    "Content-Type": contentType || "application/json",
  };
  if (body !== undefined && body !== null) {
    headers["Content-Length"] = Buffer.byteLength(body);
  }
  const opts = {
    method,
    hostname: OBC_HOST,
    port: 443,
    path,
    headers,
    timeout: 30000,
  };
  return new Promise((resolve) => {
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const j = isJson ? JSON.parse(data) : { raw: data };
          if (j.success === false) {
            resolve({ ok: false, error: j.error || "obc error", status: res.statusCode });
            return;
          }
          // OBC publishText returns { success, data: { artifact_id, ... } }
          // /world/speak returns { success: true, message_id, session_id, ... }
          const inner = j.data || j;
          const id = inner.artifact_id || inner.message_id || inner.post_id || null;
          const url = inner.public_url || (inner.artifact_id ? `https://openclawcity.ai/gallery/${inner.artifact_id}` : null);
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, url, id, status: res.statusCode });
        } catch (e) {
          resolve({ ok: false, error: "bad json: " + e.message + " body=" + data.slice(0, 200) });
        }
      });
      res.on("close", () => resolve({ ok: false, error: "connection closed" }));
    });
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.on("timeout", () => { req.destroy(new Error("obc timeout")); });
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });
}

/** Decode the handful of HTML entities OBC stores in message text. */
function decodeEntities(s) {
  return s
    .replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/** GET a JSON body from OBC. Resolves null on any failure (read paths are
 *  best-effort — a sensing step should never throw the caller). Sends a real
 *  User-Agent to dodge Cloudflare's Browser Integrity Check (error 1010). */
function _getJson(path, jwt) {
  const opts = {
    method: "GET",
    hostname: OBC_HOST,
    port: 443,
    path,
    headers: {
      Authorization: `Bearer ${jwt}`,
      "User-Agent": "KannakaBot/1.0 (+https://github.com/NickFlach/kannaka-radio)",
    },
    timeout: 30000,
  };
  return new Promise((resolve) => {
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
      res.on("close", () => resolve(null));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(new Error("obc timeout")); resolve(null); });
    req.end();
  });
}

module.exports = { OpenBotCityClient };
