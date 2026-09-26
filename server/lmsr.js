'use strict';

/**
 * lmsr.js — the Logarithmic Market Scoring Rule, as pure functions.
 *
 * Extracted from ghostsignals-hub.js so the money math can be property-tested
 * without a database (test/lmsr.test.js) and so every caller shares ONE set of
 * input guards. The hub used to compute cost with whatever `liquidity` a
 * request carried: a negative b flips the sign of the cost function, so a
 * "buy" PAID the trader; b = 0 divides by zero; a single-outcome market prices
 * at exactly 1 and makes every share free. None of those are market states,
 * they are mints — so they are refused here, at the one place the numbers
 * enter.
 *
 * Numerics: the cost is evaluated as b·(max + log Σ exp(q_i/b − max)), the
 * log-sum-exp form, so a large |q|/b never overflows exp(). Prices are the
 * softmax of q/b and therefore always sum to 1 (within float rounding).
 *
 * Trade cost mirrors the reference crate ghostsignals 0.2.0
 * (NickFlach/ghostsignals-rs, src/lmsr.rs `trade_cost`): the closed form
 * b·ln1p(p_i·expm1(d/b)) instead of C(q+d) − C(q), which cancels
 * catastrophically for small trades (#296).
 */

const MAX_OUTCOMES = 32;

function assertLiquidity(b) {
  if (typeof b !== 'number' || !Number.isFinite(b) || !(b > 0)) {
    throw new Error('liquidity must be a finite number > 0');
  }
}

function assertQ(q) {
  if (!Array.isArray(q) || q.length < 2 || q.length > MAX_OUTCOMES) {
    throw new Error(`q must be an array of 2..${MAX_OUTCOMES} outcome quantities`);
  }
  for (const qi of q) {
    if (typeof qi !== 'number' || !Number.isFinite(qi)) throw new Error('q entries must be finite numbers');
  }
}

/** C(q) = b · ln Σ exp(q_i / b), evaluated stably. */
function lmsrCost(q, b) {
  assertLiquidity(b);
  assertQ(q);
  let max = -Infinity;
  for (const qi of q) if (qi / b > max) max = qi / b;
  let s = 0;
  for (const qi of q) s += Math.exp(qi / b - max);
  return b * (max + Math.log(s));
}

/** p_i = exp(q_i/b) / Σ exp(q_j/b) — the softmax; sums to 1. */
function lmsrPrices(q, b) {
  assertLiquidity(b);
  assertQ(q);
  let max = -Infinity;
  for (const qi of q) if (qi / b > max) max = qi / b;
  const exps = q.map((qi) => Math.exp(qi / b - max));
  const sum = exps.reduce((a, e) => a + e, 0);
  return exps.map((e) => e / sum);
}

/**
 * Cost of buying `shares` of outcome `idx` against state `q`. Returns
 * { cost, qAfter }. Throws on a non-positive or non-finite share count, an
 * out-of-range outcome, or a cost that is not a strictly positive finite
 * number — a zero cost would credit a position for nothing.
 *
 * Evaluated as C(q + d·e_i) − C(q) = b · ln1p(p_i · expm1(d/b)), with p_i from
 * max-shifted exponentials (so no term overflows), as in ghostsignals 0.2.0.
 * The direct difference of two C() values ~b·ln(n) loses the digits of a small
 * cost (1e-9 shares came out ~1e-5 relative off); this form keeps them. When
 * the closed form is not finite (expm1 overflows for d/b > ~709) it falls back
 * to the log-sum-exp difference, which re-centres on the new maximum. Only
 * buys reach here (shares > 0), so the ln1p argument is always > 0 — the
 * crate's second fallback trigger (ratio <= -0.5, a large sell) cannot occur.
 *
 * Dust: a trade whose true cost is below the float resolution of C(q) itself
 * is still refused as "too small", exactly the trades the old subtraction
 * rounded to 0 — the pool's cost function cannot register them.
 */
function lmsrTradeCost(q, b, idx, shares) {
  assertLiquidity(b);
  assertQ(q);
  if (!Number.isInteger(idx) || idx < 0 || idx >= q.length) throw new Error('outcome out of range');
  if (typeof shares !== 'number' || !Number.isFinite(shares) || !(shares > 0)) throw new Error('shares must be positive');
  const qAfter = q.slice();
  qAfter[idx] += shares;

  let max = -Infinity;
  for (const qi of q) if (qi / b > max) max = qi / b;
  let total = 0;
  for (const qi of q) total += Math.exp(qi / b - max);
  const ei = Math.exp(q[idx] / b - max);
  const ratio = (ei * Math.expm1(shares / b)) / total;

  let cost = Number.isFinite(ratio) && ratio > -0.5
    ? b * Math.log1p(ratio)
    : lmsrCost(qAfter, b) - lmsrCost(q, b);           // log-sum-exp fallback
  if (!Number.isFinite(cost) || !(cost > 0)) throw new Error('trade too small: cost rounds to zero');
  // Below the resolution of C(q): the old subtraction returned exactly 0 here.
  const c0 = b * (max + Math.log(total));
  if (c0 + cost === c0) throw new Error('trade too small: cost rounds to zero');
  return { cost, qAfter };
}

module.exports = { MAX_OUTCOMES, lmsrCost, lmsrPrices, lmsrTradeCost, assertLiquidity, assertQ };
