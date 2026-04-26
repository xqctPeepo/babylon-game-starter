// ============================================================================
// PROXIMITY CLAIM OBSERVER — fires item authority claims before collision
// ============================================================================
//
// Drives the per-item authority model (MULTIPLAYER_SYNCH.md §4.7) on the client side:
//   - When the local character enters a `claimRadiusMeters` bubble around a dynamic
//     item, the observer PATCHes `/item-authority-claim` so the body is already owned
//     (and can be flipped to DYNAMIC) by the time the capsule touches the item.
//   - When the character leaves the bubble, a grace timer starts; if the character does
//     not re-enter within `claimGraceMs`, the observer releases ownership.
//   - Owners keep publishing rows via the existing item-state pipeline; the server's idle
//     timeout picks up stragglers (e.g. tab freeze) per §4.7 rule 2c.
//
// The observer is authority-UI: it does not flip physics motion types itself — the
// bootstrap listens to `ItemAuthorityTracker` change events to do that, so optimistic
// claim + server confirmation follow a single code path.

import type { ItemAuthorityTracker } from './item_authority_tracker';
import type { MultiplayerManager } from '../managers/multiplayer_manager';

export interface ProximityItem {
  /** Wire instance id (env-scoped). */
  readonly instanceId: string;
  /** Per-frame position source; returns null if the item is gone / collected. */
  readonly getPosition: () => BABYLON.Vector3 | null;
}

export interface ProximityClaimObserverOptions {
  readonly claimRadiusMeters: number;
  readonly claimGraceMs: number;
  readonly getCharacterPosition: () => BABYLON.Vector3 | null;
  /** Optional: skip claim attempts while true (e.g. scene switching). */
  readonly shouldPause?: () => boolean;
}

interface ProxState {
  inBubble: boolean;
  exitedAt: number | null;
  lastClaimAttemptAt: number;
  claimInFlight: boolean;
}

export class ProximityClaimObserver {
  private items = new Map<string, ProximityItem>();
  private state = new Map<string, ProxState>();

  constructor(
    private readonly mp: MultiplayerManager,
    private readonly tracker: ItemAuthorityTracker,
    private readonly opts: ProximityClaimObserverOptions
  ) {}

  /** Replace the set of items the observer tracks; usually called on env load. */
  public setItems(items: readonly ProximityItem[]): void {
    const incoming = new Set(items.map((i) => i.instanceId));
    for (const id of Array.from(this.items.keys())) {
      if (!incoming.has(id)) {
        this.items.delete(id);
        this.state.delete(id);
      }
    }
    for (const it of items) {
      this.items.set(it.instanceId, it);
      if (!this.state.has(it.instanceId)) {
        this.state.set(it.instanceId, {
          inBubble: false,
          exitedAt: null,
          lastClaimAttemptAt: 0,
          claimInFlight: false
        });
      }
    }
  }

  public clear(): void {
    this.items.clear();
    this.state.clear();
  }

  /**
   * Per-frame update. Call from `scene.onBeforeRenderObservable`.
   * Returns the number of items currently inside the bubble (mostly for diagnostics).
   */
  public tick(): number {
    if (this.opts.shouldPause?.()) {
      return 0;
    }
    const charPos = this.opts.getCharacterPosition();
    if (!charPos) {
      return 0;
    }
    const self = this.tracker.getSelfClientId();
    if (!self) {
      return 0;
    }

    const now = performance.now();
    const rSq = this.opts.claimRadiusMeters * this.opts.claimRadiusMeters;
    const graceMs = this.opts.claimGraceMs;
    let inside = 0;

    for (const [id, item] of this.items) {
      const p = item.getPosition();
      const st = this.state.get(id);
      if (!p || !st) {
        continue;
      }
      const dx = p.x - charPos.x;
      const dy = p.y - charPos.y;
      const dz = p.z - charPos.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      const isInside = distSq <= rSq;
      if (isInside) {
        inside++;
      }

      if (isInside && !st.inBubble) {
        st.inBubble = true;
        st.exitedAt = null;
        this.maybeClaim(id, charPos, now, st, self);
      } else if (isInside && st.inBubble) {
        if (
          !this.tracker.isOwnedBySelf(id) &&
          !st.claimInFlight &&
          now - st.lastClaimAttemptAt > 400
        ) {
          this.maybeClaim(id, charPos, now, st, self);
        }
      } else if (!isInside && st.inBubble) {
        st.inBubble = false;
        st.exitedAt = now;
      } else if (!isInside && st.exitedAt !== null) {
        if (this.tracker.isOwnedBySelf(id) && now - st.exitedAt >= graceMs) {
          st.exitedAt = null;
          void this.mp.releaseItemAuthority(id, { reason: 'grace_expired' });
        } else if (!this.tracker.isOwnedBySelf(id)) {
          st.exitedAt = null;
        }
      }
    }

    return inside;
  }

