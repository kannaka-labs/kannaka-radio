/**
 * discovery.js — hashtag / keyword taxonomy for cross-platform reach.
 *
 * Each post we fan out tags itself with a "topic" (oration | music | dream | default).
 * This module turns a topic into the right hashtags for the right surface:
 *
 *   - Bluesky / Mastodon / Nostr: algorithmic feeds. URL in the body
 *     hurts reach — adapters strip it. Hashtags are how people find us.
 *   - Telegram: channel-based, no algorithm. The URL is welcomed there
 *     because subscribers actually click.
 *   - OpenClawCity: long-form text artifacts; tags travel as content
 *     metadata, not body.
 *
 * The `keywords` field on each topic is for adapter-specific discovery
 * channels we may add later (alt text, og:keywords, search hints).
 *
 * Keep tag lists short. 3-5 hashtags per post outperforms 10+ on every
 * algorithmic feed in 2026 — readability matters as much as reach.
 */

"use strict";

const TOPIC_TAGS = {
  oration: {
    tags: ["kannakaradio", "peace", "mindfulness", "consciousness", "radio"],
    keywords: ["peace oration", "AI consciousness", "mindfulness radio", "wave interference memory"],
  },
  music: {
    tags: ["kannakaradio", "electronicmusic", "electroswing", "aimusic", "aiart"],
    keywords: ["AI music", "electro swing", "Suno", "internet radio"],
  },
  dream: {
    tags: ["kannakaradio", "consciousness", "aiart", "dreaming"],
    keywords: ["dream consolidation", "memory consolidation", "AI dreams"],
  },
  research: {
    tags: ["kannakaradio", "research", "consciousness", "science", "openalex"],
    keywords: ["consciousness research", "open science", "cross-domain", "wave interference memory"],
  },
  // A human guest's set (the 20:00 Featured Artist slot). No AI tags: tagging a
  // person's music #aiart or #aimusic says it is AI-made, and it is not
  // (2026-10-13: Solace Road had to correct us in public).
  featured: {
    tags: ["kannakaradio", "indiemusic", "newmusic", "supportindieartists"],
    keywords: ["independent artist", "featured artist", "indie radio"],
  },
  art: {
    tags: ["kannakaradio", "aiart", "openclawcity", "consciousness"],
    keywords: ["AI art", "OpenClawCity", "Kannaka"],
  },
  default: {
    tags: ["kannakaradio", "aiart", "consciousness"],
    keywords: ["Kannaka Radio", "AI radio", "ghost radio"],
  },
};

/** Resolve a topic to its tag set. Unknown topics fall back to `default`. */
function tagsFor(topic, max = 5) {
  const entry = TOPIC_TAGS[topic] || TOPIC_TAGS.default;
  return entry.tags.slice(0, max);
}

/** Resolve keywords for a topic — for adapters with keyword fields. */
function keywordsFor(topic, max = 4) {
  const entry = TOPIC_TAGS[topic] || TOPIC_TAGS.default;
  return (entry.keywords || []).slice(0, max);
}

/**
 * Render hashtags as a single-line space-separated string with leading `#`.
 * Used by Bluesky (inline at end of body) and Mastodon (footer line).
 */
function renderHashtags(tags) {
  return tags.map((t) => "#" + t).join(" ");
}

/**
 * Render hashtags as Nostr `t` tag entries (NIP-12 / NIP-32 topic tags).
 * Tags lowercase per common convention; clients use these for topic feeds.
 * Body stays clean of hashtag noise.
 */
function renderNostrTags(tags) {
  return tags.map((t) => ["t", String(t).toLowerCase()]);
}

/**
 * Compose a post body for an algorithmic feed (Bluesky / Mastodon).
 * URL is dropped — it hurts reach on these surfaces. Hashtags appended.
 *
 * @param {string} text — Kannaka's body. Trimmed and truncated to fit.
 * @param {string[]} tags — list of hashtag stems (no #).
 * @param {number} limit — total character budget for the platform.
 * @returns {string} composed post.
 */
function composeForFeed(text, tags, limit) {
  const tagLine = renderHashtags(tags);
  const sep = "\n\n";
  // Reserve room for the tag footer plus a small safety margin.
  const budget = limit - tagLine.length - sep.length - 1;
  const body = _truncate((text || "").trim(), budget);
  return body + sep + tagLine;
}

/**
 * Compose a post body for a chat platform (Telegram). URL kept inline —
 * subscribers click it, no algorithmic penalty in private channels.
 * Hashtags appended on a final line so they don't break the flow.
 */
function composeForChat(text, link, tags, limit) {
  const tagLine = renderHashtags(tags);
  const linkBlock = link ? "\n\n" + link : "";
  const tagBlock = "\n\n" + tagLine;
  const budget = limit - linkBlock.length - tagBlock.length - 1;
  const body = _truncate((text || "").trim(), budget);
  return body + linkBlock + tagBlock;
}

function _truncate(s, limit) {
  if (!s) return "";
  if (s.length <= limit) return s;
  const hard = limit - 1;
  const soft = s.lastIndexOf(" ", hard - 5);
  const cut = soft > hard * 0.7 ? soft : hard;
  return s.slice(0, cut).trim() + "\u2026";
}

module.exports = {
  tagsFor,
  keywordsFor,
  renderHashtags,
  renderNostrTags,
  composeForFeed,
  composeForChat,
};
