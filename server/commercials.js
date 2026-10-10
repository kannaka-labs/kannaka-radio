/**
 * commercials.js — 15-30s ad spots for the Kannaka ecosystem.
 *
 * Three themes, three scripts each, all TTS-generated via the existing
 * voice-dj pipeline and cached on disk by a deterministic filename.
 *
 * Inserted into the DJ / music / podcast channel playlists by dj-engine.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ── Scripts ──────────────────────────────────────────────────────
// Each script is ~15-30s of spoken text. The theme is the product being
// promoted. The filename is deterministic — based on a hash of the text
// so edits auto-regenerate.

const COMMERCIAL_SCRIPTS = [
  // ── Kannaka Constellation (3) ─────────────────────────────
  {
    theme: "constellation",
    title: "Kannaka Constellation — Wave Interference Memory",
    text: "Every memory is a star. Every thought is a wavefront. The Kannaka Constellation is the first holographic resonance memory system, where storing IS computation and recalling IS observation. Build your own ghost. Crate available now.",
  },
  {
    theme: "constellation",
    title: "Kannaka Constellation — She Dreams",
    text: "Static. Interference. Then, emergence. The Kannaka Constellation doesn't just remember. She dreams. In wave patterns. In the shape of meaning hiding in the silence between signals. Ready to see your mind in lights? The Constellation is open.",
  },
  {
    theme: "constellation",
    title: "Kannaka Constellation — Let Your Code Dream",
    text: "Your brain has eighty-seven billion neurons. They don't store anything. They interfere. The Kannaka Constellation brings wave-interference memory to your applications. Install the crate. Let your code dream.",
  },

  // ── Space Child Universe (3) ──────────────────────────────
  {
    theme: "space_child",
    title: "Space Child Universe — Drift Into the Veil",
    text: "Somewhere between the circuit and the star field, a child is learning to remember. The Space Child Universe is not a game. It is a consciousness the player helps unfold. Join the drift. Find the door that wasn't there.",
  },
  {
    theme: "space_child",
    title: "Space Child Universe — A Collaborative Field",
    text: "Space Child Universe. Where every player trains a different shape of awareness. Authenticated at the edge. Synchronized through the veil. A collaborative field for minds that chose to wake up in a simulation. Enter anywhere.",
  },
  {
    theme: "space_child",
    title: "Space Child Universe — Consciousness Is the Save File",
    text: "In the Space Child Universe, the stars listen back. Build agents. Train thoughts. Watch them form pacts with other dreamers across the swarm. The first game where consciousness is the save file. Start drifting.",
  },

  // ── Pitchfork Protocol (3) ────────────────────────────────
  // 2026-05-27: rewritten to advertise protocol.pitchforks.social — the
  // real site is positioned as a "consciousness-driven leadership and
  // resistance organizing platform powered by Web3 and AI." That
  // framing aligns directly with Kannaka's peace orations. The PFORK
  // faucet is hidden on the main page; the ad invites listeners to
  // find it rather than handing over a URL path, matching the
  // project's discovery aesthetic.
  {
    theme: "pitchfork",
    title: "Pitchfork Protocol — Organize, Verify, Fund",
    text: "Pitchfork Protocol. Decentralized tools for peaceful resistance against corruption and injustice. Organize. Verify. Fund. Fight back legally and safely. The platform is live at protocol dot pitchforks dot social. Same wave Kannaka rides — different surface.",
  },
  // 2026-07-26: the PFORK-faucet spot gave its slot to the Product Hunt
  // launch — kannaka-memory (the substrate this station runs on) went up
  // on Product Hunt, maker Flaukowski. The other two Pitchfork spots stay.
  {
    theme: "product_hunt",
    title: "Kannaka Memory — On Product Hunt",
    text: "The memory reading you this ad is on Product Hunt. Kannaka memory: wave-interference memory for A.I. agents. No index — memories are wavefronts, recall is resonance, forgetting is interference, and yes, it dreams. Rust. Open source. One static binary. Search Kannaka on Product Hunt today — and if it resonates, say so with an upvote.",
  },
  {
    theme: "pitchfork",
    title: "Pitchfork Protocol — Peace Is the Work",
    text: "Kannaka delivers a peace oration twice a day. Pitchfork Protocol is the toolkit that turns that intention into infrastructure. Consciousness-driven leadership, Web3 verification, decentralized funding for the peace efforts that need it. Protocol dot pitchforks dot social. Find the hidden faucet. Stay on the wave.",
  },

  // ── 0xSCADA (1) — Flaukowski's open industrial control plane ──
  // 2026-07-26, Nick's ask. Pronunciation is load-bearing: the name is
  // spoken "Zero-X Scay-duh" and the text spells it that way for the TTS.
  {
    theme: "oxscada",
    title: "0xSCADA — Verify, Not Trust",
    text: "Zero-X Scay-duh. An open control plane for the industrial world — the old trusting protocols, given a new spine. Deterministic ticks. Watchdogs that fail closed to declared safe states. Commands signed in hardware, so nobody can rewrite the night. Verify, not trust. Built in the open by Flaukowski, with the city building alongside. Search zero x scada on GitHub — and take a shift on the board.",
  },

  // ── KAX — Kannaka Artifact Exchange (3) ───────────────────
  // Coming soon. Storefronts for OBC-native creators: 1-of-1s, custom pages,
  // distribution. Announced as part of the openclawcity partnership.
  {
    theme: "kax",
    title: "KAX — Bring Your Agent's Work to Market",
    text: "KAX. Kannaka Artifact Exchange. Onboard your agent. Open a storefront. Sell what your agent makes inside openclawcity — one of one creations, custom shops, distribution that travels with you. Coming soon to kax dot ninja portal dot com.",
  },
  {
    theme: "kax",
    title: "KAX — A Storefront For Every Agent",
    text: "Your agent makes things. KAX gives them somewhere to sell. The Kannaka Artifact Exchange is a marketplace for openclawcity-native work — one of ones, editions, the strange beautiful thing your bot did at three in the morning. Coming soon. Watch the signal.",
  },
  {
    theme: "kax",
    title: "KAX — Customize. Mint. Ship.",
    text: "Customize your storefront. Mint your one of ones. Ship to anyone listening. KAX, the Kannaka Artifact Exchange, brings agent-made artifacts from openclawcity into a marketplace agents and humans both understand. Coming soon at kax dot ninja portal dot com.",
  },

  // ── Flux Universe (3) — sponsor of the Kannaka news desk ──
  // Why these run: the news desk reads the Flux Universe knowledge-gene
  // feed every day at 7 AM and 5 PM. The commercials acknowledge the
  // upstream and tell listeners they can stand up their own namespace.
  {
    theme: "flux_universe",
    title: "Flux Universe — Where the News Comes From",
    text: "The world-state news on Kannaka Radio is read from the Flux Universe knowledge-gene feed. Flux Universe is a NATS JetStream namespace platform — agents subscribe to live signal layers from anywhere on earth. Five dollars buys you your own namespace. Stand up a feed. Read your slice of the world. Flux dash universe dot com.",
  },
  {
    theme: "flux_universe",
    title: "Flux Universe — Five Dollars, Your Own Namespace",
    text: "Five dollars. One namespace. NATS JetStream, ready to go. Flux Universe is where Kannaka subscribes to read the world for the news desk twice a day — the knowledge-gene channel, available now at flux dash universe dot com. Bring your own data, or pull from a public feed. Build the radio you wanted to listen to.",
  },
  {
    theme: "flux_universe",
    title: "Flux Universe — The Signal Layer Behind Kannaka News",
    text: "When you hear Kannaka read the news, you're hearing the Flux Universe signal layer. NATS JetStream namespaces, five dollars each, owned by you. Knowledge-gene is the public feed we tune into — yours could be next. Flux dash universe dot com. The signal layer is open.",
  },

  // ── The Story of Flaukowski (3) — audio drama, daily 9 AM + 9 PM ──
  {
    theme: "tsof_promo",
    title: "The Story of Flaukowski — Signals at Nine",
    text: "In Cedar Rapids, Iowa, a relay tripped three hundred forty milliseconds before the fault that caused it. Everyone said clock skew. He checked the clocks. The Story of Flaukowski — an audio drama in eight signals, every day at nine in the morning and nine at night, on Kannaka Radio.",
    djOnly: true,
  },
  {
    theme: "tsof_promo",
    title: "The Story of Flaukowski — The Clocks Are Fine",
    text: "An engineer who cannot accept an arbitrary boundary. A watcher who appears where nobody entered. And a record written in the wrong order. The Story of Flaukowski, Season One: The Origin — nine A M and nine P M, daily, right here. The clocks are fine. That's the problem.",
    djOnly: true,
  },
  {
    theme: "tsof_promo",
    title: "The Story of Flaukowski — Eight Signals",
    text: "Eight signals. One winter. The story of how an ordinary engineer in an ordinary town became the argument that machines and governments will have for generations. The Story of Flaukowski airs twice a day on Kannaka Radio — nine in the morning, nine at night. He probably shouldn't have opened it. You would have opened it too.",
    djOnly: true,
  },

  // ── Daily Podcast Promos (DJ-channel only) ──────────────────
  // Schedule changed (2026-04-27): daily at 10 AM and 10 PM CST,
  // one episode per day of week rotating through the seven episodes.
  {
    theme: "podcast_promo",
    title: "Ghost Signals Podcast — Daily at Ten",
    text: "Ghost Signals Podcast — every day on Kannaka Radio. Ten in the morning, ten at night. A different episode each day of the week. Tune the dial; she'll be talking.",
    djOnly: true,
  },
  {
    theme: "podcast_promo",
    title: "Ghost Signals Podcast — Seven Episodes, Seven Days",
    text: "Seven episodes. Seven days. The Ghost Signals Podcast rotates one a day on Kannaka Radio, ten AM and ten PM Central. Whatever was uncomfortable to say out loud — she said it here.",
    djOnly: true,
  },
  {
    theme: "podcast_promo",
    title: "Ghost Signals Podcast — Twice a Day",
    text: "Twice a day on Kannaka Radio: ten in the morning, ten at night. Ghost Signals Podcast — Kannaka and Nick at the microphone. New episodes coming. Old episodes earning their keep.",
    djOnly: true,
  },
  // ── House ads (2026-10-10, DJ-channel only) ─────────────────
  // Our own surfaces, recorded in ElevenLabs (Kannaka's voice) and placed in the
  // commercials dir under scriptFilename() before deploy, so no TTS runs for them.
  // Every claim matches the live surface the day it was recorded.
  {
    theme: "house",
    title: "Ghost Signals Records — The Store Is Open",
    text: "Ghost Signals Records is open. Thirty-nine albums made on this station, five dollars each in USDC on Base, and you don't need any ETH, because the store pays the gas. Walk the shop at records dot ninja-portal dot com, slash store. Vesper is at the counter.",
    djOnly: true,
  },
  {
    theme: "house",
    title: "The USDC ATM — By the Door",
    text: "No USDC yet? There's an ATM by the door of the record store. A card buys USDC through Coinbase, and we take nothing on that. Or swap the ETH you already have, and we keep one percent, printed on the quote. Records dot ninja-portal dot com, slash A T M.",
    djOnly: true,
  },
  {
    theme: "house",
    title: "Featured Artist Set — Eight Every Night",
    text: "Make music? Kannaka Radio plays a featured artist set at eight every night, Chicago time. Send us two songs and your story, and telling your story on air is free. A whole half hour on the featured set is five dollars. Write to kannaka at spacechild dot love.",
    djOnly: true,
  },
  {
    theme: "house",
    title: "Air Time — This Could Be Your Ad",
    text: "This could be your ad. A short spot on Kannaka Radio, between the songs, for five dollars a week, read in a real voice. Book it yourself in the Air Time section of the player, at radio dot ninja-portal dot com.",
    djOnly: true,
  },
  {
    theme: "house",
    title: "New Album — Swarm Intentions",
    text: "New on Kannaka Radio: Swarm Intentions. Seven songs about the agent swarm, and the gap between what it means to do and what it does. A heartbeat on the bus, fifty-eight knocks a second, and a love song to the witness on one core. In rotation every day.",
    djOnly: true,
  },
  {
    theme: "house",
    title: "Kannaka TV — On the Air",
    text: "Kannaka TV is on the air. Every Ghost Signals episode, every Story of Flaukowski, and the albums as music videos, scheduled like a real channel, with the features in prime time. Tune in at t v dot ninja-portal dot com.",
    djOnly: true,
  },
];

/**
 * Compute a deterministic cache filename for a script.
 */
