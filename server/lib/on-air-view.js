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
 */
function onAirView(engineCurrent, onAir) {
  if (onAir && onAir.file && engineCurrent && onAir.file !== engineCurrent.file) {
    return { current: onAir, upNext: engineCurrent, swapPending: true };
  }
  return { current: engineCurrent || null, upNext: null, swapPending: false };
}

module.exports = { onAirView };
