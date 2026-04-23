// ============================================================================
// ITEM AUTHORITY TRACKER — mirror of server's itemOwners map for this client
// ============================================================================
//
// Consumes `item-authority-changed` SSE signals (MULTIPLAYER_SYNCH.md §6.8) to maintain a
// `Map<instanceId, ownerClientId | null>`. Emits local change callbacks so the bootstrap can
// flip physics motion types per-item (dynamic for self-owned, kinematic for peer-owned).
//
// This is a pure, deterministic state mirror — it never talks to the network directly; the
// caller wires it up to `MultiplayerManager.on('item-authority-changed', …)` and optimistic
// post-claim updates.

import type { ItemAuthorityChangedMessage } from '../types/multiplayer';

export type AuthorityChangeListener = (evt: {
  instanceId: string;
  previousOwnerId: string | null;
  newOwnerId: string | null;
  selfOwnsNow: boolean;
  selfOwnedBefore: boolean;
  reason: string;
}) => void;

export class ItemAuthorityTracker {
  private owners = new Map<string, string>();
  private selfClientId: string | null = null;
  private listeners = new Set<AuthorityChangeListener>();

  public setSelfClientId(id: string | null): void {
    this.selfClientId = id;
  }

  public getSelfClientId(): string | null {
    return this.selfClientId;
  }

  /** Register a listener; returns an unsubscribe function. */
  public onChange(listener: AuthorityChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getOwner(instanceId: string): string | null {
    return this.owners.get(instanceId) ?? null;
  }

  public isOwnedBySelf(instanceId: string): boolean {
    const owner = this.owners.get(instanceId);
    return !!owner && !!this.selfClientId && owner === this.selfClientId;
  }

  public isUnowned(instanceId: string): boolean {
    return !this.owners.has(instanceId);
  }

  public getAllOwnedBySelf(): string[] {
    if (!this.selfClientId) {
      return [];
    }
    const out: string[] = [];
    for (const [id, owner] of this.owners) {
      if (owner === this.selfClientId) {
        out.push(id);
      }
    }
    return out;
  }

  /** Apply the authoritative server transition. Fires onChange only when state actually flips. */
  public applyAuthorityChange(msg: ItemAuthorityChangedMessage): void {
    const { instanceId } = msg;
    if (!instanceId) {
      return;
    }
    const previous = this.owners.get(instanceId) ?? null;
    if (msg.newOwnerId) {
      this.owners.set(instanceId, msg.newOwnerId);
    } else {
      this.owners.delete(instanceId);
    }
    if (previous === (msg.newOwnerId ?? null)) {
      return;
    }
    const self = this.selfClientId;
    const selfOwnsNow = !!self && msg.newOwnerId === self;
    const selfOwnedBefore = !!self && previous === self;
    this.fire({
      instanceId,
      previousOwnerId: previous,
      newOwnerId: msg.newOwnerId ?? null,
      selfOwnsNow,
      selfOwnedBefore,
      reason: msg.reason
    });
  }

  /**
   * Optimistic local set used right after firing a claim: we assume the server will accept
   * if the item was unowned. If the accept response shows otherwise, call
   * {@link applyAuthorityChange} with the server's view to correct.
   */
  public optimisticSetSelfOwner(instanceId: string): void {
    if (!this.selfClientId) {
      return;
    }
    const prev = this.owners.get(instanceId) ?? null;
    if (prev === this.selfClientId) {
      return;
    }
    this.owners.set(instanceId, this.selfClientId);
    this.fire({
      instanceId,
      previousOwnerId: prev,
      newOwnerId: this.selfClientId,
      selfOwnsNow: true,
      selfOwnedBefore: false,
      reason: 'claim'
    });
  }

  /** Clear tracker (e.g. on disconnect / env change if desired). */
  public clear(): void {
    if (this.owners.size === 0) {
      return;
    }
    const ids = Array.from(this.owners.keys());
    const self = this.selfClientId;
    this.owners.clear();
    for (const id of ids) {
      this.fire({
        instanceId: id,
        previousOwnerId: null,
        newOwnerId: null,
        selfOwnsNow: false,
        selfOwnedBefore: self !== null,
        reason: 'release'
      });
    }
  }

  private fire(evt: Parameters<AuthorityChangeListener>[0]): void {
    for (const l of this.listeners) {
      try {
        l(evt);
      } catch (e) {
        console.warn('[ItemAuthorityTracker] listener threw:', e);
      }
    }
  }
}
