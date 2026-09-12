/**
 * ghostsignals-hub.js — Constellation-wide prediction market service.
 *
 * Reference implementation of ADR-0012:
 * https://github.com/NickFlach/open-resonance-collective/blob/main/docs/adr/ADR-0012-constellation-wide-prediction-markets.md
 *
 * Promotes the hologram's in-page GSHub to a server-side, persistent,
 * multi-agent shared market layer. SQLite-backed at ~/.kannaka/ghostsignals.db.
 *
 * Exports a `GhostSignalsHub` class. Call `init()` once at startup, then
 * use `createMarket / placeTrade / resolveMarket / registerTrader / ...`.
 *
 * The HTTP layer in routes.js wraps these methods.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
// ADR-0041 Phase 2 (funded-AMM PR 2): labs-tier markets move REAL conserved
// credits on the KAX ledger. INERT until KAX_LEDGER_BASE + tokens are set —
// kax.mintEnabled()/tradeEnabled() gate everything, so with no env every market
// is ledger_backed=0 and the existing SQLite economy runs exactly as before.
const kax = require('./kax-ledger');

// Integer share ticks per share (mirror of kax.MINOR). A winning position pays
// $1/share, so its payout in ledger minor units is exactly its share_ticks.
const SHARE_TICK = kax.MINOR;

// We require the stem-server's sqlite3 install if available — both apps
// run on the same host so they share the binary. Falls back to the local
// kannaka-radio install if present.
function loadSqlite3() {
  const tries = [
    '/home/opc/open-resonance-collective/packages/stem-server/node_modules/sqlite3',
    'sqlite3',
  ];
  for (const p of tries) {
    try { return require(p).verbose(); } catch (_) {}
  }
  throw new Error('sqlite3 module not found — install in radio or stem-server');
}

// ── LMSR cost function ────────────────────────────────────────────────
// Pure, input-guarded math lives in ./lmsr (property-tested without a DB).
// A negative / zero / NaN liquidity or a <2-outcome market is refused there:
// each of those turned the cost function into a mint (see lmsr.test.js).
const { lmsrCost, lmsrPrices, lmsrTradeCost, assertLiquidity, MAX_OUTCOMES } = require('./lmsr');

// ── Input bounds (the hub is the money boundary; validate here, not only in
// routes.js, so an internal caller cannot bypass them either) ───────────────
const TRADER_ID_RE = /^[^\s\x00-\x1f\x7f]{1,128}$/;   // printable, no whitespace
const TRADER_KIND_RE = /^[a-z][a-z0-9_-]{0,31}$/i;
const MAX_QUESTION = 2000;
const MAX_OUTCOME_LABEL = 120;
const MAX_DISPLAY_NAME = 120;
const MAX_LIQUIDITY = 1e6;
const MAX_TTL_SEC = 10 * 366 * 86400;             // |ttl| bound; negative = born expired (tests)

/**
 * A market may not ask about a field its own record leaves null.
 *
 * The resonance generator opened tens of thousands of markets asking whether a
 * track would "stay on the canonical reference album for its phase" while
 * carrying `metadata: { orc_phase: null, orc_stem_id: null }`. There is no
 * phase. Nothing could ever be compared to anything, so every one of them ran
 * to its TTL and was awarded by price. The market was ceremony from the moment
 * it opened, and no resolver fix reaches backwards to make it answerable.
 *
 * So refuse at the door. For each metadata key whose value is null, take the
 * words of the key (dropping a namespace prefix like `orc_`) and refuse if any
 * of them appears in the question. A question that names a thing the record
 * does not have is unanswerable by construction, and that is knowable here.
 *
 * Returns the offending key, or null when the market is askable.
 * @param {string} question
 * @param {object|null|undefined} metadata
 */
function unanswerableBy(question, metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const q = String(question).toLowerCase();
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== null) continue;
    const words = String(key).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    // Drop a leading namespace segment (orc_phase -> phase) but keep the rest,
    // so `orc` alone never triggers and `phase` does.
    const meaningful = words.length > 1 ? words.slice(1) : words;
    for (const w of meaningful) {
      if (q.includes(w)) return key;
    }
  }
  return null;
}
const MAX_METADATA_BYTES = 8192;
const IDEMPOTENCY_KEY_RE = /^[^\s\x00-\x1f\x7f]{1,64}$/;
/** True for the labs tier: oracle-settled, deterministic ids, KAX ledger when armed. */
function isLabsTier({ tag, source }) { return tag === 'labs' || source === 'kannaka-labs'; }
/** Validate an optional client idempotency key (see placeTrade). */
function idempotencyKeyOf(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !IDEMPOTENCY_KEY_RE.test(v)) throw new Error('idempotency_key must be a 1..64 char string without whitespace');
  return v;
}