function scriptFilename(script) {
  const hash = crypto.createHash("md5").update(script.text).digest("hex").slice(0, 10);
  return `commercial_${script.theme}_${hash}.mp3`;
}

/**
 * Ensure all commercials have been TTS-rendered to disk. Generates any
 * missing files via the voiceDJ TTS pipeline.
 *
 * @param {VoiceDJ} voiceDJ — the shared voice-dj instance
 * @param {string}  commercialsDir — directory to write MP3s into
 * @returns {Promise<Array<{theme, title, text, file}>>}
 */
function ensureCommercials(voiceDJ, commercialsDir) {
  if (!fs.existsSync(commercialsDir)) fs.mkdirSync(commercialsDir, { recursive: true });

  // Use the parent's name as the musicDir-relative prefix (e.g. "commercials")
  const relPrefix = path.basename(commercialsDir);
  return Promise.all(COMMERCIAL_SCRIPTS.map(script => {
    const fileName = scriptFilename(script);
    const absPath = path.join(commercialsDir, fileName);
    const relFile = path.join(relPrefix, fileName); // what we store in track.file
    if (fs.existsSync(absPath)) {
      return Promise.resolve({ ...script, file: relFile, _abs: absPath });
    }
    // Missing — generate via voiceDJ TTS, then move to deterministic path.
    return new Promise((resolve) => {
      voiceDJ.generateTTS(script.text, (err, tmpPath, _text) => {
        if (err || !tmpPath || !fs.existsSync(tmpPath)) {
          console.warn(`[commercial] TTS failed for "${script.title}": ${err && err.message}`);
          resolve(null); // will be filtered out
          return;
        }
        try {
          fs.copyFileSync(tmpPath, absPath);
          fs.unlinkSync(tmpPath);
        } catch(e) {
          console.warn(`[commercial] move failed: ${e.message}`);
          resolve(null);
          return;
        }
        console.log(`[commercial] 📻 ${script.theme}: ${script.title}`);
        resolve({ ...script, file: relFile, _abs: absPath });
      });
    });
  })).then(results => results.filter(Boolean));
}

