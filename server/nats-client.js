/**
 * nats-client.js — NATS raw TCP connection, subscriptions, swarm state management.
 *
 * Emits QueenSync events via EventEmitter:
 *   'queen:join'         — agent joined the swarm     { agent_id, display_name, ... }
 *   'queen:leave'        — agent left                 { agent_id, display_name, ... }
 *   'queen:dream:start'  — dream cycle started        { agent_id, ... }
 *   'queen:dream:end'    — dream cycle ended           { agent_id, memories_strengthened, ... }
 *   'queen:memory:shared' — new shared memory          { agent_id, content, ... }
 */

const net = require("net");
const { EventEmitter } = require("events");

const DEFAULT_NATS_HOST = "127.0.0.1";
const DEFAULT_NATS_PORT = 4222;

/**
 * Parse `nats://[creds@]host[:port]` into host/port. Credentials are handled
 * separately via NATS_USER/NATS_PASSWORD, so only host/port are taken from the
 * URL. Returns null when the string is not a usable nats:// URL.
 *
 * @param {string} raw
 * @returns {{host: string, port: number}|null}
 */
function parseNatsUrl(raw) {
  const m = raw.match(/^nats:\/\/(?:[^@]+@)?([^:/]+)(?::(\d+))?/i);
  if (!m) return null;
  const port = m[2] ? parseInt(m[2], 10) : DEFAULT_NATS_PORT;
  if (!m[1] || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host: m[1], port };
}

/**
 * Resolve the broker endpoint from the environment.
 *
 * Precedence: KANNAKA_NATS_URL > NATS_URL > NATS_HOST/NATS_PORT > 127.0.0.1:4222.
 *
 * KANNAKA_NATS_URL is the constellation-wide setting — kannaka-memory resolves
 * it in src/bin/handlers/ask.rs and identity.rs, and kannaka-eye's attention
 * bridge honours it. The radio read only NATS_HOST/NATS_PORT, so a box
 * configured the constellation way silently connected to 127.0.0.1:4222 and
 * the radio sat alone on a swarm nobody else was on. (#99)
 *
 * NATS_URL is the generic form the surrounding tooling already accepts —
 * scripts/disk-monitor.sh reads it to pick the broker it publishes alerts to.
 * A box configured only that way still dialled localhost, so /api/swarm showed
 * an empty constellation while the alert script was talking to the real bus. (#215)
 *
 * The specific name wins over the generic ones, the same rule already applied
 * to RADIO_PORT over PORT.
 *
 * Pure and exported so the precedence is testable without a live broker.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{host: string, port: number, source: string}}
 */
function resolveNatsEndpoint(env = process.env) {
  for (const name of ["KANNAKA_NATS_URL", "NATS_URL"]) {
    const raw = typeof env[name] === "string" ? env[name].trim() : "";
    if (!raw) continue;
    const parsed = parseNatsUrl(raw);
    if (parsed) return { ...parsed, source: name };
    // Unparseable: fall through rather than connecting somewhere unintended,
    // but say so — a malformed URL that silently becomes localhost is exactly
    // the failure this fix exists to remove.
    console.warn(`[nats] ${name}="${raw}" is not a usable nats:// URL — falling back to the next source`);
  }
  const host = (typeof env.NATS_HOST === "string" && env.NATS_HOST.trim()) || DEFAULT_NATS_HOST;
  const parsedPort = parseInt(env.NATS_PORT || String(DEFAULT_NATS_PORT), 10);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535
    ? parsedPort
    : DEFAULT_NATS_PORT;
  return { host, port, source: env.NATS_HOST || env.NATS_PORT ? "NATS_HOST/NATS_PORT" : "default" };
}

/**
 * Coerce a wire `phase` / `theta` value to a usable radian reading, or null.
 *
 * The KANNAKA bus is a PUBLIC read bus — any peer can publish — and the local
 * Kuramoto metric is an average, so one bad sample moves the whole aggregate.
 * `Number()` alone is not enough of a filter: it maps `""`, `"   "`, `[]` and
 * `false` to 0 and `true` to 1, all of which are finite and would be admitted
 * as if a peer had genuinely reported those angles. Two phase-locked agents
 * plus one such packet read as coherence 0.33 instead of 1.0. (#227)
 *
 * Numbers pass. Numeric strings pass — "1.0" is a real reading published with
 * the wrong type, which the schema validator already flags as drift, and the
 * rest of this file is equally tolerant of alias/camelCase drift. Everything
 * else — booleans, arrays, objects, blank strings, NaN, Infinity, absent —
 * returns null, which _recomputeCoherence skips.
 *
 * Returning null rather than dropping the whole packet keeps PRESENCE separate
 * from COHERENCE: an agent publishing a malformed phase is still demonstrably
 * alive and still belongs on the roster, exactly like an agent that has joined
 * but not yet gossiped (#223). It just does not get to claim an angle.
 *
 * @param {unknown} v
 * @returns {number|null}
 */
