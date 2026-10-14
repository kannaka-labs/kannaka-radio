/**
 * on-air-view.js — what listeners should be told is playing.
 *
 * The engine's "current" track is what airs NEXT once the stream reaches a
 * boundary. When a show or album is loaded mid-song, the engine's current
 * flips at once while /stream finishes the song it is playing: for minutes
 * the player, the phone lock screen and a car's display showed the show
 * while a song played, and "jumped into a song" when the audio didn't
 * match (2026-10-06: GSP-011 loaded 15:01:26Z, on air 15:04:25Z).
 *
 * When the stream is playing something other than the engine's current
 * track, report the stream's track as current and the loaded one as next.
 *
 * Voice (an intro, an oration, a show's narration) drains between tracks on
 * /stream while the engine still points at the song that just ended, so for
 * the whole piece the text said the previous song (2026-10-13, "the metadata
 * does not always show up accurately"). A voice item on air wins: it is the
 * current item, and the engine's track is what comes next.
 */
function onAirView(engineCurrent, onAir, voice) {
  if (voice && voice.path) {
    const current = {
      title: voice.label || "Kannaka",
      album: voice.album || "Kannaka Radio",
      file: voice.path,
      kind: voice.kind || "voice",
      voice: true,
    };
    return { current, upNext: engineCurrent || null, swapPending: false, voice: true };
  }
  if (onAir && onAir.file && engineCurrent && onAir.file !== engineCurrent.file) {
    return { current: onAir, upNext: engineCurrent, swapPending: true };
  }
  return { current: engineCurrent || null, upNext: null, swapPending: false };
}

/**
 * Seconds a listener who just connected is behind the server's seam before
 * their own player buffers anything: Icecast's burst-on-connect (icecast.xml
 * `burst-size`, 65535 bytes on O1, measured 78–81 kB arriving in the first
 * second) at the mount's bit rate. The player adds what its own <audio> has
 * buffered ahead. Env KANNAKA_STREAM_BURST_BYTES / KANNAKA_STREAM_BITRATE
 * override the defaults when the mount changes.
 */
function streamLatencyHintSec(env = process.env) {
  const burst = Number(env.KANNAKA_STREAM_BURST_BYTES) > 0 ? Number(env.KANNAKA_STREAM_BURST_BYTES) : 65535;
  const bitrate = Number(env.KANNAKA_STREAM_BITRATE) > 0 ? Number(env.KANNAKA_STREAM_BITRATE) : 128000;
  return Math.round((burst * 8 / bitrate) * 100) / 100;
}

/**
 * The on-air view plus its timing, for /api/state and the "state" broadcast.
 * `onAirStartedAt` is the SERVER clock (ms) at the seam the current item
 * began on /stream: the voice item's start, the stream's track start when the
 * stream and the engine disagree, else the engine's own trackStartedAt. With
 * `serverNow` beside it, a player can tell how old the seam is and hold the
 * text until its own audio reaches it.
 */
function stateView(djEngine, icecastSource, now = Date.now(), env = process.env) {
  const state = djEngine.getState();
  const dj = state.channel === "dj" && icecastSource;
  const onAir = dj && typeof icecastSource.onAirTrack === "function" ? icecastSource.onAirTrack() : null;
  const voice = dj && typeof icecastSource.onAirVoice === "function" ? icecastSource.onAirVoice() : null;
  const view = onAirView(state.current, onAir, voice);
  let onAirStartedAt = state.trackStartedAt || null;
  if (view.voice) onAirStartedAt = voice.startedAt || null;
  else if (dj && typeof icecastSource.onAirStartedAt === "function" && onAir && view.current && view.current.file === onAir.file) {
    onAirStartedAt = icecastSource.onAirStartedAt() || onAirStartedAt;
  }
  return { ...view, voice: Boolean(view.voice), onAirStartedAt, serverNow: now, streamLatencyHintSec: streamLatencyHintSec(env) };
}

module.exports = { onAirView, stateView, streamLatencyHintSec };
