'use strict';

// lmsr.test.js — property tests for the pure LMSR math (server/lmsr.js).
//
// The hub's money path is only as sound as these three identities, so they are
// checked over many random states rather than a handful of hand-picked ones:
//   1. prices are a probability vector (each in (0,1), Σ = 1),
//   2. cost is path-independent (buy A then B costs the same as buying A+B),
//      strictly positive for a positive buy, and larger for a larger buy,
//   3. the log-sum-exp form is stable for |q|/b far beyond exp() range.
// And the guards: b <= 0 / NaN / Infinity, q of length < 2, non-finite q, a
// share count that is not a positive finite number, are refused rather than
// producing a NaN or negative cost that a caller would happily debit.

const assert = require('assert');
const { lmsrCost, lmsrPrices, lmsrTradeCost, MAX_OUTCOMES } = require('../server/lmsr');

let failed = 0;
function run(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; } }

// Deterministic PRNG so a failure is reproducible from the seed printed below.
let seed = Number(process.env.LMSR_TEST_SEED) || 0x5eed1234;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; }
console.log(`lmsr.test.js (seed ${seed})`);

function randomState() {
  const n = 2 + Math.floor(rnd() * 6);            // 2..7 outcomes
  const b = Math.exp(rnd() * 12 - 4);              // ~0.018 .. ~2981
  // q spread bounded to ±10b so no outcome is priced below ~e^-20: a buy of an
  // outcome priced at 1e-300 legitimately costs 0 in float and is refused as
  // dust by lmsrTradeCost (that refusal has its own test below).
  const q = Array.from({ length: n }, () => (rnd() - 0.5) * 20 * b);
  return { n, b, q };
}

run('prices are a probability vector over 2000 random states', () => {
  for (let i = 0; i < 2000; i++) {
    const { b, q } = randomState();
    const p = lmsrPrices(q, b);
    const sum = p.reduce((a, x) => a + x, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `Σp = ${sum} for q=${JSON.stringify(q)} b=${b}`);
    for (const x of p) assert.ok(x >= 0 && x <= 1 && Number.isFinite(x), `price ${x} out of [0,1]`);
    // The outcome with the largest q has the highest price.
    const argmaxQ = q.indexOf(Math.max(...q));
    const argmaxP = p.indexOf(Math.max(...p));
    assert.strictEqual(argmaxP, argmaxQ, 'highest q must carry the highest price');
  }
});

run('cost is path-independent, strictly positive, and monotone in shares', () => {
  for (let i = 0; i < 2000; i++) {
    const { n, b, q } = randomState();
    const idx = Math.floor(rnd() * n);
    const s1 = Math.exp(rnd() * 5 - 2) * b;         // 0.14b .. 20b
    const s2 = Math.exp(rnd() * 5 - 2) * b;
    const a = lmsrTradeCost(q, b, idx, s1);
    const then = lmsrTradeCost(a.qAfter, b, idx, s2);
    const once = lmsrTradeCost(q, b, idx, s1 + s2);
    const twoStep = a.cost + then.cost;
    // Relative tolerance: costs scale with b, so compare against magnitude.
    const tol = 1e-9 * Math.max(1, Math.abs(once.cost));
    assert.ok(Math.abs(twoStep - once.cost) <= tol, `path dependence: ${twoStep} vs ${once.cost} (q=${JSON.stringify(q)}, b=${b})`);
    assert.ok(a.cost > 0, `cost must be > 0, got ${a.cost}`);
    assert.ok(once.cost > a.cost, `buying more must cost more (${once.cost} <= ${a.cost})`);
    // A trade can never cost more than its face value (1/share) — LMSR prices are < 1.
    assert.ok(a.cost <= s1 + 1e-9 * s1, `cost ${a.cost} exceeds face value ${s1}`);
  }
});

run('buying shares can never cost more than a full-price fill (no over-charging)', () => {
  // The marginal price is bounded by 1, so the cost of s shares is < s. This is
  // the pool's side of "no free money": we never charge above face either.
  for (let i = 0; i < 500; i++) {
    const { n, b, q } = randomState();
    const idx = Math.floor(rnd() * n);
    const s = Math.exp(rnd() * 5 - 2) * b;
    const { cost } = lmsrTradeCost(q, b, idx, s);
    assert.ok(cost < s * (1 + 1e-12) , `cost ${cost} >= shares ${s}`);
  }
});

run('log-sum-exp stays finite for |q|/b far beyond exp() range', () => {
  const b = 1;
  const q = [1e6, 0, -1e6];
  const c = lmsrCost(q, b);
  assert.ok(Number.isFinite(c) && Math.abs(c - 1e6) < 1e-6, `cost ${c} should be ≈ 1e6`);
  const p = lmsrPrices(q, b);
  assert.ok(p.every(Number.isFinite), 'prices finite');
  assert.ok(Math.abs(p[0] - 1) < 1e-12 && p[1] === 0 && p[2] === 0, `prices ${p} should be [1,0,0]`);
  // Symmetric huge negatives.
  const p2 = lmsrPrices([-1e9, -1e9], 3);
  assert.deepStrictEqual(p2, [0.5, 0.5]);
  // Tiny b relative to q (a very illiquid market) — still finite.
  const c3 = lmsrCost([500, 0], 0.001);
  assert.ok(Number.isFinite(c3), `illiquid cost ${c3}`);
});

