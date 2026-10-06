'use strict';

// featured-artist-slot.test.js — the third PodcastScheduler show (Featured
// Artist, 20:00) relies on three per-show options; the two existing shows
// must keep their old behaviour when they don't set them.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PodcastScheduler, introHoldMs } = require('../server/podcast-scheduler');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e && e.message}`); }
}

function makeScheduler(show, files) {
  const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'featured-'));
  const folder = (show && show.folder) || 'Ghost Signals Podcast';
  fs.mkdirSync(path.join(musicDir, folder));
  for (const f of files) fs.writeFileSync(path.join(musicDir, folder, f), 'x');
  const voiceDJ = {};
  const engine = { state: { channel: 'dj', playlist: [], playlistMeta: [], history: [], currentTrackIdx: 0 } };
  const s = new PodcastScheduler({
    djEngine: engine, voiceDJ, broadcast: () => {}, broadcastState: () => {},
    getMusicDir: () => musicDir, show,
  });
  s._waitForPodcastEnd = () => {};
  return { s, voiceDJ, engine };
}

const FEATURED = { label: 'Featured Artist', folder: 'Featured Artist', airHours: [20],
  trackPrefix: '[FEATURED]', promoLine: 'At eight o\'clock it\'s the featured artist hour.' };

check('default show still stamps [PODCAST] (deploy-oracle.sh fallback reads it)', () => {
  const { s, engine } = makeScheduler(undefined, ['GSP-001.mp3']);
  s._playAllPodcastEpisodes(['GSP-001.mp3']);
  assert.strictEqual(engine.state.playlistMeta[0].title, '[PODCAST] GSP-001');
});

check('a show with trackPrefix stamps its own marker', () => {
  const { s, engine } = makeScheduler(FEATURED, ['Solace Road - Escape to Dream.mp3']);
  s._playAllPodcastEpisodes(['Solace Road - Escape to Dream.mp3']);
  assert.strictEqual(engine.state.playlistMeta[0].title, '[FEATURED] Solace Road - Escape to Dream');
  assert.strictEqual(engine.state.playlistMeta[0].isPodcastScheduled, true);
});

check('promo minute sets the show\'s own line', () => {
  const { s, voiceDJ } = makeScheduler(FEATURED, ['a.mp3']);
  s._chicagoNow = () => new Date(2026, 9, 6, 19, 30, 0);
  s._tick();
  assert.strictEqual(voiceDJ._podcastPromo, FEATURED.promoLine);
});

check('promo minute without promoLine keeps the old `true` flag', () => {
  const { s, voiceDJ } = makeScheduler(undefined, ['GSP-001.mp3']);
  s._chicagoNow = () => new Date(2026, 9, 6, 9, 30, 0);
  s._tick();
  assert.strictEqual(voiceDJ._podcastPromo, true);
});

check('an empty folder promises nothing', () => {
  const { s, voiceDJ } = makeScheduler(FEATURED, []);
  s._chicagoNow = () => new Date(2026, 9, 6, 19, 30, 0);
  s._tick();
  assert.strictEqual(voiceDJ._podcastPromo, undefined);
});

check('intro hold: one-sentence intros keep the old 9 s', () => {
  assert.strictEqual(introHoldMs("It's podcast time. Today's episode: GSP-041. Settle in, turn it up, let the ghost signals speak."), 9000);
});

check('intro hold: a long guest intro waits for the voice', () => {
  const sixty = Array(60).fill('word').join(' ');
  assert.strictEqual(introHoldMs(sixty), 25000);
});

check('every non-podcast show in index.js sets its own promo line', () => {
  // A show without promoLine inherits voice-dj's "this week's podcast
  // episode" copy — which TSOF announced before every airing until 10-06.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const blocks = src.split('new PodcastScheduler({').slice(1).map((b) => b.split('\n});')[0]);
  const shows = blocks.filter((b) => /\bshow:\s*\{/.test(b));
  assert.ok(shows.length >= 2, `expected the TSOF and Featured shows, found ${shows.length}`);
  for (const b of shows) {
    const label = (b.match(/label:\s*"([^"]+)"/) || [])[1] || '?';
    assert.ok(/promoLine:\s*"/.test(b), `${label} has no promoLine`);
  }
});

if (failures) { console.error(`\n${failures} failing`); process.exit(1); }
console.log('\nfeatured-artist-slot: all passed');