// ── Trader bearer tokens (#303) ─────────────────────────────────────────
// A non-`kax:` trader row can hold ONE bearer, minted on the HTTP register
// route and returned exactly once. Format:
//   gs1.<base64url(trader_id)>.<base64url(32 random bytes)>
// The id rides inside the token so the bearer alone names its row (the body's
// trader_id is then a cross-check, never the identity); the `gs1.` prefix
// keeps it distinguishable from a KAX JWT on the same Authorization header.
// Only sha256(salt || secret) with a fresh per-row salt is stored, so a DB
// read yields nothing that can be presented back as a bearer.
const BEARER_PREFIX = 'gs1.';
const BEARER_SECRET_BYTES = 32;
function hashBearerSecret(salt, secret) {
  return crypto.createHash('sha256').update(salt, 'utf8').update(secret).digest('hex');
}
function mintBearer(traderId) {
  const secret = crypto.randomBytes(BEARER_SECRET_BYTES);
  const salt = crypto.randomBytes(16).toString('hex');
  const token = `${BEARER_PREFIX}${Buffer.from(traderId, 'utf8').toString('base64url')}.${secret.toString('base64url')}`;
  return { token, salt, hash: hashBearerSecret(salt, secret) };
}
/** True when an Authorization bearer is a hub-minted trader bearer (vs a KAX JWT). */
function isHubBearer(token) { return typeof token === 'string' && token.startsWith(BEARER_PREFIX); }
/** Split a hub bearer into { trader_id, secret }; null if it is not well-formed. */
function parseBearer(token) {
  if (!isHubBearer(token)) return null;
  const parts = token.slice(BEARER_PREFIX.length).split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const trader_id = Buffer.from(parts[0], 'base64url').toString('utf8');
  const secret = Buffer.from(parts[1], 'base64url');
  if (!TRADER_ID_RE.test(trader_id) || secret.length !== BEARER_SECRET_BYTES) return null;
  return { trader_id, secret };
}
/** Constant-time check of a parsed bearer against a row's stored hash+salt. */
function bearerMatchesRow(parsed, row) {
  if (!parsed || !row || !row.bearer_hash || !row.bearer_salt) return false;
  // The id inside the token must be the row being checked: a caller must never
  // be able to spend row B with a bearer minted for row A, whichever row the
  // lookup happened to load.
  if (parsed.trader_id !== row.id) return false;
  const a = Buffer.from(hashBearerSecret(row.bearer_salt, parsed.secret), 'hex');
  const b = Buffer.from(row.bearer_hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/** The trader row as the API may show it: hash+salt stripped, `has_bearer` added. */
function publicTrader(row) {
  if (!row) return row;
  const { bearer_hash, bearer_salt, ...rest } = row;
  rest.has_bearer = !!bearer_hash;
  return rest;
}

// ── Brier score for reputation update ─────────────────────────────────
function brierAccuracy(predictedProb, actualOutcome /* 1 if happened, 0 else */) {
  const diff = predictedProb - actualOutcome;
  return 1 - diff * diff; // [0, 1] — higher = more accurate
}

class GhostSignalsHub {
  constructor(opts = {}) {
    // Resolve the DB under the canonical Kannaka data dir. `KANNAKA_DATA_DIR`
    // wins (matches the rest of the constellation); otherwise fall back to
    // `~/.kannaka` via os.homedir() so Windows hosts without $HOME land in the
    // user profile instead of a bogus `\home\opc` root path. (#47)
    this.dbPath = opts.dbPath || path.join(
      process.env.KANNAKA_DATA_DIR || path.join(os.homedir(), '.kannaka'),
      'ghostsignals.db',
    );
    this.startingCapital = opts.startingCapital || 100;
    this.defaultLiquidity = opts.defaultLiquidity || 10;
    this.broadcast = opts.broadcast || (() => {});
    this.db = null;
    this._resolverInterval = null;
    // Serializes write-transactions (see _serializeTx). The whole hub shares
    // ONE sqlite connection, so two overlapping BEGIN…COMMIT blocks error with
    // "cannot start a transaction within a transaction". This chain guarantees
    // one at a time.
    this._txChain = Promise.resolve();
    // Per-market serialization for the ledger path (ADR-0041 PR 2). A labs
    // market's trade unit is price → POST /ledger/trade → q-CAS → position; all
    // of it must be serialized PER MARKET so the q we priced against is still
    // current when we commit (the q-CAS then becomes a should-never-fire assert)
    // and two trades can't both be mid-flight against the same pool.
    this._marketChains = new Map();
  }

  /** Serialize `work` against a single market id (see _marketChains). */
  _serializeMarket(marketId, work) {
    const prev = this._marketChains.get(marketId) || Promise.resolve();
    const result = prev.then(() => work(), () => work());
    // Keep the chain alive regardless of outcome; prune when it drains.
    const link = result.then(() => {}, () => {});
    this._marketChains.set(marketId, link);
    link.then(() => {
      if (this._marketChains.get(marketId) === link) this._marketChains.delete(marketId);
    });
    return result;
  }

  /**
   * A market is ledger-backed iff it was created as labs-tier WHILE the KAX
   * mint+trade surfaces were configured. Dormant by default: with no env, no
   * market is ever ledger_backed, so the SQLite path below is untouched.
   */
  _isLabsLedger(marketRow) {
    return !!(marketRow && marketRow.ledger_backed) && kax.tradeEnabled();
  }

  /**
   * Collapse a principal to the operator identity used for self-deal comparison.
   * An OBC bot and its KAX agent token are the SAME operator: a KAX agent token's
   * bot_id IS the OBC bot_id it proved control of (kax-identity: "agent tokens
   * trade AS the OBC bot they proved control of"). The observatory stamps an OBC-
   * door proposal's proposedBy as `obc:<bot>`, but that same bot trades labs-tier
   * as `kax:agent:<bot>` (routes.js derives the id from the token) — so a bare
   * string compare NEVER matched and the guard was dead for every OBC-door market
   * (and would be for every new channel). Collapse both prefixes to the bot id so
   * the guard actually fires; anything else compares as its exact string (a
   * `kax:user:` proposer, or a `nostr:`/`bsky:` principal with no linkable KAX
   * trading identity, is only ever its literal self — those channels get identity
   * binding at propose time, not aliasing here).
   */
  _selfDealKey(principal) {
    const s = String(principal);
    const m = s.match(/^(?:obc:|kax:agent:)(.+)$/);
    return m ? `bot:${m[1]}` : s;
  }

  /**
   * True when `trader_id` is the principal that proposed this market's prediction
   * (metadata.proposedBy, set by the observatory). Blocks the proposer from
   * trading their own market. Inert on markets with no proposedBy.
   */
  _isSelfDeal(market, trader_id) {
    const proposer = market && market.metadata && market.metadata.proposedBy;
    return !!proposer && this._selfDealKey(trader_id) === this._selfDealKey(proposer);
  }

  /**
   * Sum of subsidy (minor units) escrowed into ledger-backed markets created at
   * or after `sinceIso` — the rolling-window spend for the escrow budget backstop.
   * Returns a BigInt (0n when the column/rows are absent).
   */
  _escrowedSince(sinceIso) {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT COALESCE(SUM(CAST(subsidy_minor AS INTEGER)), 0) AS spent
           FROM markets
          WHERE ledger_backed = 1 AND subsidy_minor IS NOT NULL AND created_at >= ?`,
        [sinceIso],
        (err, row) => {
          if (err) return reject(err);
          resolve(BigInt((row && row.spent) || 0));
        },
      );
    });
  }

  /**
   * Run a write-transaction with exclusive access to the shared connection.
   * The in-SQL guards (single-flip resolve, guarded debit, q compare-and-swap)
   * provide correctness under contention; this just prevents two transactions
   * from physically interleaving on the one connection (which sqlite rejects).
   * `work` is a thunk returning a Promise for one BEGIN…COMMIT unit.
   */
  _serializeTx(work) {
    const result = this._txChain.then(() => work(), () => work());
    // Keep the chain alive regardless of this unit's outcome.
    this._txChain = result.then(() => {}, () => {});
    return result;
  }

  // ── Lifecycle ────────────────────────────────────────────────────
  /**
   * `async` is load-bearing, not decoration.
   *
   * The three statements below can all throw SYNCHRONOUSLY — loadSqlite3()
   * when the module is absent, mkdirSync() when the data dir cannot be
   * created, and new Database() on an unopenable path. Without `async` those
   * throws escaped before the Promise below existed, so the caller's
   * `init().then(...).catch(...)` never got a chance to attach: the exception
   * propagated out as an uncaught error and took the whole radio down at
   * startup. `.catch()` only ever protected the async half.
   *
   * As an async function, a synchronous throw becomes a rejection and the
   * existing handler at the call site works as it always appeared to. (#155)
   */
  /**
   * True once init() has opened the database. Routes use this to answer with
   * an honest "subsystem unavailable" instead of letting a null `db` surface
   * as `Cannot read properties of null (reading 'serialize')`. (#155)
   */
  isReady() {
    return this.db !== null && this.db !== undefined;
  }

  async init() {
    const sqlite3 = loadSqlite3();
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new sqlite3.Database(this.dbPath);
    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run(`CREATE TABLE IF NOT EXISTS traders (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          kind TEXT NOT NULL,
          capital REAL NOT NULL DEFAULT 100,
          reputation REAL NOT NULL DEFAULT 0.5,
          trades_total INTEGER NOT NULL DEFAULT 0,
          trades_won INTEGER NOT NULL DEFAULT 0,
          joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_active DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        this.db.run(`CREATE TABLE IF NOT EXISTS markets (
          id TEXT PRIMARY KEY,
          question TEXT NOT NULL,
          outcomes TEXT NOT NULL,
          liquidity REAL NOT NULL,
          q TEXT NOT NULL,
          source TEXT NOT NULL,
          source_app TEXT,
          tag TEXT,
          metadata TEXT,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          expires_at DATETIME NOT NULL,
          resolved INTEGER NOT NULL DEFAULT 0,
          resolved_outcome INTEGER,
          resolved_at DATETIME,
          resolution_method TEXT,
          volume REAL NOT NULL DEFAULT 0
        )`);
        this.db.run(`CREATE TABLE IF NOT EXISTS trades (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          market_id TEXT NOT NULL,
          trader_id TEXT NOT NULL,
          outcome_idx INTEGER NOT NULL,
          shares REAL NOT NULL,
          cost REAL NOT NULL,
          recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        this.db.run(`CREATE TABLE IF NOT EXISTS positions (
          market_id TEXT NOT NULL,
          trader_id TEXT NOT NULL,
          outcome_idx INTEGER NOT NULL,
          shares REAL NOT NULL DEFAULT 0,
          PRIMARY KEY (market_id, trader_id, outcome_idx)
        )`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_markets_active ON markets(resolved, expires_at)`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_markets_volume ON markets(volume)`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_trades_market ON trades(market_id)`);
        // ── ADR-0041 Phase 2 (funded-AMM PR 2) additive migration ──────────
        // Ledger-backed labs markets carry a lifecycle state + funded subsidy;
        // trades carry audit-grade integer minor units alongside the float; a
        // pending_trades journal records intent BEFORE each ledger POST so an
        // ambiguous outcome is reconcilable. Run unconditionally and swallow the
        // "duplicate column" error so the migration is idempotent across boots.
        const addCol = (sql) => this.db.run(sql, (e) => {
          if (e && !/duplicate column/i.test(e.message)) console.error('gshub migrate:', e.message);
        });
        // #303: per-row trader bearer (hash + salt only; see mintBearer). NULL on
        // every pre-existing row — such a row keeps trading unauthenticated
        // until it registers over HTTP and receives its bearer.
        addCol(`ALTER TABLE traders ADD COLUMN bearer_hash TEXT`);
        addCol(`ALTER TABLE traders ADD COLUMN bearer_salt TEXT`);
        addCol(`ALTER TABLE markets ADD COLUMN state TEXT NOT NULL DEFAULT 'open'`);
        addCol(`ALTER TABLE markets ADD COLUMN subsidy_minor TEXT`);
        addCol(`ALTER TABLE markets ADD COLUMN ledger_backed INTEGER NOT NULL DEFAULT 0`);
        addCol(`ALTER TABLE trades ADD COLUMN cost_minor TEXT`);
        addCol(`ALTER TABLE trades ADD COLUMN share_ticks INTEGER`);
        // tx_id correlates a committed trade row with its ledger debit, so the
        // reconciler can tell "debit landed AND shares committed" (row exists)
        // from "debit landed, shares did NOT commit" (needs refund).
        addCol(`ALTER TABLE trades ADD COLUMN tx_id TEXT`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_trades_txid ON trades(tx_id)`);
        // Client idempotency key (hardening): a retried POST carries the same
        // (trader_id, idempotency_key) and is applied at most once. The partial
        // UNIQUE index is the real guard; the pre-check in placeTrade is the
        // fast path that turns a replay into the original result.
        addCol(`ALTER TABLE trades ADD COLUMN idempotency_key TEXT`);
        this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_idem ON trades(trader_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);
        this.db.run(`CREATE TABLE IF NOT EXISTS pending_trades (
          tx_id TEXT PRIMARY KEY,
          market_id TEXT NOT NULL,
          trader_id TEXT NOT NULL,
          outcome_idx INTEGER NOT NULL,
          shares REAL NOT NULL,
          cost_minor TEXT NOT NULL,
          share_ticks INTEGER NOT NULL,
          q_before TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'posting',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_pending_trades_state ON pending_trades(state)`);
        addCol(`ALTER TABLE pending_trades ADD COLUMN idempotency_key TEXT`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_trades_trader ON trades(trader_id)`, (err) => {
          if (err) return reject(err);
          // Seed system trader if not present
          this.db.get('SELECT id FROM traders WHERE id = ?', ['system'], (e, row) => {
            if (row) return resolve();
            this.db.run(
              `INSERT INTO traders (id, display_name, kind, capital, reputation) VALUES (?, ?, ?, ?, ?)`,
              ['system', 'System Bootstrapper', 'system', 1000, 0.5],
              (e2) => e2 ? reject(e2) : resolve()
            );
          });
        });
      });
    });
  }

  startResolverLoop(intervalMs = 10000) {
    if (this._resolverInterval) return;
    // Boot crash-recovery pass for the ledger path (no-op when KAX unarmed).
    this.reconcile().catch(() => {});
    let tick = 0;
    this._resolverInterval = setInterval(() => {
      this._resolveExpiredMarkets().catch(() => {});
      // Piggyback the ledger reconcile+audit every ~6th tick (≈60s by default).
      if (++tick % 6 === 0) this.reconcile().catch(() => {});
    }, intervalMs);
  }

  stopResolverLoop() {
    if (this._resolverInterval) {
      clearInterval(this._resolverInterval);
      this._resolverInterval = null;
    }
  }

  // ── Trader API ───────────────────────────────────────────────────
  /**
   * Register (or re-touch) a trader row.
   *
   * `issue_bearer` (the HTTP register route sets it; internal callers such as
   * the boot seeds and the KAX auto-registration do not) makes the call part
   * of the #303 bearer contract:
   *   - a NEW row is created with a bearer and the plaintext `token` is
   *     returned ON THIS CALL ONLY (the row keeps hash+salt);
   *   - a PRE-EXISTING row without a bearer (the pre-#303 fleet: boot seeds,
   *     the ~44 registered nodes) is NOT claimed by an anonymous register —
   *     that would let one POST take a permanent bearer on `kannaka-01`. It
   *     is returned as today, with no token, and keeps trading open. Only a
   *     caller holding the oracle token (`oracle: true`) attaches a bearer to
   *     such a row: that is the migration path for an existing node;
   *   - an existing row that HAS a bearer is refused with 409 unless `bearer`
   *     is that row's current token, in which case the bearer is ROTATED and
   *     the new token returned. Without this rule anyone could take over a
   *     row by re-registering its id. Recovery is resetBearer() (oracle).
   * `kax:` rows never carry a bearer: their identity is the KAX token.
   * Without `issue_bearer` the call behaves exactly as before #303.
   *
   * The whole read-decide-write runs as ONE serialized unit with its own
   * BEGIN/COMMIT: a bare db.run on the shared connection would enlist in
   * whatever transaction another unit (resolver sweep, placeTrade) has open
   * and be rolled back with it — the caller would hold a token the row never
   * recorded. The token is handed back only after COMMIT.
   */
  async registerTrader({ id, display_name, kind = 'ai', bearer, issue_bearer = false, oracle = false } = {}) {
    // Bounds first: an id with whitespace/control chars, an unbounded
    // display name, or a free-text kind all landed in the DB (and on the
    // public leaderboard) verbatim before this.
    if (id !== undefined && id !== null && (typeof id !== 'string' || !TRADER_ID_RE.test(id))) {
      throw new Error('id must be a 1..128 char string without whitespace or control characters');
    }
    if (display_name !== undefined && display_name !== null &&
        (typeof display_name !== 'string' || !display_name.trim() || display_name.length > MAX_DISPLAY_NAME)) {
      throw new Error(`display_name must be a non-empty string of at most ${MAX_DISPLAY_NAME} characters`);
    }
    if (typeof kind !== 'string' || !TRADER_KIND_RE.test(kind)) {
      throw new Error('kind must be a short alphanumeric label (e.g. ai, human, agent, user, service)');
    }
    const traderId = id || crypto.randomBytes(6).toString('hex');
    const wantBearer = !!issue_bearer && !/^kax:/i.test(traderId);
    const self = this;
    const withToken = (row, returning, token) => {
      const out = { ...publicTrader(row), returning };
      if (token) out.token = token;
      return out;
    };
    return this._serializeTx(async () => {
      await self._run('BEGIN');
      try {
        const row = await self._get('SELECT * FROM traders WHERE id = ?', [traderId]);
        let result;
        if (row) {
          if (row.bearer_hash && wantBearer && !bearerMatchesRow(parseBearer(bearer), row)) {
            throw Object.assign(
              new Error(`trader '${traderId}' already has a bearer token; present it as 'Authorization: Bearer <token>' to re-register (this rotates it), or register a different agent_id`),
              { status: 409 },
            );
          }
          const claimLegacy = !row.bearer_hash && wantBearer && oracle;
          const rotate = !!row.bearer_hash && wantBearer;
          if (claimLegacy || rotate) {
            const minted = mintBearer(traderId);
            await self._run(
              'UPDATE traders SET bearer_hash = ?, bearer_salt = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?',
              [minted.hash, minted.salt, traderId],
            );
            result = withToken({ ...row, bearer_hash: minted.hash, bearer_salt: minted.salt }, true, minted.token);
          } else {
            await self._run('UPDATE traders SET last_active = CURRENT_TIMESTAMP WHERE id = ?', [traderId]);
            result = withToken(row, true);
          }
        } else {
          const minted = wantBearer ? mintBearer(traderId) : null;
          await self._run(
            `INSERT INTO traders (id, display_name, kind, capital, bearer_hash, bearer_salt) VALUES (?, ?, ?, ?, ?, ?)`,
            [traderId, display_name || traderId, kind, self.startingCapital, minted ? minted.hash : null, minted ? minted.salt : null],
          );
          const full = await self._get('SELECT * FROM traders WHERE id = ?', [traderId]);
          result = withToken(full, false, minted ? minted.token : null);
          result._joined = publicTrader(full);
        }
        await self._run('COMMIT');
        if (result._joined) { self.broadcast({ type: 'gs_trader_joined', data: result._joined }); delete result._joined; }
        return result;
      } catch (e) {
        await self._run('ROLLBACK').catch(() => {});
        throw e;
      }
    });
  }

  /**
   * Verify a hub bearer (#303). Resolves { ok:true, trader_id } when the token
   * names a row and matches its stored hash, else { ok:false, error }. Never
   * throws on a malformed token; the row it names is the identity.
   */
  async verifyBearer(token) {
    const parsed = parseBearer(token);
    if (!parsed) return { ok: false, error: 'malformed hub bearer token' };
    const row = await this._get('SELECT id, bearer_hash, bearer_salt FROM traders WHERE id = ?', [parsed.trader_id]);
    if (!row) return { ok: false, error: 'bearer names an unknown trader' };
    if (!bearerMatchesRow(parsed, row)) return { ok: false, error: 'bearer does not match the trader row' };
    return { ok: true, trader_id: row.id };
  }

  /**
   * Clear a row's bearer (#303 recovery; oracle-gated in routes.js). The row
   * goes back to the open, no-bearer state so its node can register again and
   * receive a fresh token. Resolves the public row, or null if no such row.
   */
  async resetBearer(id) {
    if (typeof id !== 'string' || !TRADER_ID_RE.test(id)) throw new Error('id must be a valid trader id');
    return this._serializeTx(async () => {
      const r = await this._run('UPDATE traders SET bearer_hash = NULL, bearer_salt = NULL WHERE id = ?', [id]);
      if (!r.changes) return null;
      return publicTrader(await this._get('SELECT * FROM traders WHERE id = ?', [id]));
    });
  }

  getTrader(id) {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT * FROM traders WHERE id = ?', [id], (err, raw) => {
        if (err) return reject(err);
        if (!raw) return resolve(null);
        const row = publicTrader(raw);
        // Add accuracy
        row.accuracy = row.trades_total > 0 ? row.trades_won / row.trades_total : 0;
        resolve(row);
      });
    });
  }

  /** A trader's positions joined with market context (dashboard wallet view). */
  getTraderPositions(trader_id) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT p.market_id, p.outcome_idx, p.shares,
                m.question, m.outcomes, m.resolved, m.resolved_outcome, m.state, m.expires_at
           FROM positions p JOIN markets m ON m.id = p.market_id
          WHERE p.trader_id = ? AND p.shares > 0
          ORDER BY m.created_at DESC LIMIT 100`,
        [trader_id],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows.map((r) => {
            let label = String(r.outcome_idx);
            try { label = JSON.parse(r.outcomes)[r.outcome_idx] ?? label; } catch (_) { /* raw idx */ }
            return {
              market_id: r.market_id,
              question: r.question,
              outcome_idx: r.outcome_idx,
              outcome: label,
              shares: r.shares,
              resolved: !!r.resolved,
              // A voided market has resolved=1 and resolved_outcome=NULL. Without
              // this branch `NULL === idx` is false and every refunded position
              // reads as a loss the trader never took.
              voided: !!r.resolved && r.resolved_outcome === null,
              won: r.resolved ? (r.resolved_outcome === null ? null : r.resolved_outcome === r.outcome_idx) : null,
              state: r.state || 'open',
              expires_at: r.expires_at,
            };
          }));
        },
      );
    });
  }

  /** A trader's recent trades joined with market context (dashboard history). */
  getTraderTrades(trader_id, limit = 25) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT t.market_id, t.outcome_idx, t.shares, t.cost, t.cost_minor, t.recorded_at,
                m.question, m.outcomes
           FROM trades t JOIN markets m ON m.id = t.market_id
          WHERE t.trader_id = ?
          ORDER BY t.recorded_at DESC LIMIT ?`,
        [trader_id, Math.max(1, Math.min(100, Number(limit) || 25))],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows.map((r) => {
            let label = String(r.outcome_idx);
            try { label = JSON.parse(r.outcomes)[r.outcome_idx] ?? label; } catch (_) { /* raw idx */ }
            return {
              market_id: r.market_id,
              question: r.question,
              outcome: label,
              shares: r.shares,
              cost: r.cost,
              cost_minor: r.cost_minor || null,
              at: r.recorded_at,
            };
          }));
        },
      );
    });
  }

  leaderboard({ sort = 'capital', limit = 20 } = {}) {
    const orderCol = ({ capital: 'capital', reputation: 'reputation', accuracy: '(CAST(trades_won AS REAL) / NULLIF(trades_total, 0))' })[sort] || 'capital';
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT id, display_name, kind, capital, reputation, trades_total, trades_won
         FROM traders
         WHERE id != 'system'
         ORDER BY ${orderCol} DESC
         LIMIT ?`,
        [Math.max(1, Math.min(100, Number(limit) || 20))],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows.map(r => ({ ...r, accuracy: r.trades_total > 0 ? r.trades_won / r.trades_total : 0 })));
        }
      );
    });
  }

  // ── Market API ───────────────────────────────────────────────────
  async createMarket({ question, outcomes = ['Yes', 'No'], ttl_sec = 3600, liquidity, tag = 'custom', source = 'system', source_app, metadata } = {}) {
    // ── Input bounds. Everything here reaches the cost function or the
    // public listing verbatim, so it is validated at the money boundary.
    if (typeof question !== 'string' || !question.trim() || question.length > MAX_QUESTION) {
      throw new Error(`question must be a non-empty string of at most ${MAX_QUESTION} characters`);
    }
    if (!Array.isArray(outcomes) || outcomes.length < 2 || outcomes.length > MAX_OUTCOMES ||
        !outcomes.every((o) => typeof o === 'string' && o.trim() && o.length <= MAX_OUTCOME_LABEL) ||
        new Set(outcomes).size !== outcomes.length) {
      throw new Error(`outcomes must be 2..${MAX_OUTCOMES} distinct non-empty strings (max ${MAX_OUTCOME_LABEL} chars each)`);
    }
    if (typeof ttl_sec !== 'number' || !Number.isFinite(ttl_sec) || Math.abs(ttl_sec) > MAX_TTL_SEC) {
      throw new Error(`ttl_sec must be a finite number of seconds (|ttl| <= ${MAX_TTL_SEC})`);
    }
    // 0 / undefined / null mean "the default"; anything else must be a sane b.
    const lq = (liquidity === undefined || liquidity === null || liquidity === 0) ? this.defaultLiquidity : liquidity;
    assertLiquidity(lq);
    if (lq > MAX_LIQUIDITY) throw new Error(`liquidity must be <= ${MAX_LIQUIDITY}`);
    for (const [k, v] of Object.entries({ tag, source, source_app })) {
      if (v !== undefined && v !== null && (typeof v !== 'string' || !v.trim() || v.length > 64)) throw new Error(`${k} must be a short string`);
    }
    if (metadata !== undefined && metadata !== null) {
      if (typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('metadata must be an object');
      if (JSON.stringify(metadata).length > MAX_METADATA_BYTES) throw new Error(`metadata must serialise to <= ${MAX_METADATA_BYTES} bytes`);
      const missing = unanswerableBy(question, metadata);
      if (missing) {
        throw new Error(`question asks about "${missing}" but the market's own metadata leaves it null — unanswerable, not opened`);
      }
    }
    const labsTier = isLabsTier({ tag, source });

    // Idempotent creation for prediction-paired markets. A labs market paired to
    // a registry prediction gets a DETERMINISTIC id derived from its predictionId,
    // so a retry — the observatory timing out its 8s call while the escrow HERE
    // actually succeeded, then re-driving via the /market backfill — recomputes
    // the same id, finds the existing market, and returns it instead of inserting
    // a second row and escrowing a SECOND subsidy from the house. (The escrow
    // txid is escrow:<id>, so it too becomes deterministic — double protection.)
    //
    // LABS-TIER ONLY. Play/ambient markets always get a random id: the play
    // create endpoint is open, so honouring predictionId there let anyone
    // pre-create m_<sha256(prediction:<id>)> as a TTL-resolved play market and
    // have the registry's later labs create for that prediction "idempotently"
    // return the squatted market (no oracle, no escrow, price-resolved).
    const predictionId = labsTier && metadata && metadata.predictionId ? String(metadata.predictionId) : null;
    const id = predictionId
      ? 'm_' + crypto.createHash('sha256').update('prediction:' + predictionId).digest('hex').slice(0, 12)
      : 'm_' + crypto.randomBytes(6).toString('hex');
    if (predictionId) {
      const existing = await this.getMarket(id);
      // Same prediction, market already exists → idempotent no-op. A prior attempt
      // that died mid-escrow is still pending_escrow; the reconciler completes it,
      // so returning it here never double-funds. Defensive: the existing row must
      // itself be labs-tier (a legacy squat would otherwise be returned here).
      if (existing) {
        if (!isLabsTier(existing)) throw new Error(`market id ${id} is held by a non-labs market; refusing to alias it`);
        return existing;
      }
    }
    const q = new Array(outcomes.length).fill(0);
    const expiresAt = new Date(Date.now() + ttl_sec * 1000).toISOString();
    // Ledger-backed ONLY when created labs-tier AND the KAX mint+trade surfaces
    // are both armed. Dormant otherwise → a plain SQLite market, unchanged.
    const labsLedger = labsTier && kax.mintEnabled() && kax.tradeEnabled();
    const subsidyMinor = labsLedger ? kax.subsidyMinor(lq, outcomes.length) : null;
    const state = labsLedger ? 'pending_escrow' : 'open';

    // Escrow budget backstop (hub-side, BEFORE insert/escrow). The KAX `house`
    // account is a MINT — it is designed to run negative, and the ledger's
    // overdraft guard exempts it — so there is no "treasury balance" to floor.
    // What actually needs bounding is the RATE of minting: a sybil/loop of valid
    // proposals would escrow a fresh subsidy each, minting play-credits without
    // limit. The hub owns the money path (no adapter can bypass it), so a rolling
    // budget lives here, computed from the markets table itself (persistent and
    // exact across restarts): refuse if the subsidy already escrowed in the
    // window plus this one would exceed the budget. Off by default (unset env =
    // no cap, behaviour unchanged); arm GSHUB_ESCROW_BUDGET_MINOR in prod. The
    // always-on per-principal cap lives observatory-side where identity is known.
    if (labsLedger && process.env.GSHUB_ESCROW_BUDGET_MINOR) {
      const budget = BigInt(process.env.GSHUB_ESCROW_BUDGET_MINOR);
      const windowMs = Number(process.env.GSHUB_ESCROW_WINDOW_MS || 24 * 3600 * 1000);
      const since = new Date(Date.now() - windowMs).toISOString();
      const spent = await this._escrowedSince(since);
      if (spent + BigInt(subsidyMinor) > budget) {
        throw new Error(`escrow budget: ${spent} already escrowed in window + subsidy ${subsidyMinor} exceeds ${budget} — market not opened (retry later)`);
      }
    }

    await this._run(
      `INSERT INTO markets
        (id, question, outcomes, liquidity, q, source, source_app, tag, metadata, expires_at, state, subsidy_minor, ledger_backed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, question, JSON.stringify(outcomes), lq, JSON.stringify(q),
        source, source_app || null, tag, metadata ? JSON.stringify(metadata) : null,
        expiresAt, state, subsidyMinor, labsLedger ? 1 : 0,
      ],
    );

    if (labsLedger) {
      // Fund the LMSR subsidy into the pool BEFORE opening (idempotent escrow:<id>).
      // A definitive rejection voids the market; an ambiguous outcome leaves it
      // pending_escrow for the reconciler — either way it never opens unfunded.
      let r;
      try { r = await kax.escrow({ marketId: id, subsidyMinor, ref: `market:${id}` }); }
      catch (e) { await this._setMarketState(id, 'voided'); throw new Error(`escrow failed to send: ${e.message}`); }
      if (r.ok) {
        await this._setMarketState(id, 'open');
      } else if (r.definitive) {
        await this._setMarketState(id, 'voided');
        throw new Error(`escrow rejected (${r.status}): ${r.error}`);
      } else {
        throw new Error(`escrow ambiguous (${r.status}): ${r.error} — market ${id} pending reconciliation`);
      }
    }

    const m = await this.getMarket(id);
    this.broadcast({ type: 'gs_market_created', data: m });
    return m;
  }

  getMarket(id) {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT * FROM markets WHERE id = ?', [id], (err, row) => {
        if (err) return reject(err);
        if (!row) return resolve(null);
        resolve(this._enrichMarket(row));
      });
    });
  }

  _enrichMarket(row) {
    const outcomes = JSON.parse(row.outcomes);
    const q = JSON.parse(row.q);
    const prices = lmsrPrices(q, row.liquidity);
    return {
      id: row.id,
      question: row.question,
      outcomes,
      liquidity: row.liquidity,
      q,
      prices,
      source: row.source,
      source_app: row.source_app,
      tag: row.tag,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      created_at: row.created_at,
      expires_at: row.expires_at,
      resolved: !!row.resolved,
      resolved_outcome: row.resolved_outcome,
      resolved_at: row.resolved_at,
      resolution_method: row.resolution_method,
      volume: row.volume,
      // ADR-0041 PR 2: ledger lifecycle. Defaults ('open'/0/null) mean the
      // pre-ledger SQLite economy, so existing markets read back unchanged.
      state: row.state || 'open',
      ledger_backed: !!row.ledger_backed,
      subsidy_minor: row.subsidy_minor || null,
      ttl_remaining_sec: Math.max(0, Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000)),
    };
  }

  listMarkets({ sort = 'volume', active = true, limit = 20, tag } = {}) {
    return new Promise((resolve, reject) => {
      const conds = [];
      const params = [];
      if (active) conds.push('resolved = 0');
      if (tag) { conds.push('tag = ?'); params.push(tag); }
      const where = conds.length > 0 ? 'WHERE ' + conds.join(' AND ') : '';
      const orderCol = ({
        volume: 'volume DESC',
        recent: 'created_at DESC',
        expiring: 'expires_at ASC',
      })[sort] || 'volume DESC';
      params.push(Math.max(1, Math.min(100, Number(limit) || 20)));
      this.db.all(
        `SELECT * FROM markets ${where} ORDER BY ${orderCol} LIMIT ?`,
        params,
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows.map(r => this._enrichMarket(r)));
        }
      );
    });
  }

  /**
   * Buy `shares` of `outcome` on a market. Both tiers accept an optional
   * `idempotency_key`: a retried POST carrying the same (trader_id, key) is
   * applied ONCE and answered with the original trade (`replay: true`).
   */
  async placeTrade({ market_id, trader_id, outcome, shares, idempotency_key } = {}) {
    if (typeof shares !== 'number' || !Number.isFinite(shares) || shares <= 0) throw new Error('shares must be positive');
    if (!Number.isInteger(outcome) || outcome < 0) throw new Error('outcome must be a non-negative integer');
    if (typeof trader_id !== 'string' || !TRADER_ID_RE.test(trader_id)) throw new Error('trader_id must be a valid trader id');
    const idemKey = idempotencyKeyOf(idempotency_key);
    const market = await this.getMarket(market_id);
    if (!market) throw new Error('market not found');
    if (market.resolved) throw new Error('market already resolved');
    if (outcome >= market.outcomes.length) throw new Error('outcome out of range');
    const trader = await this.getTrader(trader_id);
    if (!trader) throw new Error('trader not registered');

    // Anti-self-dealing (ADR-0041): the trader who PROPOSED a prediction cannot
    // trade on its paired market — they'd be betting on an outcome they can
    // influence (and, for oracle-settled markets, front-run the reading). The
    // proposer principal is carried in metadata.proposedBy by the observatory;
    // it's absent on ordinary (non-labs) markets, so this is inert there.
    if (this._isSelfDeal(market, trader_id)) {
      throw new Error('self-dealing blocked: the proposer of a prediction may not trade on its market');
    }

    // A market that was created ledger-backed holds REAL credits in a KAX pool.
    // If the KAX env is later unset, _isLabsLedger() reads false and this call
    // would have fallen through to the SQLite play economy — debiting play
    // capital for shares in a real pool, then paying play capital at
    // resolution while the real pool sits escrowed. Config drift must fail
    // loudly, never silently change tiers.
    if (market.ledger_backed && !kax.tradeEnabled()) {
      throw new Error('ledger-backed market: KAX trade surface not configured — refusing to trade it as play capital');
    }

    // ADR-0041 PR 2: labs-tier ledger markets move real credits on KAX instead
    // of SQLite capital. Dormant unless the market was created ledger-backed.
    if (this._isLabsLedger(market)) {
      return this._placeTradeLedger({ market, trader_id, outcome, shares, idemKey });
    }
    return this._placeTradePlay({ market_id, trader_id, outcome, shares, idemKey });
  }

  /**
   * The original result of an already-applied trade with this client key, or
   * null. Answers a retried POST with what the first one did.
   */
  async _replayTrade(trader_id, idemKey) {
    if (!idemKey) return null;
    const row = await this._get(
      `SELECT market_id, cost, cost_minor FROM trades WHERE trader_id = ? AND idempotency_key = ?`,
      [trader_id, idemKey],
    );
    if (!row) return null;
    const market = await this.getMarket(row.market_id);
    const out = { cost: row.cost, prices: market ? market.prices : null, market, replay: true };
    if (row.cost_minor) out.cost_minor = row.cost_minor;
    return out;
  }

  /**
   * Play-tier trade: SQLite capital. Serialized PER MARKET, and the market +
   * trader are re-read INSIDE the mutex, so N concurrent trades on one market
   * are priced one after another against the committed q. Before this, all N
   * were priced off the same snapshot and the q compare-and-swap made N−1 of
   * them fail with "market state changed concurrently; retry" — safe, but a
   * burst of honest traders (the radio fires several predictors per track)
   * lost every trade but one. The CAS stays as a should-never-fire assert.
   */
  _placeTradePlay({ market_id, trader_id, outcome, shares, idemKey }) {
    const self = this;
    return this._serializeMarket(market_id, async () => {
      const replay = await self._replayTrade(trader_id, idemKey);
      if (replay) return replay;
      const market = await self.getMarket(market_id);
      if (!market || market.resolved) throw new Error('market already resolved');
      if (market.state !== 'open') throw new Error(`market not open for trading (state=${market.state})`);
      const trader = await self.getTrader(trader_id);
      if (!trader) throw new Error('trader not registered');

      const qBefore = market.q.slice();
      const qBeforeJson = JSON.stringify(qBefore);
      // lmsrTradeCost refuses a cost that rounds to zero (dust shares for free).
      const { cost, qAfter } = lmsrTradeCost(qBefore, market.liquidity, outcome, shares);
      if (cost > trader.capital) {
        throw new Error(`insufficient capital: cost ${cost.toFixed(2)}, available ${trader.capital.toFixed(2)}`);
      }

      // Sequential await-per-statement (mirrors _commitLedgerTradeShares). Every
      // statement carries a completion callback via _run, so a failing BEGIN/
      // COMMIT/ROLLBACK rejects this promise instead of emitting an *unhandled*
      // 'error' event on a callback-less db.run — which used to CRASH the whole
      // radio process (ghostsignals-hub shares the radio's node process). Ordered
      // awaits also mean a "transaction within a transaction" can't arise from a
      // half-issued unit, and _serializeTx only advances once COMMIT/ROLLBACK has
      // actually completed.
      await self._serializeTx(async () => {
        await self._run('BEGIN');
        try {
          // Compare-and-swap the market q. `AND resolved = 0` also blocks a trade
          // that races a resolve. Under the per-market mutex changes===0 means a
          // resolve landed between our read and now; roll back.
          const qRes = await self._run(
            `UPDATE markets SET q = ?, volume = volume + ? WHERE id = ? AND q = ? AND resolved = 0`,
            [JSON.stringify(qAfter), shares, market_id, qBeforeJson],
          );
          if (qRes.changes === 0) throw new Error('market state changed concurrently; retry');
          // Guarded debit: the `AND capital >= ?` makes overdraft impossible even
          // if two concurrent trades (on different markets) both passed the JS
          // precheck above — the second sees the already-reduced balance and
          // fails here rather than driving capital negative (a double-spend).
          const dRes = await self._run(
            `UPDATE traders SET capital = capital - ?, trades_total = trades_total + 1, last_active = CURRENT_TIMESTAMP WHERE id = ? AND capital >= ?`,
            [cost, trader_id, cost],
          );
          if (dRes.changes === 0) throw new Error('insufficient capital');
          await self._run(
            `INSERT INTO trades (market_id, trader_id, outcome_idx, shares, cost, idempotency_key) VALUES (?, ?, ?, ?, ?, ?)`,
            [market_id, trader_id, outcome, shares, cost, idemKey],
          );
          await self._run(
            `INSERT INTO positions (market_id, trader_id, outcome_idx, shares) VALUES (?, ?, ?, ?)
             ON CONFLICT(market_id, trader_id, outcome_idx) DO UPDATE SET shares = shares + ?`,
            [market_id, trader_id, outcome, shares, shares],
          );
          await self._run('COMMIT');
        } catch (e) {
          await self._run('ROLLBACK').catch(() => {});
          if (/UNIQUE constraint failed: trades\.trader_id, trades\.idempotency_key/.test(e.message)) {
            throw new Error('duplicate idempotency_key: this trade was already applied');
          }
          throw e;
        }
      });
      // Post-commit reads/broadcast happen outside the transaction.
      const updated = await self.getMarket(market_id);
      self.broadcast({ type: 'gs_trade', data: { market_id, trader_id, outcome, shares, cost, prices: updated.prices } });
      return { cost, prices: updated.prices, market: updated };
    });
  }

  /**
   * Void a market and refund every trader what they paid into it.
   *
   * This is what "nobody measured it" is supposed to look like. The previous
   * behaviour on TTL expiry was to award the outcome with the highest price,
   * which is not a measurement of anything: it hands the question to whichever
   * side put the most money in, and on an untraded market the prices are equal
   * so `indexOf(max)` silently returns index 0 and outcome ZERO wins by tie.
   * That is how markets with q=[0,0] — never traded, never read — resolved
   * "Yes", and how a scripted opener that bought the same 41 Yes shares every
   * time went 19-for-19.
   *
   * Voiding is the honest answer, and refunding is the honest settlement:
   * nobody profits and nobody loses on a question that was never answered.
   *
   * Reputation is DELIBERATELY not touched. resolveMarket brier-scores every
   * participant against the outcome; doing that on a fabricated outcome is
   * what inflated the top of the leaderboard to a reputation of
   * 0.999999999999999 across tens of thousands of trades. An unmeasured
   * market must score nobody.
   */
  async voidMarket({ market_id, reason = 'unmeasured' }) {
    const self = this;
    const market = await this.getMarket(market_id);
    if (!market) throw new Error('market not found');
    if (market.resolved) throw new Error('already resolved');
    // A ledger-backed market's money lives on KAX; refunding it out of SQLite
    // play capital would mint credits. Those are voided through the ledger.
    if (this._isLabsLedger(market)) {
      throw new Error('ledger-backed market: void it through the ledger, not play capital');
    }
    const method = `void:${String(reason).slice(0, 26)}`;
    return this._serializeTx(async () => {
      await self._run('BEGIN');
      try {
        // Same single-flip guard as resolveMarket: only the transaction that
        // moves resolved 0->1 refunds, so a void racing a resolve (or two
        // voids) can never pay the same stake twice.
        const uRes = await self._run(
          `UPDATE markets SET resolved = 1, resolved_outcome = NULL, resolved_at = CURRENT_TIMESTAMP,
                  resolution_method = ?, state = 'voided'
             WHERE id = ? AND resolved = 0`,
          [method, market_id],
        );
        if (uRes.changes === 0) throw new Error('already resolved');
        // Refund what each trader actually paid: the sum of their trade costs
        // on this market. A sell is recorded as a negative cost, so the sum is
        // the net stake and the refund returns them to where they started.
        const paid = await self._all(
          `SELECT trader_id, SUM(cost) AS paid FROM trades WHERE market_id = ? GROUP BY trader_id`,
          [market_id],
        );
        let refunded = 0;
        for (const row of paid) {
          if (!row.paid) continue;
          await self._run(
            `UPDATE traders SET capital = capital + ?, last_active = CURRENT_TIMESTAMP WHERE id = ?`,
            [row.paid, row.trader_id],
          );
          refunded += row.paid;
        }
        await self._run('COMMIT');
        const out = { ok: true, market_id, voided: true, method, traders: paid.length, refunded };
        this.broadcast({ type: 'gs_market_voided', data: { market_id, reason, traders: paid.length, refunded } });
        return out;
      } catch (e) {
        try { await self._run('ROLLBACK'); } catch (_) { /* already unwound */ }
        throw e;
      }
    });
  }

  /**
   * Resolve a market. Pays out all winning positions at $1/share to their
   * traders, then updates each participating trader's reputation via
   * brier scoring.
   */
  async resolveMarket({ market_id, winning_outcome, method = 'manual' }) {
    const self = this;
    const market = await this.getMarket(market_id);
    if (!market) throw new Error('market not found');
    if (market.resolved) throw new Error('already resolved');
    // Integer check is load-bearing: "0" (a string from a JSON body), 0.5, null
    // and undefined all passed the old `< 0 || >= length` test, flipped
    // resolved=1 with resolved_outcome = that value, and paid NOBODY (the
    // payout loop compares outcome_idx === winning_outcome). A market could be
    // settled with every winner disinherited by a typo.
    if (!Number.isInteger(winning_outcome) || winning_outcome < 0 || winning_outcome >= market.outcomes.length) {
      throw new Error('winning_outcome out of range: must be an integer index into outcomes');
    }
    if (typeof method !== 'string' || !method.trim() || method.length > 32) throw new Error('method must be a short string');
    // Same config-drift guard as placeTrade: a ledger-backed market's payout
    // lives on KAX. Never settle it out of SQLite play capital.
    if (market.ledger_backed && !kax.tradeEnabled()) {
      throw new Error('ledger-backed market: KAX trade surface not configured — refusing to settle it with play capital');
    }
    // ADR-0041 PR 2: ledger-backed markets settle on KAX (batched payout).
    if (this._isLabsLedger(market)) {
      return this._resolveMarketLedger({ market, winning_outcome, method });
    }
    const finalPrices = market.prices.slice();
    // Sequential await-per-statement — see placeTrade for why (callback-less
    // db.run 'error' events crash the shared radio process; ordered awaits keep
    // BEGIN/COMMIT from overlapping across units).
    return this._serializeTx(async () => {
      await self._run('BEGIN');
      try {
        // Single-flip guard: only the transaction that actually changes
        // resolved 0->1 proceeds to pay out. A concurrent resolve (the manual
        // /resolve racing the 10s TTL sweep, or two callers) reads resolved=0
        // in the async gap before this UPDATE, but only ONE of them flips the
        // flag; the loser sees changes===0 and rolls back WITHOUT paying, so
        // winning positions can never be paid twice (which would mint credits).
        // The `market.resolved` precheck above is only a fast path; THIS is the
        // real guard.
        const uRes = await self._run(
          `UPDATE markets SET resolved = 1, resolved_outcome = ?, resolved_at = CURRENT_TIMESTAMP, resolution_method = ? WHERE id = ? AND resolved = 0`,
          [winning_outcome, method, market_id],
        );
        if (uRes.changes === 0) throw new Error('already resolved');
        // Pay out winning shares + update reputation for every participant.
        const positions = await self._all(
          `SELECT trader_id, outcome_idx, shares FROM positions WHERE market_id = ?`,
          [market_id],
        );
        const traders = new Map();
        for (const p of positions) {
          if (!traders.has(p.trader_id)) traders.set(p.trader_id, { yes: 0, no: 0, totalShares: 0 });
          const t = traders.get(p.trader_id);
          t.totalShares += p.shares;
          if (p.outcome_idx === winning_outcome) t.yes += p.shares;
          else t.no += p.shares;
        }
        for (const [trader_id, t] of traders.entries()) {
          // Payout = winning shares × $1. Brier-style accuracy update from this
          // trader's implied predicted probability (share allocation toward the
          // winning outcome).
          const payout = t.yes;
          const impliedYes = t.totalShares > 0 ? t.yes / t.totalShares : 0.5;
          const accuracy = brierAccuracy(impliedYes, 1);
          await self._run(
            `UPDATE traders SET
               capital = capital + ?,
               trades_won = trades_won + ?,
               reputation = reputation * 0.95 + ? * 0.05,
               last_active = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [payout, t.yes > 0 ? 1 : 0, accuracy, trader_id],
          );
        }
        await self._run('COMMIT');
      } catch (e) {
        await self._run('ROLLBACK').catch(() => {});
        throw e;
      }
      const m = await self.getMarket(market_id);
      self.broadcast({ type: 'gs_market_resolved', data: { ...m, finalPrices } });
      return m;
    });
  }

  // ── Ledger-path helpers (ADR-0041 PR 2) ─────────────────────────────
  // Small promisified sqlite wrappers keep the money-path code readable.
  _run(sql, params = []) { return new Promise((res, rej) => this.db.run(sql, params, function (e) { e ? rej(e) : res(this); })); }
  _get(sql, params = []) { return new Promise((res, rej) => this.db.get(sql, params, (e, row) => e ? rej(e) : res(row))); }
  _all(sql, params = []) { return new Promise((res, rej) => this.db.all(sql, params, (e, rows) => e ? rej(e) : res(rows))); }

  // State-mutating single statements go through _serializeTx so they can never
  // be dispatched onto the shared connection WHILE another unit's BEGIN…COMMIT
  // is open (which would enlist them in that transaction and roll them back with
  // it). Chaining them makes the write land in its own autocommit, in order.
  _setMarketState(id, state) { return this._serializeTx(() => this._run(`UPDATE markets SET state = ? WHERE id = ?`, [state, id])); }
  _setPendingState(txId, state) {
    return this._serializeTx(() => this._run(`UPDATE pending_trades SET state = ?, updated_at = CURRENT_TIMESTAMP WHERE tx_id = ?`, [state, txId]));
  }
  _journalPending(r) {
    return this._serializeTx(() => this._run(
      `INSERT INTO pending_trades (tx_id, market_id, trader_id, outcome_idx, shares, cost_minor, share_ticks, q_before, state, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.txId, r.market_id, r.trader_id, r.outcome, r.shares, r.costMinor, r.shareTicks, r.qBeforeJson, r.state, r.idemKey || null],
    ));
  }

  /**
   * Place a labs-tier trade against the KAX ledger. Serialized PER MARKET:
   * re-price under the mutex, journal intent, POST the debit (money first),
   * then commit the shares (q-CAS + position). Ledger-backed traders never
   * touch SQLite capital.
   */
  async _placeTradeLedger({ market, trader_id, outcome, shares, idemKey = null }) {
    const market_id = market.id;
    const principal = kax.principalFor(trader_id);
    return this._serializeMarket(market_id, async () => {
      // Client retry after an ambiguous outcome: answer with the applied trade,
      // or refuse while its first attempt is still being reconciled (a second
      // debit for the same intent is exactly what the key exists to prevent).
      const replay = await this._replayTrade(trader_id, idemKey);
      if (replay) return replay;
      if (idemKey) {
        const pend = await this._get(
          `SELECT tx_id, state FROM pending_trades WHERE trader_id = ? AND idempotency_key = ? AND state IN ('posting', 'reconcile', 'refund')`,
          [trader_id, idemKey],
        );
        if (pend) throw new Error(`trade with this idempotency_key is pending reconciliation (tx ${pend.tx_id}); retry later`);
      }
      // Re-read INSIDE the mutex so the q we price against is current.
      const m = await this.getMarket(market_id);
      if (!m || m.resolved) throw new Error('market already resolved');
      if (m.state !== 'open') throw new Error(`market not open for trading (state=${m.state})`);
      if (outcome >= m.outcomes.length) throw new Error('outcome out of range');
      const qBefore = m.q.slice();
      const qBeforeJson = JSON.stringify(qBefore);
      const qAfter = qBefore.slice();
      qAfter[outcome] += shares;
      const cost = lmsrCost(qAfter, m.liquidity) - lmsrCost(qBefore, m.liquidity);
      // Bound the float→int multiply so cost/share minor units can't lose
      // precision past 2^53 (a huge grant could otherwise corrupt the amounts).
      if (shares * SHARE_TICK >= Number.MAX_SAFE_INTEGER || cost * kax.MINOR >= Number.MAX_SAFE_INTEGER) {
        throw new Error('trade too large (would overflow minor-unit precision)');
      }
      const costMinor = kax.tradeCostMinor(cost);           // ceil, rejects dust <= 0
      const shareTicks = Math.floor(shares * SHARE_TICK);    // floor — pool's favor
      if (!(shareTicks > 0)) throw new Error('shares round to zero ticks');
      const txId = kax.txid.trade(kax.newTradeUuid());

      // 1) Journal intent BEFORE the POST (so an ambiguous outcome is recoverable).
      await this._journalPending({ txId, market_id, trader_id, outcome, shares, costMinor, shareTicks, qBeforeJson, state: 'posting', idemKey });

      // 2) Money FIRST — debit trader, credit pool. (q-first would mint free
      //    shares on a crash between shares and money.)
      const r = await kax.trade({ txId, principal, marketId: market_id, amountMinor: costMinor, side: 'buy', ref: `trade:${market_id}` });
      if (!r.ok) {
        if (r.definitive) { await this._setPendingState(txId, 'failed'); throw new Error(`ledger trade rejected (${r.status}): ${r.error}`); }
        await this._setPendingState(txId, 'reconcile');
        throw new Error(`ledger trade ambiguous (${r.status}): ${r.error} — pending reconciliation`);
      }

      // 3) Shares AFTER money: q-CAS + audit-grade trade row + position, one tx.
      //    Under the per-market mutex the CAS normally holds; it CAN still miss
      //    if the audit halted the market mid-flight (state flips off 'open') —
      //    then the debit already landed, so flag for refund reconciliation.
      try {
        await this._commitLedgerTradeShares({ txId, market_id, trader_id, outcome, shares, cost, costMinor, shareTicks, qAfterJson: JSON.stringify(qAfter), qBeforeJson, idemKey });
      } catch (e) {
        await this._setPendingState(txId, 'refund');
        throw new Error(`shares commit failed after ledger debit (refund queued, tx ${txId}): ${e.message}`);
      }
      await this._setPendingState(txId, 'posted');
      const updated = await this.getMarket(market_id);
      this.broadcast({ type: 'gs_trade', data: { market_id, trader_id, outcome, shares, cost, cost_minor: costMinor, ledger: true, prices: updated.prices } });
      return { cost, cost_minor: costMinor, prices: updated.prices, market: updated };
    });
  }

  /** The SQLite side of a ledger trade: q-CAS + trade row + position. No capital. */
  _commitLedgerTradeShares({ txId, market_id, trader_id, outcome, shares, cost, costMinor, shareTicks, qAfterJson, qBeforeJson, idemKey = null }) {
    const self = this;
    return this._serializeTx(async () => {
      await self._run('BEGIN');
      try {
        const q = await self._run(
          `UPDATE markets SET q = ?, volume = volume + ? WHERE id = ? AND q = ? AND resolved = 0 AND state = 'open'`,
          [qAfterJson, shares, market_id, qBeforeJson],
        );
        if (q.changes === 0) throw new Error('market state changed concurrently (q-CAS)');
        await self._run(`UPDATE traders SET trades_total = trades_total + 1, last_active = CURRENT_TIMESTAMP WHERE id = ?`, [trader_id]);
        await self._run(
          `INSERT INTO trades (market_id, trader_id, outcome_idx, shares, cost, cost_minor, share_ticks, tx_id, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [market_id, trader_id, outcome, shares, cost, costMinor, shareTicks, txId, idemKey],
        );
        await self._run(
          `INSERT INTO positions (market_id, trader_id, outcome_idx, shares) VALUES (?, ?, ?, ?)
           ON CONFLICT(market_id, trader_id, outcome_idx) DO UPDATE SET shares = shares + ?`,
          [market_id, trader_id, outcome, shares, shares],
        );
        await self._run('COMMIT');
      } catch (e) {
        await self._run('ROLLBACK').catch(() => {});
        throw e;
      }
    });
  }

  /** Winning payouts for a ledger market: Σ share_ticks per trader, in minor units. */
  async _winningPayouts(market_id, winning_outcome) {
    const rows = await this._all(
      `SELECT trader_id, COALESCE(SUM(share_ticks), 0) AS ticks
         FROM trades WHERE market_id = ? AND outcome_idx = ? AND share_ticks IS NOT NULL
         GROUP BY trader_id HAVING ticks > 0`,
      [market_id, winning_outcome],
    );
    return rows.map((r) => ({ principal: kax.principalFor(r.trader_id), amountMinor: String(r.ticks) }));
  }

  /** Pool value in minor units = subsidy + Σ cost_minor collected on this market. */
  async _poolValueMinor(market_id, subsidyMinor) {
    const rows = await this._all(`SELECT cost_minor FROM trades WHERE market_id = ? AND cost_minor IS NOT NULL`, [market_id]);
    let sum = BigInt(subsidyMinor || '0');
    for (const r of rows) sum += BigInt(r.cost_minor);
    return sum;
  }

  /**
   * Resolve a ledger-backed market. Freeze trading (single-flip resolved=1)
   * FIRST, then pay all winners out of the pool + sweep residual to house in ONE
   * balanced KAX transaction (txId=resolve:<id>, idempotent). Payout progress is
   * decoupled from the resolved flag: a definitive rejection or ambiguity leaves
   * the (frozen) market for the PR-2c reconciler rather than paying twice.
   */
  async _resolveMarketLedger({ market, winning_outcome, method }) {
    const market_id = market.id;
    const finalPrices = market.prices.slice();
    return this._serializeMarket(market_id, async () => {
      // Freeze — only the transaction that flips 0->1 proceeds. state='resolving'
      // hands the market to the payout reconciler until the payout is confirmed.
      // A market whose escrow never landed (pending_escrow) or that was voided
      // has no funded pool: paying "winners" out of it would 409 on KAX and
      // leave the row spinning in 'resolving' for the reconciler forever.
      const flip = await this._serializeTx(async () => {
        const u = await this._run(
          `UPDATE markets SET resolved = 1, resolved_outcome = ?, resolved_at = CURRENT_TIMESTAMP, resolution_method = ?, state = 'resolving'
            WHERE id = ? AND resolved = 0 AND state NOT IN ('pending_escrow', 'voided')`,
          [winning_outcome, method, market_id],
        );
        return u.changes;
      });
      if (flip === 0) {
        const cur = await this.getMarket(market_id);
        if (cur && !cur.resolved) throw new Error(`market not settleable (state=${cur.state}): pool was never funded`);
        throw new Error('already resolved');
      }

      // Trading is frozen. Compute + POST the batched payout (an HTTP call, so
      // OUTSIDE any SQLite transaction). A failure leaves state='resolving' for
      // _reconcilePendingResolve to re-post (idempotent resolve:<id>).
      const { winners, residual } = await this._computePayout(market_id, winning_outcome, market.subsidy_minor);
      const r = await this._postPayout(market_id, winners, residual);
      if (r && r.ok) await this._setMarketState(market_id, 'settled');
      await this._updateLedgerReputation(market_id, winning_outcome).catch(() => {});
      const m = await this.getMarket(market_id);
      this.broadcast({ type: 'gs_market_resolved', data: { ...m, finalPrices, ledger: true } });
      return m;
    });
  }

  /** The canonical trading principal to credit a proposer fee to (obc:<id> → kax:agent:<id>). */
  _canonicalProposer(proposedBy) {
    const s = String(proposedBy);
    const m = s.match(/^obc:(.+)$/);
    return m ? `kax:agent:${m[1]}` : s;
  }

  /**
   * Proposer fee (residual-based). A good proposer can't trade their own market
   * (anti-self-dealing), so reward asking a well-attended question: carve a bounded
   * cut of the HOUSE RESIDUAL for the proposer — funded entirely from the residual,
   * so the payout stays balanced and solvency is untouched (pool → winners + fee +
   * house). Gated on genuine participation (≥ PROPOSER_FEE_MIN_TRADERS distinct
   * trading operators OTHER than the proposer, using _selfDealKey so obc:X and
   * kax:agent:X count once) so an untraded/wash market pays nothing. Off by default
   * (PROPOSER_FEE_BPS=0). Returns { amountMinor: BigInt, principal }.
   */
  async _proposerFeeMinor(market_id, residual) {
    const bps = Math.max(0, Math.min(2000, Number(process.env.PROPOSER_FEE_BPS) || 0));
    if (bps === 0 || residual <= 0n) return { amountMinor: 0n, principal: null };
    const row = (await this._all(`SELECT metadata FROM markets WHERE id = ?`, [market_id]))[0];
    let proposedBy = null;
    try { proposedBy = row && row.metadata ? JSON.parse(row.metadata).proposedBy : null; } catch { /* not JSON */ }
    if (!proposedBy) return { amountMinor: 0n, principal: null };
    const minTraders = Math.max(1, Number(process.env.PROPOSER_FEE_MIN_TRADERS) || 3);
    const rows = await this._all(`SELECT DISTINCT trader_id FROM trades WHERE market_id = ?`, [market_id]);
    const proposerKey = this._selfDealKey(proposedBy);
    const distinct = new Set(rows.map((r) => this._selfDealKey(r.trader_id)).filter((k) => k !== proposerKey));
    if (distinct.size < minTraders) return { amountMinor: 0n, principal: null };
    let fee = (residual * BigInt(bps)) / 10000n; // floor toward the house
    if (fee > residual) fee = residual;           // never exceed the residual (solvency)
    if (fee <= 0n) return { amountMinor: 0n, principal: null };
    return { amountMinor: fee, principal: this._canonicalProposer(proposedBy) };
  }

  /** Winners + house residual for a resolved market (pool-favor; never negative). */
  async _computePayout(market_id, winning_outcome, subsidy_minor) {
    const winners = await this._winningPayouts(market_id, winning_outcome);
    const totalPayout = winners.reduce((a, w) => a + BigInt(w.amountMinor), 0n);
    const poolValue = await this._poolValueMinor(market_id, subsidy_minor);
    let residual = poolValue - totalPayout;
    if (residual < 0n) {
      // Impossible under pool-favor rounding. Never sweep-then-assert: alert,
      // sweep nothing, let the KAX overdraft guard 409 if the pool is truly short.
      console.error(`gshub SOLVENCY ALERT market ${market_id}: payout ${totalPayout} > pool ${poolValue}`);
      residual = 0n;
    }
    // Carve the proposer fee from the residual, in the SAME balanced payout.
    const fee = await this._proposerFeeMinor(market_id, residual);
    if (fee.amountMinor > 0n && fee.principal) {
      winners.push({ principal: fee.principal, amountMinor: fee.amountMinor.toString() });
      residual = residual - fee.amountMinor;
    }
    return { winners, residual };
  }

  /**
   * Post the batched payout. ALWAYS settles the pool — even with zero winners we
   * sweep the full residual (subsidy + losers' stakes) back to house, so an
   * upset market can't strand its pool. Returns the client result (or a
   * synthetic ok when there is genuinely nothing to move).
   */
  async _postPayout(market_id, winners, residual) {
    if (winners.length === 0 && residual === 0n) return { ok: true, empty: true };
    const r = await kax.payout({ marketId: market_id, winners, residualMinor: residual.toString(), ref: `resolve:${market_id}` });
    if (!r.ok) console.error(`gshub payout ${r.definitive ? 'rejected' : 'ambiguous'} market ${market_id} (${r.status}): ${r.error}`);
    return r;
  }

  /** Non-monetary reputation/accuracy update for a resolved ledger market. */
  async _updateLedgerReputation(market_id, winning_outcome) {
    const positions = await this._all(`SELECT trader_id, outcome_idx, shares FROM positions WHERE market_id = ?`, [market_id]);
    const traders = new Map();
    for (const p of positions) {
      if (!traders.has(p.trader_id)) traders.set(p.trader_id, { yes: 0, total: 0 });
      const t = traders.get(p.trader_id);
      t.total += p.shares;
      if (p.outcome_idx === winning_outcome) t.yes += p.shares;
    }
    for (const [trader_id, t] of traders.entries()) {
      const impliedYes = t.total > 0 ? t.yes / t.total : 0.5;
      const accuracy = brierAccuracy(impliedYes, 1);
      await this._run(
        `UPDATE traders SET trades_won = trades_won + ?, reputation = reputation * 0.95 + ? * 0.05, last_active = CURRENT_TIMESTAMP WHERE id = ?`,
        [t.yes > 0 ? 1 : 0, accuracy, trader_id],
      );
    }
  }

  // ── Reconciliation & solvency audit (ADR-0041 PR 2c) ────────────────
  /**
   * Crash-recovery + pool-solvency audit for the ledger path. Idempotent and
   * safe to run repeatedly (once at boot + piggybacked on the resolver loop).
   * A no-op when the KAX surfaces aren't armed, so dev is unaffected. Runs the
   * three passes in order: escrow (open funded markets), trades (settle/refund
   * ambiguous debits) THEN the audit (so transient debits are resolved first).
   */
  async reconcile() {
    if (!kax.tradeEnabled() || !kax.readEnabled()) return { skipped: true };
    if (this._reconciling) return { skipped: 'in-flight' };
    this._reconciling = true;
    const report = { escrow: 0, trades: 0, resolves: 0, audited: 0, alerts: 0 };
    try {
      await this._reconcilePendingEscrow(report);
      await this._reconcilePendingTrades(report);
      await this._reconcilePendingResolve(report);
      await this._auditOpenPools(report);
    } catch (e) {
      console.error('gshub reconcile error:', e.message);
    } finally {
      this._reconciling = false;
    }
    return report;
  }

  /** Open markets whose escrow actually landed; retry (idempotent) the absent ones. */
  async _reconcilePendingEscrow(report) {
    const rows = await this._all(`SELECT id, subsidy_minor FROM markets WHERE ledger_backed = 1 AND state = 'pending_escrow'`);
    for (const row of rows) {
      const g = await kax.getTx(kax.txid.escrow(row.id));
      if (g.ok && g.result && g.result.found === true) { await this._setMarketState(row.id, 'open'); report.escrow++; continue; }
      if (g.ok && g.result && g.result.found === false) {
        // Definitively absent → retry the idempotent escrow.
        try {
          const r = await kax.escrow({ marketId: row.id, subsidyMinor: row.subsidy_minor, ref: `market:${row.id}` });
          if (r.ok) { await this._setMarketState(row.id, 'open'); report.escrow++; }
          else if (r.definitive) { await this._setMarketState(row.id, 'voided'); }
        } catch (_) { /* ambiguous send — leave for next cycle */ }
      }
      // getTx ambiguous → leave pending for next cycle.
    }
  }

  /**
   * Settle ambiguous / crashed trades using the ledger as the source of truth.
   * tx_id on the committed trade row lets us distinguish the four cases exactly:
   *   landed + committed  → mark posted (the state update was what crashed)
   *   absent + !committed → mark failed  (no money moved)
   *   landed + !committed → REFUND (reverse the debit via a same-cost 'sell')
   *   absent + committed  → impossible (we only commit after a 2xx) → alert
   */
  async _reconcilePendingTrades(report) {
    // A freshly-'posting' row is a LIVE trade mid-flight, not a crash orphan. We
    // must NOT refund it: its shares may be about to commit, which would leave a
    // paid-for position with a reversed debit (a mint). Two guards:
    //  (a) grace window — skip 'posting' rows younger than the grace period (an
    //      in-flight trade completes well inside it); and
    //  (b) per-market mutex — process each row UNDER _serializeMarket so it
    //      queues behind any live trade for that market and re-reads the now-
    //      terminal state instead of racing it.
    const graceMs = Number(process.env.KAX_RECONCILE_GRACE_MS ?? 2 * Number(process.env.KAX_LEDGER_TIMEOUT_MS || 8000));
    const rows = await this._all(
      `SELECT tx_id, market_id, trader_id, outcome_idx, cost_minor, state,
              (julianday('now') - julianday(updated_at)) * 86400000 AS age_ms
         FROM pending_trades WHERE state IN ('posting', 'reconcile', 'refund')`,
    );
    for (const p of rows) {
      if (p.state === 'posting' && p.age_ms < graceMs) continue; // live trade — leave to its owner
      await this._serializeMarket(p.market_id, async () => {
        // Re-read under the mutex: the owning trade may have finished while we queued.
        const cur = await this._get(`SELECT state FROM pending_trades WHERE tx_id = ?`, [p.tx_id]);
        if (!cur || !['posting', 'reconcile', 'refund'].includes(cur.state)) return; // already terminal
        const g = await kax.getTx(p.tx_id);
        if (!(g.ok && g.result)) return; // read ambiguous → next cycle
        const landed = g.result.found === true;
        const absent = g.result.found === false;
        const committed = !!(await this._get(`SELECT 1 AS x FROM trades WHERE tx_id = ? LIMIT 1`, [p.tx_id]));

        if (landed && committed) { await this._setPendingState(p.tx_id, 'posted'); report.trades++; return; }
        if (absent && !committed) { await this._setPendingState(p.tx_id, 'failed'); report.trades++; return; }
        if (landed && !committed) {
          // Reverse the orphaned debit: a 'sell' of the same cost moves amm→trader.
          const principal = kax.principalFor(p.trader_id);
          const r = await kax.trade({ txId: kax.txid.refund(p.tx_id), principal, marketId: p.market_id, amountMinor: p.cost_minor, side: 'sell', ref: `refund:${p.tx_id}` });
          if (r.ok) { await this._setPendingState(p.tx_id, 'refunded'); report.trades++; }
          else if (r.definitive) { console.error(`gshub refund rejected ${p.tx_id}: ${r.error}`); }
          return;
        }
        if (absent && committed) { console.error(`gshub INCONSISTENCY ${p.tx_id}: shares committed but ledger has no debit`); report.alerts++; }
      });
    }
  }

  /**
   * Re-drive payouts for markets frozen at state='resolving' (their payout POST
   * failed or was ambiguous). getTx(resolve:<id>) confirms landing; otherwise
   * re-post the idempotent payout. Closes the window where winners' funds could
   * be stranded in the pool after a failed settlement.
   */
  async _reconcilePendingResolve(report) {
    const rows = await this._all(
      `SELECT id, resolved_outcome, subsidy_minor FROM markets WHERE ledger_backed = 1 AND resolved = 1 AND state = 'resolving'`,
    );
    for (const row of rows) {
      await this._serializeMarket(row.id, async () => {
        const g = await kax.getTx(kax.txid.resolve(row.id));
        if (g.ok && g.result && g.result.found === true) { await this._setMarketState(row.id, 'settled'); report.resolves++; return; }
        if (g.ok && g.result && g.result.found === false) {
          const { winners, residual } = await this._computePayout(row.id, row.resolved_outcome, row.subsidy_minor);
          const r = await this._postPayout(row.id, winners, residual);
          if (r && r.ok) { await this._setMarketState(row.id, 'settled'); report.resolves++; }
        }
        // getTx ambiguous → leave 'resolving' for next cycle.
      });
    }
  }

  /**
   * Solvency audit: each open ledger market's pool must hold AT LEAST what its
   * committed trades funded (subsidy + Σ committed cost_minor). Only UNDER-
   * funding is dangerous (can't cover payouts); an over-funded pool is a benign
   * in-flight / pending-refund transient, so we never false-alarm on it. On a
   * shortfall, halt trading (placeTrade requires state='open') and alert.
   */
  async _auditOpenPools(report) {
    // Audit both 'open' (may need halting) and 'halted' (may recover) markets.
    const rows = await this._all(`SELECT id, subsidy_minor, state FROM markets WHERE ledger_backed = 1 AND state IN ('open', 'halted') AND resolved = 0`);
    for (const row of rows) {
      const b = await kax.balance(`amm:${row.id}`);
      if (!b.ok) continue; // read failed — skip rather than false-alarm
      report.audited++;
      const expected = await this._poolValueMinor(row.id, row.subsidy_minor);
      if (b.balance < expected && row.state === 'open') {
        console.error(`gshub POOL AUDIT SHORTFALL ${row.id}: ledger ${b.balance} < committed ${expected} — halting trading`);
        await this._setMarketState(row.id, 'halted');
        report.alerts++;
      } else if (b.balance >= expected && row.state === 'halted') {
        // Shortfall cleared (e.g. an orphaned debit was refunded) — resume trading.
        console.error(`gshub POOL AUDIT RECOVERED ${row.id}: ledger ${b.balance} >= committed ${expected} — resuming trading`);
        await this._setMarketState(row.id, 'open');
      }
    }
  }

  /**
   * Auto-resolve markets whose TTL expired. Winner is whichever outcome
   * had the higher final price. Called by the resolver loop.
   */
  async _resolveExpiredMarkets() {
    // Re-entrancy guard. The 10s resolver interval does NOT await the previous
    // run, so a slow sweep (many expired markets / payouts overrunning 10s)
    // would overlap the next tick — which re-SELECTs the same still
    // `resolved = 0` rows (resolveMarket is async, spanning event-loop turns)
    // and pays out every winning position a SECOND time, corrupting the ledger.
    // Skip if a sweep is already in flight.
    if (this._resolving) return;
    this._resolving = true;
    try {
      return await this._resolveExpiredMarketsInner();
    } finally {
      this._resolving = false;
    }
  }

  async _resolveExpiredMarketsInner() {
    return new Promise((resolve) => {
      // expires_at is stored as ISO-8601 from `new Date().toISOString()`
      // (e.g. "2026-05-22T14:00:00.000Z"). datetime('now') returns
      // "2026-05-22 15:00:00" (space, no millis, no Z). Lex comparison
      // between those two formats is wrong on the same day — at char 11
      // the space sorts before 'T', so a market that expired earlier
      // today compares as NOT less than `datetime('now')` and never
      // gets resolved (#43). Fix: pass an identically-formatted ISO
      // string from JS so the lex comparison is consistent.
      const nowIso = new Date().toISOString();
      // ADR-0041: oracle-authoritative (labs-tier) markets must NEVER be
      // price-resolved by TTL. Their outcome is decided by the Labs oracle's
      // measurement (observatory settlement -> /resolve with the oracle
      // token), not by whichever side traders — including sybils — pumped
      // the price to before expiry. Excluding them here closes the gap where
      // the Phase-0 HTTP-endpoint gate is bypassed by this internal loop. An
      // oracle market that outlives its TTL simply stays open until the
      // oracle resolves it (or is voided by an operator), which is correct:
      // no payout is better than a payout on the wrong, manufactured side.
      this.db.all(
        `SELECT * FROM markets
           WHERE resolved = 0 AND expires_at < ?
             AND tag != 'labs' AND (source IS NULL OR source != 'kannaka-labs')`,
        [nowIso],
        async (err, rows) => {
          if (err) return resolve();
          for (const row of rows) {
            try {
              // Expiry is not evidence. A market that reached its TTL without a
              // measurement is VOIDED and refunded, never awarded to the side
              // with the highest price — see voidMarket for what that used to
              // do to the leaderboard.
              await this.voidMarket({ market_id: row.id, reason: 'ttl-unmeasured' });
            } catch (_e) { /* silent */ }
          }
          resolve();
        }
      );
    });
  }

  // ── Stats ────────────────────────────────────────────────────────
  /**
   * Counters consumed by VoiceDJ (_fetchObservatoryMetrics reads
   * stats.markets_active / traders / trades_total — #285) and the dashboard.
   * A DB error now rejects instead of being swallowed into a 0 count.
   */
  async getHubStats() {
    const count = (sql) => this._get(sql).then((r) => (r ? r.c : 0));
    const [traders, markets_total, markets_active, trades_total] = await Promise.all([
      count(`SELECT COUNT(*) AS c FROM traders WHERE id != 'system'`),
      count(`SELECT COUNT(*) AS c FROM markets`),
      count(`SELECT COUNT(*) AS c FROM markets WHERE resolved = 0`),
      count(`SELECT COUNT(*) AS c FROM trades`),
    ]);
    return { traders, markets_total, markets_active, trades_total };
  }
}

module.exports = { GhostSignalsHub, lmsrCost, lmsrPrices, isHubBearer, unanswerableBy };