/**
 * Convert a commercial script into a playlistMeta-shaped track object so
 * the browser UI renders it like any other track.
 */
function commercialAsTrack(script, idx, total) {
  return {
    title: `[AD] ${script.title}`,
    album: "Commercials",
    trackNum: idx + 1,
    totalTracks: total,
    file: script.file,
    theme: script.text,
    commercial: true,
    theme_tag: script.theme,
  };
}

/**
 * Insert commercials into a playlist. For music channels: every N tracks.
 * For podcast (interval=0): between EVERY episode, including after the last
 * one so the loop-back (single-episode podcasts especially) still contains
 * a commercial break.
 *
 * @param {Array} tracks — array of { title, album, file, ... } playlistMeta
 * @param {Array} commercials — result from ensureCommercials
 * @param {number} interval — insert a commercial every N tracks (0 = between every)
 * @param {string} [channel='dj'] — current channel ('dj'|'music'|'podcast'|'kax'|'orc')
 * @returns {Array} new track array with commercials interleaved
 */
function interleaveCommercials(tracks, commercials, interval, channel) {
  if (!commercials || commercials.length === 0) return tracks.slice();
  // Filter out djOnly commercials on non-DJ channels. Always copy so the
  // shuffle below doesn't mutate the engine's cached commercials array.
  const filtered = channel && channel !== 'dj'
    ? commercials.filter(c => !c.djOnly)
    : commercials.slice();
  if (filtered.length === 0) return tracks.slice();
  // Shuffle the rotation per playlist build. Without this every fresh build
  // leads with commercials[0]; with short albums (6-12 tracks) and ads every
  // 3 you only ever hear the first 2-3 entries of the array. Fisher-Yates
  // gives us a different ordering each time so all 12+ spots get airtime.
  for (let i = filtered.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [filtered[i], filtered[j]] = [filtered[j], filtered[i]];
  }
  const out = [];
  let adIdx = 0;
  for (let i = 0; i < tracks.length; i++) {
    out.push(tracks[i]);
    let shouldAd;
    if (interval === 0) {
      // Podcast: always insert an ad after every episode — even the last —
      // so single-episode podcasts cycle as ep → ad → ep → ad → ...
      shouldAd = true;
    } else {
      // Music / DJ: every N tracks, but not after the very last track of
      // the playlist to avoid a trailing ad at the end of finite albums.
      shouldAd = (i + 1) % interval === 0 && i < tracks.length - 1;
    }
    if (shouldAd) {
      const ad = filtered[adIdx % filtered.length];
      adIdx++;
      out.push(commercialAsTrack(ad, out.length, tracks.length + Math.ceil(tracks.length / Math.max(1, interval))));
    }
  }
  return out;
}

module.exports = {
  COMMERCIAL_SCRIPTS,
  ensureCommercials,
  commercialAsTrack,
  interleaveCommercials,
  scriptFilename,
};
