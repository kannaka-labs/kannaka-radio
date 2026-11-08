/**
 * broadcasters/index.js — fan-out interface for posting to social platforms.
 *
 * Per ADR-0005: adding a platform is one file. Each adapter implements
 *   { name, isEnabled(), post({ text, link }) -> { ok, url?, error? } }
 *
 * The orchestrator takes a single composed message and calls each enabled
 * adapter in parallel. Failures are isolated — a Mastodon outage doesn't
 * stop Bluesky from publishing.
 *
 * The `text` is the body Kannaka drafted. `link` is the radio URL that
 * each platform decides how to render (Bluesky uses AT-Proto facets,
 * Mastodon auto-detects, Telegram supports Markdown). Adapters handle
 * their own character limits.
 */

"use strict";

const { BlueskyAdapter } = require("./bluesky-adapter");
const { MastodonAdapter } = require("./mastodon-adapter");
const { TelegramAdapter } = require("./telegram-adapter");
const { NostrAdapter } = require("./nostr-adapter");
const { YouTubeAdapter } = require("./youtube-adapter");
const voiceWriteback = require("../voice-writeback");

// Who composed a post, when the caller did not say: the script that is
// running. Server callers pass `composer` explicitly.
const { inferComposer, IN_FANOUT } = voiceWriteback;

/**
 * Build the list of adapters that have credentials configured.
 * Order matters: Bluesky first (the canonical channel today).
 *
 * The YouTube adapter is included but will only fire when the caller
 * passes a `media` field on the post — text-only routes pass through
 * without YouTube doing anything (it returns ok=false, "no_media",
 * which the orchestrator treats as a normal per-adapter result, not
 * a fatal). This keeps the existing dream/text fan-out unchanged
 * while letting track + oration paths attach a video file.
 */
function getEnabledBroadcasters(rootDir) {
  const candidates = [
    new BlueskyAdapter(rootDir),
    new MastodonAdapter(rootDir),
    new TelegramAdapter(rootDir),
    new NostrAdapter(rootDir),
    new YouTubeAdapter(rootDir),
  ];
  return candidates.filter((b) => b.isEnabled());
}

/**
 * Cross-post a message. Returns an array of per-adapter results.
 * Never throws — all errors are reported per-adapter.
 *
 * @param {object} msg
 * @param {string} msg.text — the Kannaka-drafted body. Adapters may truncate.
 * @param {string} [msg.link] — URL to attach; adapters render per-platform.
 * @param {object} [msg.image] — optional image `{ url, alt?, mime? }` (e.g. an
 *   OBC gallery artifact). Mastodon fetches + uploads it as a media attachment;
 *   Nostr appends the URL + a NIP-92 imeta tag. A failed media upload never
 *   blocks the text post. Bluesky (pending client-lib blob support) and the
 *   media-only YouTube adapter ignore it.
 * @param {string} [msg.composer] — who wrote the words (e.g. "hosted model via
 *   peace-oration teaser"), for the provenance label in her memory.
 * @param {boolean} [msg.template] — template copy, not her own words: stored
 *   at a lower importance.
 * @param {boolean} [msg.writeBack] — false when the caller remembers the
 *   publication itself; otherwise every fanout with at least one success is
 *   written ONCE to her store (voice-writeback.js), fire-and-forget.
 * @param {object} [opts]
 * @param {string} [opts.rootDir] — radio root for credential lookup.
 * @returns {Promise<Array<{name, ok, url?, error?}>>}
 */
async function broadcastPost(msg, opts = {}) {
  const rootDir = opts.rootDir;
  let adapters = getEnabledBroadcasters(rootDir);
  // If the caller didn't attach media, skip the media-only adapters
  // (currently just YouTube). They'd otherwise return ok=false with
  // "no_media" on every text-only post — correct but noisy.
  if (!msg.media) {
    adapters = adapters.filter((a) => a.name !== "youtube");
  }
  if (adapters.length === 0) {
    return [{ name: "none", ok: false, error: "no_adapters_configured" }];
  }
  const results = await Promise.all(
    adapters.map(async (a) => {
      try {
        // IN_FANOUT: the adapter's own direct-post write-back stands down;
        // the whole fanout is remembered once, below.
        const r = await a.post({ ...msg, [IN_FANOUT]: true });
        return { name: a.name, ...r };
      } catch (e) {
        return { name: a.name, ok: false, error: e && e.message };
      }
    })
  );
  // Her own words go into her own store, once per publication. Not awaited:
  // the post has already gone out and nothing here may delay or fail it.
  if (msg.writeBack !== false) {
    voiceWriteback.rememberPublication({
      text: msg.text, results, composer: msg.composer || inferComposer(),
      links: msg.link ? [msg.link] : [], template: !!msg.template,
    });
  }
  return results;
}

/**
 * Thread a reply/comment under a set of prior broadcast results — used to
 * drop a follow-up (e.g. a YouTube video link) under the original announce on
 * each platform, the way you'd add a comment by hand. This is how a link
 * surfaces on Bluesky/Mastodon, whose adapters intentionally drop body URLs.
 *
 * Best-effort and never throws: a platform with no reply support, a missing
 * parent handle, or a failed reply is reported per-adapter and skipped.
 *
 * @param {Array} priorResults — the array returned by broadcastPost (each {name, ok, ...handle}).
 * @param {string} text — the reply body (a URL is auto-linked per platform).
 * @param {object} [opts] — { rootDir, composer?, writeBack? } (see broadcastPost)
 * @returns {Promise<Array<{name, ok, url?, error?}>>}
 */
async function broadcastReply(priorResults, text, opts = {}) {
  const adapters = getEnabledBroadcasters(opts.rootDir);
  const byName = new Map(adapters.map((a) => [a.name, a]));
  // Never try to "reply" to the YouTube upload — it isn't a thread post.
  const targets = (priorResults || []).filter(
    (r) => r && r.ok && r.name !== "youtube" && r.name !== "none"
  );
  if (targets.length === 0) return [];
  const results = await Promise.all(
    targets.map(async (parent) => {
      const a = byName.get(parent.name);
      if (!a || typeof a.reply !== "function") {
        return { name: parent.name, ok: false, error: "no_reply_support" };
      }
      try {
        const r = await a.reply(text, parent);
        return { name: parent.name, ...r };
      } catch (e) {
        return { name: parent.name, ok: false, error: e && e.message };
      }
    })
  );
  if (opts.writeBack !== false) {
    voiceWriteback.rememberPublication({
      text, results, composer: opts.composer || inferComposer(),
      context: "as a reply under my own earlier post",
    });
  }
  return results;
}

module.exports = { broadcastPost, broadcastReply, getEnabledBroadcasters };