run('a uniform q prices every outcome at 1/n and costs b·ln(n)', () => {
  for (let n = 2; n <= 8; n++) {
    const q = new Array(n).fill(0);
    const p = lmsrPrices(q, 10);
    for (const x of p) assert.ok(Math.abs(x - 1 / n) < 1e-12);
    assert.ok(Math.abs(lmsrCost(q, 10) - 10 * Math.log(n)) < 1e-9);
  }
});

run('liquidity guards: b = 0, negative, NaN, Infinity, non-number are refused', () => {
  for (const b of [0, -1, -0.0001, NaN, Infinity, -Infinity, '10', null, undefined, {}]) {
    assert.throws(() => lmsrCost([0, 0], b), /liquidity/, `lmsrCost accepted b=${String(b)}`);
    assert.throws(() => lmsrPrices([0, 0], b), /liquidity/, `lmsrPrices accepted b=${String(b)}`);
    assert.throws(() => lmsrTradeCost([0, 0], b, 0, 1), /liquidity/, `lmsrTradeCost accepted b=${String(b)}`);
  }
});

run('a negative b would have sold unlimited shares for a bounded cost (the bug this guards)', () => {
  // Reconstruct the unguarded formula to show WHY it must be refused: with b<0
  // the price of an outcome FALLS as you buy it, so C(q) is bounded above by 0
  // and a thousand shares (a $1000 payout) cost no more than |b|·ln(2) ≈ 6.93.
  // (Push it further and the formula overflows to a cost of -Infinity: the
  // trader is paid to take the shares.)
  const raw = (q, b) => { const max = Math.max(...q) / b; let s = 0; for (const qi of q) s += Math.exp(qi / b - max); return b * (max + Math.log(s)); };
  const costOfThousand = raw([1000, 0], -10) - raw([0, 0], -10);
  assert.ok(costOfThousand < 7, `unguarded b<0: 1000 shares cost only ${costOfThousand}`);
  assert.strictEqual(raw([1e6, 0], -10) - raw([0, 0], -10), -Infinity, 'and 1e6 shares overflow to a negative-infinite cost');
  // The guarded function refuses the state outright.
  assert.throws(() => lmsrTradeCost([0, 0], -10, 0, 1e6), /liquidity/);
});

run('q guards: fewer than 2 outcomes, too many, non-finite, non-array are refused', () => {
  assert.throws(() => lmsrCost([], 10), /2\.\./);
  assert.throws(() => lmsrCost([0], 10), /2\.\./, 'a single-outcome market prices at 1 — every share would be free');
  assert.throws(() => lmsrCost(new Array(MAX_OUTCOMES + 1).fill(0), 10), /2\.\./);
  assert.throws(() => lmsrCost([0, NaN], 10), /finite/);
  assert.throws(() => lmsrCost([0, Infinity], 10), /finite/);
  assert.throws(() => lmsrCost([0, '1'], 10), /finite/);
  assert.throws(() => lmsrCost('ab', 10), /array/);
  assert.throws(() => lmsrPrices(null, 10), /array/);
});

run('trade guards: shares <= 0, NaN, string; outcome out of range / non-integer', () => {
  for (const s of [0, -1, NaN, Infinity, '5', null]) {
    assert.throws(() => lmsrTradeCost([0, 0], 10, 0, s), /shares must be positive/, `accepted shares=${String(s)}`);
  }
  for (const idx of [-1, 2, 0.5, '0', NaN]) {
    assert.throws(() => lmsrTradeCost([0, 0], 10, idx, 1), /outcome out of range/, `accepted idx=${String(idx)}`);
  }
});

run('a buy too small to move the cost function is refused (no free dust shares)', () => {
  // 1e-18 shares against C(q)≈6.93 vanishes below float resolution: the
  // unguarded subtraction returns exactly 0 and the hub would credit a position
  // for nothing. Repeated, that is a (slow) mint.
  assert.throws(() => lmsrTradeCost([0, 0], 10, 0, 1e-18), /too small/);
  // While a merely small buy is fine.
  assert.ok(lmsrTradeCost([0, 0], 10, 0, 1e-6).cost > 0);
});

// ── #296: mirror ghostsignals 0.2.0 — precise trade cost ──────────────────
// C(q+d) − C(q) subtracts two numbers of size ~b·ln(n) to get one of size
// ~p·d, so a small trade loses most of its digits (1e-9 shares was ~1e-5
// relative off). The crate's closed form b·ln1p(p_i·expm1(d/b)) keeps them.

