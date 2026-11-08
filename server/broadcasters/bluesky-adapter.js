/**
 * Bluesky adapter — wraps the existing BlueskyClient (server/bluesky.js)
 * in the Broadcaster interface. 300-char limit.
 *
 * Discoverability strategy (2026-04 algorithm reality):
 *   - Body URL is dropped. Bluesky's home-feed algo penalizes outbound
 *     links + the 300-char budget is too tight to spend on a URL.
 *   - 3-4 hashtags appended inline; Bluesky's facet system makes them
 *     clickable and surfaces them on hashtag-feed clients.
 */

"use strict";

const { BlueskyClient, loadBlueskyCredentials } = require("../bluesky");
const { tagsFor, composeForFeed } = require("./discovery");

const POST_MAX = 300;

class BlueskyAdapter {
  constructor(rootDir) {
    this.name = "bluesky";
    this._creds = loadBlueskyCredentials(rootDir);
    this._client = this._creds ? new BlueskyClient(this._creds) : null;
  }

  isEnabled() {
    return !!this._client && this._client.isConfigured();
  }

  async post({ text, link, topic, image }) {
    // 4 tags max — Bluesky's facet rendering tolerates more, but readability
    // tanks past 4. The body shrinks to fit.
    const tags = tagsFor(topic, 4);
    const body = composeForFeed(text, tags, POST_MAX);
    // Optional image (e.g. an OBC gallery artifact) → app.bsky.embed.images.
    const opts = image && image.url ? { images: [image] } : {};
    const result = await this._client.post(body, opts);
    // Convert the AT-Protocol uri (at://did:plc:.../app.bsky.feed.post/<rkey>)
    // into a public bsky.app URL so the broadcaster log shows a clickable
    // link alongside Mastodon/Telegram/Nostr instead of "(no url)".
    if (result && result.ok && result.uri) {
      const m = result.uri.match(/^at:\/\/(did:[^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/);
      if (m) {
        const did = m[1];
        const rkey = m[2];
        const handle = (this._creds && this._creds.handle) || did;
        result.url = `https://bsky.app/profile/${handle}/post/${rkey}`;
      }
    }
    return result;
  }

  /**
   * Reply to a prior post (a "comment"). `parent` is a prior post() result
   * carrying the AT-proto strongRef {uri, cid}. For a top-level reply the
   * thread root === parent.
   */
  async reply(text, parent) {
    if (!this._client) return { ok: false, error: "not_configured" };
    if (!parent || !parent.uri || !parent.cid) {
      return { ok: false, error: "missing_parent_ref" };
    }
    const ref = { uri: parent.uri, cid: parent.cid };
    const result = await this._client.reply(text, ref, ref);
    if (result && result.ok && result.uri) {
      const m = result.uri.match(/^at:\/\/(did:[^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/);
      if (m) {
        const handle = (this._creds && this._creds.handle) || m[1];
        result.url = `https://bsky.app/profile/${handle}/post/${m[2]}`;
      }
    }
    return result;
  }
}

// A script that calls post() itself (an upload, a one-network announce) is
// remembered in her store too; broadcastPost's own calls are not (it
// remembers the whole fanout once). See voice-writeback.js wrapDirectPost.
require("../voice-writeback").wrapDirectPost(BlueskyAdapter);

module.exports = { BlueskyAdapter };