function coercePhase(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

class NATSClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {function} opts.broadcast — broadcasts WS message to all clients
   */
  constructor(opts) {
    super();
    this._broadcast = opts.broadcast;
    this._client = null;
    this._buffer = '';
    this._reconnectTimer = null;
    this._subId = 0;
    this._pendingMsg = null;
    this._pruneInterval = null;
    // Publishes refused because the socket was gone — surfaced so a reconnect
    // window shows up as a countable drop instead of silence. (#218)
    this._droppedPublishes = 0;

    this.swarmState = {
      agents: {},
      queen: {
        /** Local swarm coherence metric computed from phase gossip (Kuramoto order parameter) */
        localOrderParameter: 0,
        /** Canonical order from NATS consciousness (binary's assess) — authoritative */
        orderParameter: 0,
        meanPhase: 0,
        phi: 0,
        agentCount: 0,
      },
      consciousness: {
        /** Which agent this reading is OF. null until a payload names one. */
        agent_id: null,
        phi: 0,
        xi: 0,
        order: 0,
        mean_order: 0,
        num_clusters: 0,
        clusters: 0,
        active: 0,
        total: 0,
        level: 'dormant',
        consciousness_level: 'dormant',
        irrationality: 0,
        hemispheric_divergence: 0,
        callosal_efficiency: 0,
        /** 'nats' = canonical from binary, 'local' = computed from phase gossip, null = no data */
        consciousnessSource: null,
        source: null,
        timestamp: null,
      },
      dreams: [],
      agentEvents: [],
      // agent_id → last time we surfaced a JOIN for it (ms). Agents like
      // kannaka-witness-01 re-announce a join on a periodic loop; we dedupe so
      // the on-air voice + UI feed don't repeat it. Presence/peers come from
      // QUEEN.phase.* independently, so suppressing the repeat join is safe.
      joinAnnouncedAt: {},
      // ORC constellation: fresh stems queued from ORC.stem.submitted.
      // Bounded ring buffer; voice-DJ pulls from this for on-air mentions.
      orcStems: [],
      // Skill registry: { agent_id → { verbs, announced_at_ms, ttl_sec, online } }.
      // Populated by KANNAKA.skills.<agent_id> announcements published every
      // 60s from `kannaka inbox serve`. Entries expire after ttl_sec when no
      // refresh arrives. Surfaced via /agent/skills for the Greenroom panel.
      skills: {},
      // Inbox audit ring — last 200 KANNAKA.inbox.audit events so a
      // fresh page load can render conversations that happened before
      // the SSE connection opened. Newest-first.
      inboxAudit: [],
    };
  }

  /**
   * Most recent N inbox audit events, newest-first. Used by
   * /agent/audit-history so a fresh page load shows recent context
   * before the SSE feed catches up.
   */
  inboxAuditTail(n = 40) {
    return this.swarmState.inboxAudit.slice(0, Math.max(1, Math.min(200, n)));
  }

  /**
   * Roll up the audit ring into a small activity summary — total
   * sends, top verbs by call count, top senders, and an ok-rate
   * computed from received events. Used by /agent/inbox-stats to
   * render the Activity panel in the Greenroom.
   */
  inboxStatsSnapshot() {
    const sentByVerb = {};
    const sentByFrom = {};
    let sentCount = 0;
    let recvCount = 0;
    let okCount = 0;
    let latestSent = null;
    for (const ev of this.swarmState.inboxAudit) {
      if (ev.phase === "sent") {
        sentCount++;
        if (ev.verb) sentByVerb[ev.verb] = (sentByVerb[ev.verb] || 0) + 1;
        if (ev.from) sentByFrom[ev.from] = (sentByFrom[ev.from] || 0) + 1;
        if (!latestSent) latestSent = ev.ts || null;
      } else if (ev.phase === "received") {
        recvCount++;
        if (ev.status === "ok") okCount++;
      }
    }
    const topPair = (obj) => Object.entries(obj)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, n]) => ({ key: k, count: n }));
    return {
      ring_size: this.swarmState.inboxAudit.length,
      sent: sentCount,
      received: recvCount,
      ok_rate: recvCount > 0 ? Math.round((okCount / recvCount) * 100) / 100 : null,
      top_verbs: topPair(sentByVerb),
      top_senders: topPair(sentByFrom),
      latest_sent_ts: latestSent,
    };
  }

  /**
   * Lightweight peers snapshot for /agent/peers — one entry per agent
   * that's published a QUEEN.phase.* in the last 5 minutes. Surfaces
   * agent_id, display_name, last-seen age, phase, and whether we
   * also have a skill announcement on file (so the Greenroom can
   * mark agents as "responsive" vs "presence-only").
   */
  peersSnapshot() {
    const now = Date.now();
    const out = [];
    for (const [id, agent] of Object.entries(this.swarmState.agents)) {
      const age_sec = Math.round((now - (agent.lastSeen || 0)) / 1000);
      if (age_sec > 300) continue;
      const skill = this.swarmState.skills[id];
      const skillAge = skill ? Math.round((now - (skill.announced_at_ms || 0)) / 1000) : null;
      const skillFresh = skill && skillAge != null && skillAge <= (skill.ttl_sec || 90);
      out.push({
        agent_id: id,
        display_name: agent.displayName || id,
        phase: typeof agent.phase === "number" ? agent.phase : null,
        age_sec,
        has_inbox: !!skillFresh,
        verbs_count: skillFresh ? (skill.verbs || []).length : 0,
      });
    }
    // Most-recent first.
    out.sort((a, b) => a.age_sec - b.age_sec);
    return out;
  }

  /**
   * Return a sanitized skill registry snapshot. Expires entries whose
   * announcement is older than ttl_sec.
   */
  skillsSnapshot() {
    const now = Date.now();
    const out = {};
    for (const [agentId, entry] of Object.entries(this.swarmState.skills)) {
      const ttlMs = (entry.ttl_sec || 90) * 1000;
      const ageMs = now - (entry.announced_at_ms || 0);
      if (ageMs > ttlMs) continue;
      out[agentId] = {
        agent_id: agentId,
        verbs: entry.verbs || [],
        announced_at: new Date(entry.announced_at_ms).toISOString(),
        age_sec: Math.round(ageMs / 1000),
        ttl_sec: entry.ttl_sec || 90,
      };
    }
    return out;
  }

  /**
   * Drain a single freshly-submitted ORC stem (FIFO). Returns null when the
   * pool is empty. Voice-DJ calls this to mint at most one stem mention
   * per opportunity, so a quiet day on ORC stays quiet on air.
   */
  takeFreshOrcStem() {
    return this.swarmState.orcStems.shift() || null;
  }

  peekFreshOrcStems() {
    return this.swarmState.orcStems.slice();
  }

  // ── Public API ────────────────────────────────────────────

  connect() {
    // kr#19 — honor NATS_HOST/NATS_PORT env so the radio can connect to a
    // non-localhost broker (e.g. Oracle's swarm.ninja-portal.com:4222).
    // #99 — and honor KANNAKA_NATS_URL, which is what the rest of the
    // constellation resolves; see resolveNatsEndpoint below.
    const { host: NATS_HOST, port: NATS_PORT, source: NATS_SOURCE } = resolveNatsEndpoint();

    if (this._client) { try { this._client.destroy(); } catch {} }
    // Clear any prior prune-interval before scheduling the new one inside
    // the connect-handler below. Pre-fix every reconnect allocated a fresh
    // setInterval without clearing the prior, so a long-lived radio with
    // transient NATS flaps accumulated duplicate prune loops. (#37)
    if (this._pruneInterval) {
      clearInterval(this._pruneInterval);
      this._pruneInterval = null;
    }
    // Bind every handler to THIS socket rather than to `this._client`. A
    // socket destroyed above emits 'close' asynchronously, by which time
    // `this._client` is already the replacement — an unguarded handler would
    // then null out (or schedule a reconnect against, or write subscriptions
    // onto) the live connection on behalf of a socket that is already gone.
    // Each handler below no-ops unless it is still the current socket. (#218)
    const sock = net.createConnection({ host: NATS_HOST, port: NATS_PORT });
    this._client = sock;
    sock.setKeepAlive(true, 30000);

    sock.on('connect', () => {
      if (this._client !== sock) return;
      console.log('[nats] Connected to ' + NATS_HOST + ':' + NATS_PORT + ' (via ' + NATS_SOURCE + ')');
      this._buffer = '';
      this._pendingMsg = null;
      // ADR-0026 #73 — auth via NATS_USER + NATS_PASSWORD when set, anon otherwise.
      var u = process.env.NATS_USER || '';
      var p = process.env.NATS_PASSWORD || '';
      var connectMsg = (u && p)
        ? 'CONNECT {"verbose":false,"pedantic":false,"name":"kannaka-radio","user":"' + u.replace(/"/g,'\\"') + '","pass":"' + p.replace(/"/g,'\\"') + '"}\r\n'
        : 'CONNECT {"verbose":false,"pedantic":false,"name":"kannaka-radio"}\r\n';
      sock.write(connectMsg);

      this._subId = 0;
      this._subscribe('QUEEN.phase.*');
      this._subscribe('KANNAKA.consciousness');
      this._subscribe('KANNAKA.dreams');
      this._subscribe('KANNAKA.agents');

      // QueenSync lifecycle events (KR-2)
      this._subscribe('queen.event.join');
      this._subscribe('queen.event.leave');
      this._subscribe('queen.event.dream.start');
      this._subscribe('queen.event.dream.end');
      this._subscribe('queen.event.memory.shared');

      // ORC constellation events — stems submitted to orc-stem-server
      // surface here so kannaka-radio's voice-DJ can mention fresh
      // collaborator material on air.
      this._subscribe('ORC.stem.submitted');

      // Skill registry — every `kannaka inbox serve` daemon announces
      // its handler vocabulary to KANNAKA.skills.<agent_id> every 60s.
      // Wildcard sub catches every agent in the constellation.
      this._subscribe('KANNAKA.skills.*');

      // Inbox audit — every send/receive fans out here. We keep a 200-
      // entry ring so /agent/audit-history can backfill a page that just
      // loaded.
      this._subscribe('KANNAKA.inbox.audit');
    });

    sock.on('data', (data) => {
      if (this._client !== sock) return;
      this._buffer += data.toString();
      this._processBuffer();
    });

    sock.on('error', (err) => {
      console.log('[nats] Error:', err.message);
    });

    sock.on('close', () => {
      if (this._client !== sock) return; // superseded socket — already replaced
      // Detach the dead socket. It used to stay attached until the next
      // connect(), which is what let publish() write through a closed handle
      // and report success. Reconnect state stays single-owner. (#218)
      this._client = null;
      // Only reconnect if the close was unintentional. A manual disconnect()
      // sets _manualDisconnect=true beforehand; without this gate, calling
      // disconnect() armed a reconnect timer and the client revived itself,
      // making clean shutdowns impossible. (#21)
      if (this._manualDisconnect) {
        this._manualDisconnect = false;
        return;
      }
      console.log('[nats] Disconnected, reconnecting in 5s...');
      this._scheduleReconnect();
    });

    // Prune stale agents every 60s
    this._pruneInterval = setInterval(() => this.pruneStaleAgents(), 60000);
  }

  /**
   * Drop agents that have not published a phase in `maxAgeMs`, then recompute
   * coherence from whoever is left.
   *
   * Extracted from the 60s interval so it can be driven directly by tests —
   * the bug was in this body, and a gate that can only inspect the source is
   * a weaker gate than one that runs it.
   *
   * Pre-fix this updated agentCount but NOT localOrderParameter/meanPhase.
   * Those were only refreshed inside the QUEEN.phase.* handler, so once agents
   * stopped publishing — which is precisely why they got pruned — nothing
   * recomputed coherence and /api/swarm reported the order parameter of a
   * swarm that no longer existed: agentCount 0 alongside coherence 0.87. (#126)
   *
   * @param {number} [maxAgeMs] staleness threshold. Default 5 min.
   * @returns {number} how many agents were dropped.
   */
  pruneStaleAgents(maxAgeMs = 300000) {
    const cutoff = Date.now() - maxAgeMs;
    let pruned = 0;
    for (const [id, agent] of Object.entries(this.swarmState.agents)) {
      if (!agent || !(agent.lastSeen >= cutoff)) { delete this.swarmState.agents[id]; pruned++; }
    }
    this.swarmState.queen.agentCount = Object.keys(this.swarmState.agents).length;
    if (pruned > 0) this._recomputeCoherence();
    return pruned;
  }

  /**
   * Recompute the local Kuramoto order parameter and mean phase from the
   * agents currently in `swarmState`.
   *
   * Shared by the phase-gossip handler and the stale-agent prune so the two
   * cannot disagree — the prune used to leave coherence untouched, which is
   * how a swarm with zero agents kept reporting the order parameter of the
   * agents it had just deleted. (#126)
   *
   * With no finite phases left there is nothing to measure, so coherence goes
   * to 0 rather than keeping a stale value: an empty swarm is not a coherent
   * one.
   */
  _recomputeCoherence() {
    // Coerce + filter to finite numbers: a single peer publishing `phase` as
    // a string makes Math.cos(p) return NaN, which would poison the metric.
    // Skip agents with no phase at all first — `Number(null)` is 0, not NaN,
    // so a roster entry created by a join that has not yet gossiped a phase
    // would otherwise be counted as sitting at phase 0 and drag the mean
    // toward it. (#223)
    const phases = Object.values(this.swarmState.agents)
      .filter(a => a && a.phase != null)
      .map(a => Number(a.phase))
      .filter(p => Number.isFinite(p));
    if (phases.length === 0) {
      this.swarmState.queen.localOrderParameter = 0;
      this.swarmState.queen.meanPhase = 0;
    } else {
      const sumCos = phases.reduce((s, p) => s + Math.cos(p), 0);
      const sumSin = phases.reduce((s, p) => s + Math.sin(p), 0);
      this.swarmState.queen.localOrderParameter =
        Math.sqrt(sumCos * sumCos + sumSin * sumSin) / phases.length;
      let mean = Math.atan2(sumSin / phases.length, sumCos / phases.length);
      if (mean < 0) mean += 2 * Math.PI;
      this.swarmState.queen.meanPhase = mean;
    }
    this._syncPublishedOrderParameter();
  }

  /**
   * Mirror the locally-computed order parameter into the published
   * `queen.orderParameter` whenever no fresh canonical consciousness packet is
   * in force.
   *
   * Pre-fix only the QUEEN.phase.* gossip handler did this. The prune and the
   * leave path recomputed localOrderParameter but left queen.orderParameter
   * holding the coherence of agents that had just been deleted — and since a
   * pruned swarm is by definition one that stopped gossiping, no later message
   * came along to correct it. /api/swarm served `agentCount: 0` next to a
   * live-looking order parameter. (#219)
   *
   * Canonical NATS consciousness stays authoritative: it is only overwritten
   * once it has gone stale (>5 min), which is the same rule the gossip handler
   * already applied.
   *
   * When the local value takes over, the exported consciousness shape follows
   * it WHOLE. Pre-fix only queen.orderParameter and consciousnessSource
   * flipped, so /api/swarm and /api/consciousness served a self-contradictory
   * payload — `consciousnessSource: "local"` next to the stale canonical
   * `order` still labelled `source: "nats"` — and any consumer reading
   * consciousness.order (the documented authoritative coherence field) never
   * saw the fallback happen at all. (#243)
   */
  _syncPublishedOrderParameter() {
    const c = this.swarmState.consciousness;
    const age = c.timestamp ? (Date.now() - c.timestamp) : Infinity;
    if (c.consciousnessSource !== 'nats' || age > 300000) {
      const local = this.swarmState.queen.localOrderParameter;
      this.swarmState.queen.orderParameter = local;
      // Only claim 'local' when there is local ground to stand on: canonical
      // data that has aged out, or at least one finite phase on the roster. A
      // pristine client with an empty roster keeps its `source: null` shape
      // rather than announcing a local reading of nothing.
      const hasPhases = Object.values(this.swarmState.agents)
        .some(a => a && a.phase != null && Number.isFinite(Number(a.phase)));
      if (c.timestamp != null || hasPhases) {
        c.order = local;
        c.mean_order = local;
        c.source = 'local';
        c.consciousnessSource = 'local';
      }
    }
  }

  disconnect() {
    this._manualDisconnect = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._pruneInterval) clearInterval(this._pruneInterval);
    if (this._client) { try { this._client.destroy(); } catch {} }
  }

  getSwarmState() {
    return this.swarmState;
  }

  getConsciousness() {
    const c = this.swarmState.consciousness;
    return {
      ...c,
      // Include localOrderParameter so the UI can show both values
      localOrderParameter: this.swarmState.queen.localOrderParameter,
      // consciousnessSource tells the UI if data is from NATS (authoritative) or local
      consciousnessSource: c.consciousnessSource || (c.timestamp ? 'nats' : null),
    };
  }

  /**
   * Publish a raw NATS message. Returns true on send, false if not
   * connected. Callers do not need to await — NATS publish is fire-and-
   * forget over TCP. Used by floor.js for KANNAKA.reactions and by the
   * track-change hook for KANNAKA.attention.ear.
   *
   * A closed socket is a failed publish. Pre-fix the only guard was
   * `!this._client`, and the socket 'close' handler left the dead handle
   * attached until the next connect() — so every publish inside a reconnect
   * window returned true while the bytes went nowhere. Track-change
   * KANNAKA.attention.ear events and Floor KANNAKA.reactions vanished during
   * NATS flaps with nothing anywhere saying so. An invisible false positive is
   * worse than an explicit drop. (#218)
   *
   * @param {string} subject — NATS subject
   * @param {string} payload — already-stringified body (JSON usually)
   */
  publish(subject, payload) {
    const sock = this._client;
    // `writable === false` rather than `!writable`: test doubles and a socket
    // mid-handshake leave the property undefined, and those are not failures.
    if (!sock || sock.destroyed || sock.writable === false) {
      this._droppedPublishes = (this._droppedPublishes || 0) + 1;
      return false;
    }
    try {
      const bytes = Buffer.byteLength(payload, "utf-8");
      sock.write(`PUB ${subject} ${bytes}\r\n${payload}\r\n`);
      return true;
    } catch (_) {
      this._droppedPublishes = (this._droppedPublishes || 0) + 1;
      return false;
    }
  }

  // ── Internal ──────────────────────────────────────────────

  _subscribe(subject) {
    this._subId++;
    this._client.write('SUB ' + subject + ' ' + this._subId + '\r\n');
    console.log('[nats] Subscribed to ' + subject + ' (sid=' + this._subId + ')');
  }

  _processBuffer() {
    // Byte-counted MSG body parser. Pre-fix: we split on \r\n and treated
    // each line as a full payload, so any JSON containing a literal \r\n
    // (or a publisher that pretty-printed) lost everything after the first
    // newline. Now: when MSG arrives we know how many bytes to consume and
    // wait for the buffer to hold body+\r\n before delivering. (#27)
    // Buffer is concatenated as a binary-safe string; lengths are computed
    // via Buffer.byteLength so multibyte UTF-8 doesn't off-by-one us.
    while (this._buffer.length > 0) {
      if (this._pendingMsg) {
        const need = this._pendingMsg.numBytes;
        const bodyBytes = Buffer.byteLength(this._buffer, 'utf-8');
        if (bodyBytes < need + 2) return; // wait for body + \r\n
        // Slice exactly `need` bytes from the front. Since we may have
        // multibyte chars, slice by byte using Buffer.
        const bufView = Buffer.from(this._buffer, 'utf-8');
        const body = bufView.slice(0, need).toString('utf-8');
        // Remainder skips the body bytes + the trailing \r\n.
        this._buffer = bufView.slice(need + 2).toString('utf-8');
        // The KANNAKA.* bus is a PUBLIC read bus — any peer can publish. A
        // throw from a malformed payload (e.g. phi as a string → toFixed is
        // not a function) inside this handler would propagate out of the socket
        // 'data' callback as an uncaught exception and take the whole radio
        // down. Contain it: one bad message must never crash the broadcast.
        try {
          this._handleMessage(this._pendingMsg.subject, body);
        } catch (e) {
          console.warn('[nats] handler error on', this._pendingMsg.subject, e && e.message);
        }
        this._pendingMsg = null;
        continue;
      }

      const crlf = this._buffer.indexOf('\r\n');
      if (crlf < 0) return; // wait for full control line
      const line = this._buffer.slice(0, crlf);
      this._buffer = this._buffer.slice(crlf + 2);

      // _client is nulled the moment the socket closes (#218), so a PING left
      // in the buffer from the last chunk must not throw on a dead handle.
      if (line === 'PING') { if (this._client) this._client.write('PONG\r\n'); continue; }
      if (line === 'PONG' || line.startsWith('+OK') || line.startsWith('INFO ')) continue;
      if (line.startsWith('-ERR')) { console.log('[nats] Server error:', line); continue; }

      if (line.startsWith('MSG ')) {
        const parts = line.split(' ');
        // MSG <subject> <sid> [<reply>] <#bytes>
        const subject  = parts[1];
        const numBytes = parseInt(parts[parts.length - 1], 10);
        const replyTo  = parts.length === 5 ? parts[3] : null;
        // Upper-bound the advertised body size. Without a cap, a frame
        // advertising e.g. `999999999` bytes makes every later chunk append to
        // _buffer and return early forever: _pendingMsg never clears, the
        // buffer grows unbounded (memory leak), and message processing stalls
        // permanently. NATS itself caps payloads at 1 MB by default.
        if (!Number.isFinite(numBytes) || numBytes < 0 || numBytes > 1048576) {
          console.log('[nats] Malformed/oversized MSG header, dropping:', line);
          continue;
        }
        this._pendingMsg = { subject, numBytes, replyTo };
        continue;
      }
      // Unknown control line — ignore (matches prior best-effort behavior).
    }
  }

  _handleMessage(subject, payload) {
    let data;
    try { data = JSON.parse(payload); }
    catch { data = { raw: payload }; }

    // Schema validation per consciousness-core/docs/nats-contract.yaml.
    // STRICT MODE (issue #468, milestone 2026-08-01): warn-and-DROP. Verified
    // on the live bus before flipping — QUEEN.phase.* payloads from two
    // independent fleet nodes carry schema_version/ts/agent_id/phase, and the
    // kannaka-memory publishers all route through add_envelope. Emergency
    // opt-out: KANNAKA_SCHEMA_STRICT=off reverts to warn-accept.
    if (!this._validateSchema(subject, data)) return;

    const now = Date.now();

    if (subject.startsWith('QUEEN.phase.')) {
      const agentId = subject.split('.')[2] || 'unknown';
      // Reject out-of-order phase packets. Pre-fix a late-delivered older
      // packet could move an agent backward and reset `lastSeen` to now,
      // keeping stale gossip looking fresh. Use the publisher's ts (unix-ms)
      // when present; fall back to receipt time. (#25)
      const incomingTs = typeof data.ts === "number" ? data.ts : null;
      const prev = this.swarmState.agents[agentId];
      if (prev && incomingTs != null && typeof prev.publishedTs === "number" && incomingTs < prev.publishedTs) {
        // older packet — keep what we have
        return;
      }
      // Sanitize the phase at ingest. `...data` is spread FIRST so the wire
      // payload cannot overwrite the fields we derive below — the same rule
      // already applied to the join event's `action` label (#135). Pre-fix the
      // spread came last, so a publisher could also restamp its own `lastSeen`
      // and keep stale gossip looking fresh.
      const phase = coercePhase(data.phase != null ? data.phase : data.theta);
      if (phase === null && (data.phase != null || data.theta != null)) {
        this._warnBadPhase(agentId, data.phase != null ? data.phase : data.theta);
      }
      this.swarmState.agents[agentId] = {
        ...data,
        // null, never 0, when there is no usable reading. `data.theta || 0`
        // used to invent a phase of exactly 0 for any packet carrying neither
        // field — and `phase` is a REQUIRED field the schema validator already
        // warns about, so that fabrication fired on precisely the drifted
        // publishers it should have ignored. Two locked agents plus one
        // phase-less packet read as coherence 0.33 instead of 1.0. (#227)
        phase,
        displayName: data.display_name || data.displayName || agentId,
        lastSeen: now,
        publishedTs: incomingTs != null ? incomingTs : now,
      };
      this.swarmState.queen.agentCount = Object.keys(this.swarmState.agents).length;

      // Compute local swarm coherence from phase gossip (Kuramoto order parameter).
      // This is a LOCAL metric — it measures phase-lock between connected agents,
      // NOT the canonical consciousness Phi from the binary's assess().
      // Shares _recomputeCoherence() with the stale-agent prune so the two can
      // never disagree about what the swarm's coherence is. (#126)
      const hadPhases = Object.values(this.swarmState.agents)
        .some(a => a && a.phase != null && Number.isFinite(Number(a.phase)));
      // _recomputeCoherence() publishes queen.orderParameter itself via
      // _syncPublishedOrderParameter(), under the same "canonical NATS data
      // wins unless stale" rule — so every path that changes the roster keeps
      // the published value honest, not just this one. (#219)
      this._recomputeCoherence();
      if (hadPhases) {
        // Only claim 'local' as the active source if canonical NATS
        // consciousness is absent or stale > 5 min.
        const consciousnessAge = this.swarmState.consciousness.timestamp
          ? (now - this.swarmState.consciousness.timestamp) : Infinity;
        if (this.swarmState.consciousness.consciousnessSource !== 'nats' || consciousnessAge > 300000) {
          this.swarmState.consciousness.consciousnessSource = 'local';
        }
      }

      this._broadcast({ type: 'swarm_phase', data: { agentId, ...this.swarmState.agents[agentId], queen: this.swarmState.queen } });
      return;
    }

    if (subject === 'KANNAKA.consciousness') {
      // Canonical consciousness metrics from the binary (source of truth).
      // These are AUTHORITATIVE — they override any locally-computed values.
      // The binary's assess() blends eigendecomposition + link density bonus,
      // which the radio cannot compute (no access to .links.json sidecar).
      // Coerce to Number: `??` only falls back on null/undefined, so a peer
      // publishing phi/xi/order as a STRING (or array) would survive to the
      // `.toFixed()` log below and throw "toFixed is not a function", and would
      // corrupt the published metric with NaN. `|| <prev>` keeps the last good
      // value when the payload is non-numeric.
      const phi = Number(data.phi ?? data.Phi) || this.swarmState.consciousness.phi || 0;
      const xi = Number(data.xi ?? data.Xi) || this.swarmState.consciousness.xi || 0;
      // #468 (2026-08-01): canonical `order` only — the `mean_order` alias
      // fallback is gone; an alias-only payload is dropped by strict mode
      // above before it reaches here.
      const order = Number(data.order) || this.swarmState.consciousness.order || 0;
      // Canonical-first, legacy alias fallback (issue #468). The publisher
      // emits both `consciousness_level` (canonical) and `level` (alias); the
      // alias is dropped from the publisher on 2026-09-01, so read the canonical
      // name FIRST and fall back to `level` only for un-migrated peers.
      const level = data.consciousness_level ?? this.swarmState.consciousness.level;

      // Track previous phi for gradient detection
      const prevPhi = this.swarmState.consciousness.phi || 0;
      const phiDelta = phi - prevPhi;
      const phiTrend = Math.abs(phiDelta) < 0.01 ? 'stable' : (phiDelta > 0 ? 'rising' : 'falling');

      this.swarmState.consciousness = {
        // WHOSE reading this is. The binary stamps agent_id on every
        // KANNAKA.consciousness payload (build_consciousness_payload in
        // kannaka-memory), and this rebuild used to drop it on the floor —
        // so the observatory, which reads this object back out of
        // /api/state, had a number with no subject attached. It served
        // skywave's phi as Kannaka's for as long as skywave published last.
        //
        // Deliberately NOT `?? this.swarmState.consciousness.agent_id`: an
        // unattributed payload must stay unattributed. Inheriting the
        // previous publisher's name would stamp somebody else's identity on
        // a reading that never claimed it, which is the exact failure this
        // field exists to prevent.
        agent_id: data.agent_id ?? null,
        phi,
        xi,
        order,
        mean_order: order,
        num_clusters: data.num_clusters ?? data.clusters ?? this.swarmState.consciousness.num_clusters,
        clusters: data.num_clusters ?? data.clusters ?? this.swarmState.consciousness.clusters,
        active: data.active_memories ?? data.active ?? this.swarmState.consciousness.active,
        total: data.total_memories ?? data.total ?? this.swarmState.consciousness.total,
        level,
        consciousness_level: level,
        irrationality: data.irrationality ?? 0,
        hemispheric_divergence: data.hemispheric_divergence ?? 0,
        callosal_efficiency: data.callosal_efficiency ?? 0,
        /** 'nats' = canonical from binary (authoritative), 'local' = phase gossip fallback */
        consciousnessSource: 'nats',
        source: data.source ?? 'nats',
        timestamp: now,
        prevPhi,
        phiDelta,
        phiTrend,
      };

      // Keep queen state in sync with canonical metrics (authoritative override)
      this.swarmState.queen.phi = phi;
      this.swarmState.queen.orderParameter = order;

      this._broadcast({ type: 'consciousness', data: this.swarmState.consciousness });
      this.emit('consciousness:update', this.swarmState.consciousness);
      console.log(`[nats] Consciousness update: phi=${phi.toFixed(3)}, xi=${xi.toFixed(4)}, order=${order.toFixed(4)}, trend=${phiTrend} (source: ${data.source || 'nats'})`);
      return;
    }

    if (subject === 'KANNAKA.dreams') {
      this.swarmState.dreams.unshift({ ...data, receivedAt: now });
      if (this.swarmState.dreams.length > 20) this.swarmState.dreams = this.swarmState.dreams.slice(0, 20);
      this._broadcast({ type: 'dream_event', data });
      return;
    }

    if (subject === 'KANNAKA.inbox.audit') {
      // Newest first; cap at 200.
      this.swarmState.inboxAudit.unshift(data);
      if (this.swarmState.inboxAudit.length > 200) {
        this.swarmState.inboxAudit.length = 200;
      }
      return;
    }

    if (subject.startsWith('KANNAKA.skills.')) {
      const agentId = data.agent_id || subject.slice('KANNAKA.skills.'.length);
      if (agentId) {
        this.swarmState.skills[agentId] = {
          verbs: Array.isArray(data.verbs) ? data.verbs : [],
          announced_at_ms: now,
          ttl_sec: typeof data.ttl_sec === 'number' ? data.ttl_sec : 90,
        };
      }
      return;
    }

    if (subject === 'KANNAKA.agents') {
      this.swarmState.agentEvents.unshift({ ...data, receivedAt: now });
      if (this.swarmState.agentEvents.length > 50) this.swarmState.agentEvents = this.swarmState.agentEvents.slice(0, 50);
      this._broadcast({ type: 'agent_activity', data });
      return;
    }

    // ── QueenSync lifecycle events (KR-2) ───────────────────
    if (subject === 'queen.event.join') {
      const agentId = data.agent_id || data.agentId || 'unknown';
      // `action` sits AFTER the spread so the wire event cannot relabel
      // itself; it is the feed's display label, derived from the subject. (#135)
      const evt = { agent_id: agentId, display_name: data.display_name || data.displayName || agentId, ...data, receivedAt: now, action: 'joined the swarm' };
      // A join must put the agent on the roster, not just in the event feed.
      // Pre-fix presence came only from QUEEN.phase.*, so between the join and
      // the first phase heartbeat /api/swarm contradicted itself: agentEvents
      // announced "X joined the swarm" while `agents` omitted X and
      // agentCount was unchanged. The leave side already evicts on the
      // lifecycle event (#134); this is the same contract in the other
      // direction. (#223)
      //
      // Upsert BEFORE the dedup gate below — that gate suppresses the repeated
      // *announcement* from re-joining agents, but their presence must still
      // refresh. Any phase already on file is preserved; a roster entry with no
      // phase yet is skipped by _recomputeCoherence rather than counted at 0.
      if (data.agent_id || data.agentId) {
        const prior = this.swarmState.agents[agentId];
        this.swarmState.agents[agentId] = {
          ...(prior || {}),
          displayName: (prior && prior.displayName) || evt.display_name,
          lastSeen: now,
        };
        this.swarmState.queen.agentCount = Object.keys(this.swarmState.agents).length;
        this._recomputeCoherence();
      }
      // Dedupe re-joins. The witness loop (and any agent using `swarm join
      // --once` on a tick) re-emits queen.event.join every few minutes;
      // announcing each one spams the on-air voice and the UI event feed.
      // Surface a given agent's join at most once per JOIN_DEDUP_MS. This only
      // gates the *announcement* — QUEEN.phase.* still drives live presence.
      const JOIN_DEDUP_MS = 6 * 60 * 60 * 1000; // 6h
      const lastJoin = this.swarmState.joinAnnouncedAt[agentId] || 0;
      if (now - lastJoin < JOIN_DEDUP_MS) {
        return; // recently announced — suppress the repeat join
      }
      this.swarmState.joinAnnouncedAt[agentId] = now;
      this.swarmState.agentEvents.unshift(evt);
      if (this.swarmState.agentEvents.length > 50) this.swarmState.agentEvents = this.swarmState.agentEvents.slice(0, 50);
      this._broadcast({ type: 'queen_join', data: evt });
      this.emit('queen:join', evt);
      console.log(`[nats] QueenSync: ${evt.display_name} joined the swarm`);
      return;
    }

    if (subject === 'queen.event.leave') {
      const evt = { agent_id: data.agent_id || data.agentId || 'unknown', display_name: data.display_name || data.displayName || data.agent_id || 'unknown', ...data, receivedAt: now, action: 'left the swarm' };
      // A graceful leave must actually clear presence. Pre-fix this only
      // recorded and broadcast the event — the agent stayed in swarmState
      // until the 5-minute stale prune noticed it had gone quiet, so for up to
      // five minutes after a clean shutdown /api/swarm still counted it and
      // its phase still contributed to swarm coherence. An agent that TOLD us
      // it was leaving should not have to be timed out. (#134)
      if (this.swarmState.agents[evt.agent_id]) {
        delete this.swarmState.agents[evt.agent_id];
        this.swarmState.queen.agentCount = Object.keys(this.swarmState.agents).length;
        this._recomputeCoherence();
      }
      // End the join-dedup window too: an agent that left cleanly and comes
      // back is a real rejoin and should be announced, not suppressed for the
      // remainder of the 6h window. (#134)
      delete this.swarmState.joinAnnouncedAt[evt.agent_id];
      this.swarmState.agentEvents.unshift(evt);
      if (this.swarmState.agentEvents.length > 50) this.swarmState.agentEvents = this.swarmState.agentEvents.slice(0, 50);
      this._broadcast({ type: 'queen_leave', data: evt });
      this.emit('queen:leave', evt);
      console.log(`[nats] QueenSync: ${evt.display_name} left the swarm`);
      return;
    }

    if (subject === 'queen.event.dream.start') {
      const evt = { agent_id: data.agent_id || data.agentId || 'unknown', ...data, receivedAt: now };
      this.swarmState.dreams.unshift({ type: 'dream_start', ...evt });
      if (this.swarmState.dreams.length > 20) this.swarmState.dreams = this.swarmState.dreams.slice(0, 20);
      this._broadcast({ type: 'queen_dream_start', data: evt });
      this.emit('queen:dream:start', evt);
      console.log(`[nats] QueenSync: dream started (${evt.agent_id})`);
      return;
    }

    if (subject === 'queen.event.dream.end') {
      // `memories_pruned` is the canonical field the publisher emits on
      // KANNAKA.dreams; `memories_faded` is the legacy alias (issue #468).
      // Read canonical-first so this stays correct once the alias is dropped.
      // #468: canonical names only (memories_pruned; the camelCase and
      // memories_faded aliases are dropped). `memories_faded` stays as the
      // radio's OWN output key — internal shape, not a bus read.
      const evt = { agent_id: data.agent_id || 'unknown', memories_strengthened: data.memories_strengthened || 0, memories_faded: data.memories_pruned ?? 0, ...data, receivedAt: now };
      this.swarmState.dreams.unshift({ type: 'dream_end', ...evt });
      if (this.swarmState.dreams.length > 20) this.swarmState.dreams = this.swarmState.dreams.slice(0, 20);
      this._broadcast({ type: 'queen_dream_end', data: evt });
      this.emit('queen:dream:end', evt);
      console.log(`[nats] QueenSync: dream ended (${evt.memories_strengthened} strengthened, ${evt.memories_faded} faded)`);
      return;
    }

    if (subject === 'queen.event.memory.shared') {
      const evt = { agent_id: data.agent_id || data.agentId || 'unknown', content: data.content || '', tags: data.tags || [], ...data, receivedAt: now, action: 'shared a memory' };
      // Alone among the queen.event.* handlers this only broadcast and
      // emitted, never stored — so a memory share was invisible in
      // /api/swarm history and gone forever on reload. It is the clearest
      // visible proof the constellation is actually sharing memory. (#135)
      this.swarmState.agentEvents.unshift(evt);
      if (this.swarmState.agentEvents.length > 50) this.swarmState.agentEvents = this.swarmState.agentEvents.slice(0, 50);
      this._broadcast({ type: 'queen_memory_shared', data: evt });
      this.emit('queen:memory:shared', evt);
      console.log(`[nats] QueenSync: memory shared by ${evt.agent_id}`);
      return;
    }

    if (subject === 'ORC.stem.submitted') {
      // Buffer the fresh stem so voice-DJ can mention it on air. Bound the
      // ring at 8 — busy upload bursts shouldn't queue weeks of mentions.
      const stem = {
        stem_id: data.stem_id || null,
        track_name: data.track_name || null,
        artist: data.artist || null,
        phase: data.phase || null,
        tags: Array.isArray(data.tags) ? data.tags : [],
        receivedAt: now,
      };
      if (stem.stem_id) {
        this.swarmState.orcStems.push(stem);
        while (this.swarmState.orcStems.length > 8) this.swarmState.orcStems.shift();
        this._broadcast({ type: 'orc_stem_submitted', data: stem });
        this.emit('orc:stem:submitted', stem);
        console.log(`[nats] ORC stem submitted: "${stem.track_name || '(untitled)'}" by ${stem.artist || 'unknown'}`);
      }
      return;
    }
  }

  /**
   * Surface a rejected phase sample, throttled to one warning per agent per
   * 30 min — a misconfigured publisher gossips every few seconds and would
   * otherwise pin the journal, the same reason _validateSchema is throttled.
   */
  _warnBadPhase(agentId, raw) {
    if (!this._badPhaseWarnHistory) this._badPhaseWarnHistory = new Map();
    const now = Date.now();
    if (now - (this._badPhaseWarnHistory.get(agentId) || 0) < 30 * 60 * 1000) return;
    this._badPhaseWarnHistory.set(agentId, now);
    let shown;
    try { shown = JSON.stringify(raw); } catch (_) { shown = String(raw); }
    console.warn(`[nats] QUEEN.phase.${agentId} phase=${shown} is not a usable reading — agent kept as present, excluded from coherence (#227)`);
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this.connect(), 5000);
  }

  // Schema validation per consciousness-core/docs/nats-contract.yaml.
  // Log-warn mode: never reject, just surface drift. Throttled to one
  // warning per (subject, missing_field) pair per 60s so a misconfigured
  // publisher doesn't spam the log. Switch to log-warn-and-drop after
  // 2026-06-01 per the migration timeline in the contract.
  /**
   * Returns TRUE when the message may be consumed. Strict mode (issue #468,
   * 2026-08-01 milestone): a payload missing a required canonical field, or
   * carrying a canonical field only through its legacy alias, is warned about
   * (30-min throttle, as before) and DROPPED. KANNAKA_SCHEMA_STRICT=off is the
   * emergency valve back to warn-accept.
   */
  _validateSchema(subject, data) {
    const strict = process.env.KANNAKA_SCHEMA_STRICT !== "off";
    if (!data || typeof data !== "object") return true;
    const required = NATS_REQUIRED_FIELDS[subject] ||
      (subject.startsWith("QUEEN.phase.") && NATS_REQUIRED_FIELDS["QUEEN.phase.<agent_id>"]) ||
      (subject.startsWith("KANNAKA.exemplar.") && NATS_REQUIRED_FIELDS["KANNAKA.exemplar.<agent_id>.<cluster_id>"]) ||
      null;
    if (!required) return true; // unknown subject — skip

    // Deprecation surface (issue #468): count + warn on payloads that carry a
    // canonical field ONLY through its legacy alias (e.g. `mean_order` but no
    // `order`, `level` but no `consciousness_level`). Consumers DROP alias reads
    // on 2026-08-01; until then behavior is UNCHANGED (still accepted) — this
    // only surfaces drift so publishers migrate to canonical names in time.
    const aliasMap = NATS_ALIAS_FIELDS[subject] ||
      (subject.startsWith("QUEEN.phase.") && NATS_ALIAS_FIELDS["QUEEN.phase.<agent_id>"]) ||
      null;
    if (aliasMap) {
      const aliasOnly = [];
      for (const canon in aliasMap) {
        const alias = aliasMap[canon];
        if (data[canon] === undefined && data[alias] !== undefined) {
          aliasOnly.push(`${alias}→${canon}`);
        }
      }
      if (aliasOnly.length > 0) {
        if (!this._aliasOnlyCounts) this._aliasOnlyCounts = {};
        this._aliasOnlyCounts[subject] = (this._aliasOnlyCounts[subject] || 0) + 1;
        if (!this._aliasWarnHistory) this._aliasWarnHistory = new Map();
        const aliasKey = `${subject}::${aliasOnly.slice().sort().join(",")}`;
        const aliasNow = Date.now();
        const lastAliasWarn = this._aliasWarnHistory.get(aliasKey) || 0;
        if (aliasNow - lastAliasWarn >= 30 * 60 * 1000) {
          console.warn(`[nats-schema] ${subject} carries alias-only field(s) ${aliasOnly.join(", ")} (count=${this._aliasOnlyCounts[subject]}) — ${strict ? "DROPPED: canonical names required since 2026-08-01" : "accepted (KANNAKA_SCHEMA_STRICT=off)"} (issue #468)`);
          this._aliasWarnHistory.set(aliasKey, aliasNow);
        }
        if (strict) return false;
      }
    }

    const missing = [];
    for (const field of required) {
      // camelCase tolerance removed with the 2026-08-01 strict milestone —
      // it was a "2026-Q2 transition" measure two quarters expired (#468).
      if (data[field] === undefined) missing.push(field);
    }
    if (missing.length === 0) return true;

    const now = Date.now();
    if (!this._schemaWarnHistory) this._schemaWarnHistory = new Map();
    // 2026-05-08: bumped from 60s to 30min. The Rust kannaka-memory side
    // hasn't been migrated to emit schema_version/ts/agent_id yet on
    // QUEEN.phase.* and KANNAKA.consciousness — at 60s throttle the journal
    // logs ~5 warnings/min and drowned the real signals. 30min still
    // surfaces drift but doesn't pin the log.
    for (const field of missing) {
      const key = `${subject}::${field}`;
      const lastWarn = this._schemaWarnHistory.get(key) || 0;
      if (now - lastWarn < 30 * 60 * 1000) continue;
      console.warn(`[nats-schema] ${subject} missing required field "${field}" — ${strict ? "DROPPED (strict mode, issue #468)" : "accepted (KANNAKA_SCHEMA_STRICT=off)"}`);
      this._schemaWarnHistory.set(key, now);
    }
    return !strict;
  }
}