// Values printed by the reference crate itself (NickFlach/ghostsignals-rs
// 0.2.0, `ghostsignals::trade_cost`, release build) — not by this port.
const RUST_TRADE_COST = [
  { q: [0, 0], b: 10, idx: 0, shares: 1e-9, cost: 5.000000000125e-10 },
  { q: [0, 0], b: 100, idx: 1, shares: 1e-9, cost: 5.000000000012501e-10 },
  { q: [5, -3, 1], b: 7.5, idx: 1, shares: 1e-9, cost: 1.782441401221674e-10 },
  { q: [120, 80], b: 50, idx: 0, shares: 1e-9, cost: 6.899744811297516e-10 },
  { q: [0, 0], b: 10, idx: 0, shares: 1e-6, cost: 5.000000125e-7 },
  { q: [3, 1, 2], b: 4, idx: 2, shares: 2.5, cost: 9.982964712133825e-1 },
  { q: [0, 0], b: 10, idx: 0, shares: 1e4, cost: 9.9930685281944e3 },
];

const relErr = (a, ref) => Math.abs(a - ref) / Math.abs(ref);

run('trade cost matches the ghostsignals 0.2.0 crate to 1e-13 relative, incl. 1e-9-share trades', () => {
  for (const c of RUST_TRADE_COST) {
    const { cost } = lmsrTradeCost(c.q, c.b, c.idx, c.shares);
    const e = relErr(cost, c.cost);
    assert.ok(e < 1e-13, `q=${JSON.stringify(c.q)} b=${c.b} shares=${c.shares}: ${cost} vs crate ${c.cost} (rel err ${e.toExponential(2)})`);
  }
});

run('tiny trades (1e-9 shares) agree with an independent 2nd-order series to 1e-12 relative', () => {
  // For x = d/b → 0: C(q+d·e_i) − C(q) = b·ln(1 + p(eˣ−1)) = p·d·(1 + (1−p)·x/2) + O(p·d·x²).
  // The truncation term is < 1e-14 relative here, and p comes from the softmax
  // (lmsrPrices), not from the code under test — an independent reference.
  let checked = 0, worst = 0;
  for (let i = 0; i < 2000; i++) {
    const { n, b, q } = randomState();
    const idx = Math.floor(rnd() * n);
    const d = 1e-9;
    const p = lmsrPrices(q, b)[idx];
    const ref = p * d * (1 + (1 - p) * (d / b) / 2);
    let cost;
    try { ({ cost } = lmsrTradeCost(q, b, idx, d)); } catch (e) {
      // Only a trade below the float resolution of C(q) may be refused as dust.
      assert.match(e.message, /too small/);
      assert.ok(ref < Math.abs(lmsrCost(q, b)) * Number.EPSILON, `refused a resolvable trade: ref cost ${ref}, C(q)=${lmsrCost(q, b)}`);
      continue;
    }
    const e = relErr(cost, ref);
    worst = Math.max(worst, e);
    assert.ok(e < 1e-12, `1e-9 shares: ${cost} vs series ${ref} (rel err ${e.toExponential(2)}, q=${JSON.stringify(q)}, b=${b}, idx=${idx})`);
    checked++;
  }
  assert.ok(checked > 1000, `only ${checked} tiny trades were priced`);
});

run('closed form agrees with the direct C(q+d) − C(q) on moderate trades (1e-10 relative)', () => {
  for (let i = 0; i < 2000; i++) {
    const { n, b, q } = randomState();
    const idx = Math.floor(rnd() * n);
    const d = Math.exp(rnd() * 5 - 2) * b;          // 0.14b .. 20b: no cancellation to speak of
    const qAfter = q.slice(); qAfter[idx] += d;
    const direct = lmsrCost(qAfter, b) - lmsrCost(q, b);
    const { cost } = lmsrTradeCost(q, b, idx, d);
    // Absolute floor: the direct form itself is only good to ~ulp(C(q)).
    const tol = 1e-10 * Math.abs(direct) + 8 * Number.EPSILON * Math.abs(lmsrCost(q, b));
    assert.ok(Math.abs(cost - direct) <= tol, `${cost} vs direct ${direct} (q=${JSON.stringify(q)}, b=${b}, d=${d})`);
  }
});

run('a buy past exp() overflow (d/b > 709) falls back to log-sum-exp and stays finite', () => {
  // expm1(1000) = Infinity, so the closed form is not finite; the fallback
  // gives b·(ln((e^1000 + 1)/2)) = 1000 − ln 2 for b = 1.
  const { cost } = lmsrTradeCost([0, 0], 1, 0, 1000);
  assert.ok(Number.isFinite(cost) && Math.abs(cost - (1000 - Math.LN2)) < 1e-9, `cost ${cost}`);
  const big = lmsrTradeCost([0, 5, -5], 0.01, 2, 1e6);
  assert.ok(Number.isFinite(big.cost) && big.cost > 0 && big.cost <= 1e6, `cost ${big.cost}`);
});

run('lmsrTradeCost does not mutate its input q', () => {
  const q = [1, 2, 3];
  lmsrTradeCost(q, 5, 1, 2);
  assert.deepStrictEqual(q, [1, 2, 3]);
});

if (failed) { console.error(`\n${failed} lmsr test(s) FAILED`); process.exitCode = 1; }
else console.log('\nAll lmsr tests passed');
