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
  /**
   * Set of env names for which an authority snapshot has been applied (either via the
   * SSE-open replay from `pushAuthoritySnapshotToSession` landing on the wire, or via
   * the bootstrap `item-state-update` that follows env-entry). Used by
   * {@link multiplayer_bootstrap} to gate publish-side fallbacks — see
   * MULTIPLAYER_SYNCH.md §4.8 *No-authority-means-non-owner*: a client MUST NOT assume
   * ambient self-ownership (including the "unowned + base-synchronizer" publish fallback)
   * until it has applied at least one authority signal for the env in question.
   */
  private snapshotAppliedEnvs = new Set<string>();
  /**
   * Per-environment authority mirror (§4.8). envAuthority[envName] = clientId of the
   * current env-authority as reported by the server via `env-item-authority-changed`.
   * Used by {@link isOwnedBySelf} to resolve unowned items: when self is the env-authority
   * for an item's env and the item has no explicit `itemOwners` entry, self is the resolved
   * owner and the item should run DYNAMIC.
   */
  private envAuthority = new Map<string, string>();

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

  /**
   * Resolves whether `instanceId` is currently under the local client's authority, using
   * the full three-tier resolution described in MULTIPLAYER_SYNCH.md §4 (explicit owner →
   * env-authority → nobody):
   *
   * 1. If `itemOwners[instanceId]` names self → `true` (§4.7 explicit claim).
   * 2. If no explicit owner exists AND `envAuthority[envName]` names self → `true`
   *    (§4.8 env-authority: self drives all unclaimed items in this env).
   * 3. Otherwise → `false`.
   *
   * **Invariant (MULTIPLAYER_SYNCH.md §4.8 *No-authority-means-non-owner*).** In the
   * absence of any applied authority signal for the item's environment, both the explicit
   * owner lookup (tier 1) and the env-authority lookup (tier 2) return falsy, so the
   * result is `false`. This correctly seeds newcomers into ANIMATED-default and prevents
   * the "both DYNAMIC, no propagation" failure mode.
   *
   * The env name is extracted from the env-scoped instanceId prefix (format "envName::…").
   */
  public isOwnedBySelf(instanceId: string): boolean {
    const self = this.selfClientId;
    if (!self) {
      return false;
    }
    const explicitOwner = this.owners.get(instanceId);
    if (explicitOwner !== undefined) {
      return explicitOwner === self;
    }
    // No explicit owner — fall back to env-authority tier.
    const envName = instanceId.includes('::') ? instanceId.split('::')[0] : '';
    if (!envName) {
      return false;
    }
    const envAuth = this.envAuthority.get(envName);
    return envAuth === self;
  }

  /**
   * Apply an `env-item-authority-changed` signal from the server. Records the new
   * env-authority for `envName` so that {@link isOwnedBySelf} can resolve unowned items
   * in that environment using the §4.8 env-authority tier.
   * Returns `true` if the env-authority transitioned (i.e. the value changed), allowing
   * callers to decide whether to re-seed motion types.
   */
  public applyEnvAuthorityChange(envName: string, newAuthorityId: string | null): boolean {
    if (!envName) {
      return false;
    }
    const prev = this.envAuthority.get(envName) ?? null;
    if (newAuthorityId) {
      this.envAuthority.set(envName, newAuthorityId);
    } else {
      this.envAuthority.delete(envName);
    }
    return prev !== (newAuthorityId ?? null);
  }

  /** Returns the current env-authority client ID for `envName`, or null if none. */
  public getEnvAuthority(envName: string): string | null {
    return this.envAuthority.get(envName) ?? null;
  }

  public isUnowned(instanceId: string): boolean {
    return !this.owners.has(instanceId);
  }

  /**
   * Records that an authority snapshot has been applied for `envName`. Called by the
   * bootstrap after `mp.join()` resolves and the server's `pushAuthoritySnapshotToSession`
   * replay has had a chance to land (see MULTIPLAYER_SYNCH.md §4.5 SSE-open ordering).
   * Also called on receipt of the first `item-state-update` for `envName` after env-entry
   * (§5.2.2 rule 4 AOI-enter bootstrap).
   */
  public markSnapshotApplied(envName: string): void {
    if (!envName) {
      return;
    }
    this.snapshotAppliedEnvs.add(envName);
  }

  /**
   * Reports whether {@link markSnapshotApplied} has been called for `envName`. Used by
   * the publish gate to refuse the "unowned + base-synchronizer" fallback until the
   * authority signal for the env has been observed — otherwise a racing newcomer could
   * publish rows for items the server has already assigned to another client (producing
   * a false claim on the server side).
   */
  public hasSnapshotAppliedFor(envName: string): boolean {
    return this.snapshotAppliedEnvs.has(envName);
  }

  /** Clears snapshot-applied state (e.g. on env-switch — next env must re-absorb). */
  public clearSnapshotAppliedFor(envName: string): void {
    this.snapshotAppliedEnvs.delete(envName);
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
