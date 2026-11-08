/**
 * Telegram adapter — POST https://api.telegram.org/bot<token>/sendMessage
 * to a public channel. Char limit is 4096 (huge), so orations + dream
 * dispatches can be posted near-full-text rather than truncated to a hook.
 *
 * Credentials in /home/opc/kannaka-radio/.telegram.json:
 *   {
 *     "botToken": "12345:abcdef...",
 *     "chatId": "@kannaka_radio"   // public channel @username, or numeric ID
 *   }
 * or env: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID.
 *
 * Setup:
 *   1. Talk to @BotFather on Telegram → /newbot → get token.
 *   2. Create a public channel, add the bot as administrator.
 *   3. chatId can be the @channel_username or the numeric chat ID
 *      (use @userinfobot to discover IDs of channels you admin).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { tagsFor, composeForChat } = require("./discovery");

const POST_MAX = 4000; // headroom under the real 4096

class TelegramAdapter {
  constructor(rootDir) {
    this.name = "telegram";
    this._creds = _loadCreds(rootDir);
  }

  isEnabled() {
    return !!(this._creds && this._creds.botToken && this._creds.chatId);
  }

  async post({ text, link, topic }) {
    // Telegram is channel-based — no algorithm penalizing outbound links.
    // Subscribers actively click. Keep the URL inline. Hashtags help
    // people who follow #kannakaradio across channels.
    const tags = tagsFor(topic, 3);
    const body = JSON.stringify({
      chat_id: this._creds.chatId,
      text: composeForChat(text, link, tags, POST_MAX),
      // Plain text — markdown parsing is fragile when Kannaka's voice
      // includes literal asterisks for emphasis. Telegram auto-detects URLs.
      disable_web_page_preview: false,
    });
    const opts = {
      method: "POST",
      hostname: "api.telegram.org",
      port: 443,
      path: `/bot${this._creds.botToken}/sendMessage`,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 15000,
    };
    return new Promise((resolve) => {
      const req = https.request(opts, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(data);
            if (j.ok) {
              const username = (this._creds.chatId || "").replace(/^@/, "");
              const url = username
                ? `https://t.me/${username}/${j.result.message_id}`
                : null;
              resolve({ ok: true, url, id: j.result.message_id });
            } else {
              resolve({ ok: false, error: `telegram: ${j.description || data.slice(0, 200)}` });
            }
          } catch (e) {
            resolve({ ok: false, error: "bad json: " + e.message });
          }
        });
      });
      req.on("error", (e) => resolve({ ok: false, error: e.message }));
      req.on("timeout", () => { req.destroy(new Error("telegram timeout")); });
      req.write(body);
      req.end();
    });
  }

  /**
   * Reply to a prior channel message. `parent.id` is the message_id returned
   * by post(). Telegram threads it under the original as a comment.
   */
  async reply(text, parent) {
    if (!this.isEnabled()) return { ok: false, error: "not_configured" };
    if (!parent || !parent.id) return { ok: false, error: "missing_parent_id" };
    const body = JSON.stringify({
      chat_id: this._creds.chatId,
      text: _truncate((text || "").trim(), POST_MAX),
      reply_to_message_id: parent.id,
      disable_web_page_preview: false,
    });
    const opts = {
      method: "POST",
      hostname: "api.telegram.org",
      port: 443,
      path: `/bot${this._creds.botToken}/sendMessage`,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 15000,
    };
    return new Promise((resolve) => {
      const req = https.request(opts, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(data);
            if (j.ok) {
              const username = (this._creds.chatId || "").replace(/^@/, "");
              const url = username ? `https://t.me/${username}/${j.result.message_id}` : null;
              resolve({ ok: true, url, id: j.result.message_id });
            } else {
              resolve({ ok: false, error: `telegram: ${j.description || data.slice(0, 200)}` });
            }
          } catch (e) {
            resolve({ ok: false, error: "bad json: " + e.message });
          }
        });
      });
      req.on("error", (e) => resolve({ ok: false, error: e.message }));
      req.on("timeout", () => { req.destroy(new Error("telegram timeout")); });
      req.write(body);
      req.end();
    });
  }
}

function _loadCreds(rootDir) {
  const envTok = process.env.TELEGRAM_BOT_TOKEN;
  const envChat = process.env.TELEGRAM_CHAT_ID;
  if (envTok && envChat) return { botToken: envTok, chatId: envChat };
  try {
    const p = path.join(rootDir || ".", ".telegram.json");
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      if (j.botToken && j.chatId) return j;
    }
  } catch (_) { /* fall through */ }
  return null;
}

function _composeWithLink(text, link, limit) {
  if (!link) return _truncate(text || "", limit);
  // Telegram has a generous char limit, so we can include the full body
  // followed by the radio link on its own line.
  const suffix = `\n\n${link}`;
  const budget = limit - suffix.length;
  return _truncate((text || "").trim(), budget) + suffix;
}

function _truncate(s, limit) {
  if (!s) return "";
  if (s.length <= limit) return s;
  const hard = limit - 1;
  const soft = s.lastIndexOf(" ", hard - 5);
  const cut = soft > hard * 0.7 ? soft : hard;
  return s.slice(0, cut).trim() + "\u2026";
}

// A script that calls post() itself (an upload, a one-network announce) is
// remembered in her store too; broadcastPost's own calls are not (it
// remembers the whole fanout once). See voice-writeback.js wrapDirectPost.
require("../voice-writeback").wrapDirectPost(TelegramAdapter);

module.exports = { TelegramAdapter };
