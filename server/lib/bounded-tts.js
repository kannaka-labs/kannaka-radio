"use strict";
/**
 * bounded-tts — run a batch of voice renders N at a time, with one retry.
 *
 * O1 has one vCPU. On 2026-10-15 at 16:00Z a showcase pre-rendered its nine
 * narration pieces all at once; nine piper renders plus their two-pass
 * loudnorm fought for the core, every render ran out its time budget, and
 * the edge-dsp fallbacks timed out behind them (27 TTS failures, a showcase
 * with no narration). A render's time budget is computed when the render
 * starts, so queueing renders keeps each budget honest: time spent waiting
 * in this queue is never charged to a render.
 *
 * runBounded(items, worker, opts) -> Promise<Array<result|null>>
 *   worker(item, index) returns a Promise of a result (a truthy value) or
 *   rejects / resolves falsy on failure. At most `concurrency` workers run at
 *   once. Items that fail are retried once, after every first attempt has
 *   finished, still `concurrency` at a time. A slot that fails twice is null.
 *   onSettled(index, result|null, attempt) is called once per item, when its
 *   result is final, so a caller can publish each piece as soon as it lands.
 */

function narrationConcurrency(env = process.env) {
  const n = parseInt(env.NARRATION_TTS_CONCURRENCY, 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function runBounded(items, worker, opts = {}) {
  const concurrency = Math.max(1, opts.concurrency || 1);
  const retries = opts.retries == null ? 1 : Math.max(0, opts.retries);
  const onSettled = typeof opts.onSettled === "function" ? opts.onSettled : null;
  const results = new Array(items.length).fill(null);

  const attempt = (i) =>
    Promise.resolve()
      .then(() => worker(items[i], i))
      .then((r) => r || null, () => null);

  const pass = (indexes, attemptNo, isLast) =>
    new Promise((resolve) => {
      const failed = [];
      let next = 0;
      let active = 0;
      const pump = () => {
        if (next >= indexes.length && active === 0) return resolve(failed);
        while (active < concurrency && next < indexes.length) {
          const i = indexes[next++];
          active += 1;
          attempt(i).then((r) => {
            active -= 1;
            if (r) {
              results[i] = r;
              if (onSettled) onSettled(i, r, attemptNo);
            } else if (isLast) {
              if (onSettled) onSettled(i, null, attemptNo);
            } else {
              failed.push(i);
            }
            pump();
          });
        }
      };
      pump();
    });

  return (async () => {
    let pending = items.map((_, i) => i);
    for (let a = 1; a <= retries + 1 && pending.length; a++) {
      pending = await pass(pending, a, a === retries + 1);
    }
    return results;
  })();
}

/** generateTTS(text, cb) as a promise of the audio path (or null). */
function ttsPromise(voiceDJ, text) {
  return new Promise((resolve) => {
    voiceDJ.generateTTS(text, (err, audioPath) => resolve(err || !audioPath ? null : audioPath));
  });
}

module.exports = { runBounded, ttsPromise, narrationConcurrency };