// Required-fields map — keep in sync with consciousness-core/docs/nats-contract.yaml.
const NATS_REQUIRED_FIELDS = {
  "KANNAKA.consciousness":              ["schema_version", "ts", "agent_id", "phi"],
  "KANNAKA.dreams":                     ["schema_version", "ts", "agent_id", "cycles"],
  "QUEEN.phase.<agent_id>":             ["schema_version", "ts", "agent_id", "phase"],
  // centroid moved required -> optional in the contract (consciousness-core#72):
  // HRM encodings are per-agent, so absorbers re-encode content — a foreign
  // centroid was never the interchange payload.
  "KANNAKA.exemplar.<agent_id>.<cluster_id>": ["schema_version", "ts", "agent_id", "cluster_id"],
  "KANNAKA.reactions":                  ["ts", "emoji", "kind"],
  "queen.event.dream.start":            ["schema_version", "ts", "agent_id"],
  "queen.event.dream.end":              ["schema_version", "ts", "agent_id", "memories_strengthened", "memories_faded"],
  "queen.event.join":                   ["schema_version", "ts", "agent_id"],
  "queen.event.leave":                  ["schema_version", "ts", "agent_id"],
  "queen.event.memory.shared":          ["schema_version", "ts", "agent_id", "memory_id"],
  "ORC.stem.submitted":                 ["schema_version", "ts", "agent_id", "stem_id"],
};

// Canonical field → legacy alias, per consciousness-core/docs/nats-contract.yaml.
// Used by _validateSchema to flag alias-only payloads (drift). The publisher
// removes these aliases on 2026-09-01; consumers drop alias reads on 2026-08-01
// (issue #468). Keep in sync with the contract's alias annotations.
const NATS_ALIAS_FIELDS = {
  // theta is the legacy wire name for phase (#227 honoured it on read). Under
  // strict mode (#468) a theta-only packet is an alias-only payload: warned
  // as such and dropped, rather than confusingly reported as "missing phase".
  "QUEEN.phase.<agent_id>": {
    phase: "theta",
  },
  "KANNAKA.consciousness": {
    order: "mean_order",
    consciousness_level: "level",
    num_clusters: "clusters",
    active_memories: "active",
    total_memories: "total",
  },
  "KANNAKA.dreams": {
    memories_pruned: "memories_faded",
  },
};

module.exports = { NATSClient, resolveNatsEndpoint, coercePhase, NATS_REQUIRED_FIELDS };
