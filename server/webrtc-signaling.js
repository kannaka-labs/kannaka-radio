/**
 * webrtc-signaling.js — WebRTC signaling relay for browser-to-browser live broadcasting.
 *
 * The server never touches audio — it only relays SDP offers/answers and ICE candidates.
 * First-come-first-serve mic access with a queue for waiting broadcasters.
 */

class WebRTCSignaling {
  constructor() {
    this.broadcaster = null;    // { ws, clientId, displayName, startedAt }
    this.micQueue = [];         // [{ ws, clientId, displayName, queuedAt }]
    this.listeners = new Map(); // clientId -> { ws }
  }

  /**
   * Try to claim the mic. If already taken, caller is added to the queue.
   * @returns {{ granted: boolean, position?: number, currentBroadcaster?: string }}
   */
  claimMic(ws, clientId, displayName) {
    if (this.broadcaster) {
      // Already broadcasting — add to queue if not already there.
      // findIndex once: if absent (-1) we push and the position is the
      // new tail; if present we already have the index. Avoids a second
      // linear scan over the same predicate.
      let pos = this.micQueue.findIndex(q => q.clientId === clientId);
      if (pos === -1) {
        this.micQueue.push({
          ws,
          clientId,
          displayName: displayName || clientId,
          queuedAt: Date.now(),
        });
        pos = this.micQueue.length - 1;
      }
      return {
        granted: false,
        position: pos + 1,
        currentBroadcaster: this.broadcaster.displayName,
      };
    }

    this.broadcaster = {
      ws,
      clientId,
      displayName: displayName || clientId,
      startedAt: Date.now(),
    };
    return { granted: true };
  }

  /**
   * Release the mic. Returns the next person in the queue, if any.
   * @returns {{ nextUp: object|null }|null}
   */
  releaseMic(clientId) {
    if (!this.broadcaster || this.broadcaster.clientId !== clientId) return null;

    this.broadcaster = null;

    // Promote next in queue
    if (this.micQueue.length > 0) {
      const next = this.micQueue.shift();
      return { nextUp: next };
    }
    return { nextUp: null };
  }

  /**
   * Leave the mic queue.
   * @returns {{ removed: boolean, position: number }}
   */
  leaveQueue(clientId) {
    const idx = this.micQueue.findIndex(q => q.clientId === clientId);
    if (idx === -1) return { removed: false, position: -1 };
    this.micQueue.splice(idx, 1);
    return { removed: true, position: idx + 1 };
  }

  /**
   * Register a listener for the broadcast.
   */
  addListener(ws, clientId) {
    this.listeners.set(clientId, { ws });
  }

  /**
   * Remove a listener.
   */
  removeListener(clientId) {
    this.listeners.delete(clientId);
  }

  /**
   * Handle WebSocket disconnect — clean up broadcaster, queue, or listener.
   * @returns {{ nextUp: object|null }|null} if broadcaster disconnected
   */
  handleDisconnect(ws) {
    // If the broadcaster disconnected, release the mic
    if (this.broadcaster && this.broadcaster.ws === ws) {
      return this.releaseMic(this.broadcaster.clientId);
    }

    // Remove from queue
    this.micQueue = this.micQueue.filter(q => q.ws !== ws);

    // Remove from listeners
    for (const [k, v] of this.listeners) {
      if (v.ws === ws) this.listeners.delete(k);
    }

    return null;
  }

  /**
   * Relay a signaling message (SDP offer/answer or ICE candidate) to the target.
   * @returns {boolean} true if delivered
   */
  relay(fromClientId, toClientId, message) {
    let targetWs = null;

    if (this.broadcaster && this.broadcaster.clientId === toClientId) {
      targetWs = this.broadcaster.ws;
    }
    if (!targetWs) {
      const listener = this.listeners.get(toClientId);
      if (listener) targetWs = listener.ws;
    }
    // Also check the queue — someone in the queue might be a signaling target
    if (!targetWs) {
      const queued = this.micQueue.find(q => q.clientId === toClientId);
      if (queued) targetWs = queued.ws;
    }

    if (targetWs && targetWs.readyState === 1) { // WebSocket.OPEN
      targetWs.send(JSON.stringify({
        type: 'webrtc_signal',
        from: fromClientId,
        data: message,
      }));
      return true;
    }
    return false;
  }

  /**
   * Get all listener client IDs (for broadcaster to create offers for each).
   * @returns {string[]}
   */
  getListenerIds() {
    return Array.from(this.listeners.keys());
  }

  /**
   * Get current broadcast status including queue.
   */
  getStatus() {
    return {
      broadcasting: !!this.broadcaster,
      broadcaster: this.broadcaster ? {
        clientId: this.broadcaster.clientId,
        displayName: this.broadcaster.displayName,
        duration: Math.floor((Date.now() - this.broadcaster.startedAt) / 1000),
      } : null,
      listenerCount: this.listeners.size,
      queue: this.micQueue.map(q => ({
        clientId: q.clientId,
        displayName: q.displayName,
      })),
    };
  }
}

module.exports = WebRTCSignaling;