  private maybeClaim(
    id: string,
    charPos: BABYLON.Vector3,
    now: number,
    st: ProxState,
    selfClientId: string
  ): void {
    if (st.claimInFlight) {
      return;
    }
    if (this.tracker.isOwnedBySelf(id)) {
      return;
    }
    st.claimInFlight = true;
    st.lastClaimAttemptAt = now;

    // Track whether THIS call was the one that flipped local state to self.
    // `isUnowned` must be sampled BEFORE the optimistic flip because
    // `optimisticSetSelfOwner` writes `owners.set(instanceId, selfClientId)`,
    // which would make `isUnowned` lie on a subsequent read.
    const didOptimistic = this.tracker.isUnowned(id);
    if (didOptimistic) {
      this.tracker.optimisticSetSelfOwner(id);
    }

    const payload = {
      clientPosition: { x: charPos.x, y: charPos.y, z: charPos.z },
      reason: 'proximity'
    };

    void this.mp
      .claimItemAuthority(id, payload)
      .then((resp) => {
        // Case A: network/non-OK (resp === null). If we flipped optimistic,
        // revert — otherwise the client stays pinned as owner forever, flips
        // its body to DYNAMIC, and its ItemSync keeps replaying a row the
        // server will mark "unauthorized" every throttle window.
        if (!resp) {
          if (didOptimistic) {
            // Use reason='release' (the only non-claim, non-system reason in
            // ItemAuthorityChangedMessage) to represent a locally-initiated
            // revert of a never-confirmed optimistic claim. No signal is sent
            // over the network; this is a tracker-local correction only.
            this.tracker.applyAuthorityChange({
              instanceId: id,
              previousOwnerId: selfClientId,
              newOwnerId: null,
              reason: 'release',
              timestamp: Date.now()
            });
          }
          return;
        }

        // Case B: server accepted our claim (possibly after idle-timeout
        // takeover). The authoritative `item-authority-changed` SSE signal
        // will still land; nothing to revert here.
        if (resp.accepted) {
          return;
        }

        // Case C: server rejected AND named a different current owner.
        // Apply the server's view directly; this also replaces our optimistic
        // self-owner entry in `owners` with the real owner.
        if (resp.currentOwnerId && resp.currentOwnerId !== selfClientId) {
          this.tracker.applyAuthorityChange({
            instanceId: id,
            previousOwnerId: selfClientId,
            newOwnerId: resp.currentOwnerId,
            reason: 'claim',
            timestamp: resp.serverTimestamp
          });
          return;
        }

        // Case D: ambiguous reject (no currentOwnerId, or it echoes self).
        // Safest recovery is to drop the optimistic flip so authority is
        // re-derived from env-authority / explicit ownership and the item's
        // body is returned to ANIMATED until a real claim succeeds.
        if (didOptimistic) {
          this.tracker.applyAuthorityChange({
            instanceId: id,
            previousOwnerId: selfClientId,
            newOwnerId: null,
            reason: 'release',
            timestamp: resp.serverTimestamp
          });
        }
      })
      .finally(() => {
        st.claimInFlight = false;
      });
  }
}
