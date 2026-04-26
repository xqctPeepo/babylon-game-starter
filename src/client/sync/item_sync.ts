// ============================================================================
// ITEM STATE SYNC MODULE
// ============================================================================
//
// Item replication under the hybrid authority model. See MULTIPLAYER_SYNCH.md:
//   - §4.7 Item authority lifecycle
//     (../../../MULTIPLAYER_SYNCH.md#47-item-authority-lifecycle)
//   - §5.2 Item state (per-row filter)
//     (../../../MULTIPLAYER_SYNCH.md#52-item-state)
//   - §7.5 Item authority authorization
//     (../../../MULTIPLAYER_SYNCH.md#75-item-authority-authorization)
//
// This module is the low-level abstraction that tracks per-instance snapshots and applies
// remote snapshots onto local meshes. Per MULTIPLAYER_SYNCH.md §B.9 (mesh-direct kinematic
// apply), the apply path writes `mesh.position` + `mesh.rotationQuaternion` directly;
// Havok's pre-step sync then propagates the pose onto the ANIMATED physics body before
// the next physics tick. It is intentionally authority-agnostic: callers (e.g.
// `configured_items_sync.ts`) decide whether the local client currently owns an instanceId
// and may publish rows for it.

import { applyPoseToMesh, ThrottledFunction } from '../utils/multiplayer_serialization';

import type { ItemInstanceState, ItemStateUpdate, ItemCollectionEvent } from '../types/multiplayer';

/**
 * Tracks and detects item state changes for multiplayer replication.
 *
 * Authority-agnostic: this class does not gate sends on the base-synchronizer role. The caller
 * is responsible for only publishing rows for `instanceId`s the local client currently owns,
 * per [MULTIPLAYER_SYNCH.md §4.7](../../../MULTIPLAYER_SYNCH.md#47-item-authority-lifecycle).
 * Rows published without authority are silently dropped server-side (§7.5) rather than
 * rejected.
 */
export class ItemSync {
  private itemStates = new Map<string, ItemInstanceState>();
  private collectionEvents: ItemCollectionEvent[] = [];
  private throttle: ThrottledFunction;

  constructor(throttleMs = 100) {
    this.throttle = new ThrottledFunction(throttleMs);
  }

  /**
   * Updates item state snapshot
   */
  public updateItemState(state: ItemInstanceState): void {
    this.itemStates.set(state.instanceId, state);
  }

  /**
   * Records item collection event
   */
  public recordCollection(event: ItemCollectionEvent): void {
    this.collectionEvents.push(event);
  }

  /**
   * Creates state update and clears pending events
   */
  public createStateUpdate(timestamp: number): ItemStateUpdate | null {
    if (!this.throttle.shouldCall()) {
      return null;
    }

    if (this.itemStates.size === 0 && this.collectionEvents.length === 0) {
      return null;
    }

    const update: ItemStateUpdate = {
      updates: Array.from(this.itemStates.values()),
      collections: this.collectionEvents.length > 0 ? [...this.collectionEvents] : undefined,
      timestamp
    };

    // Clear pending events after creating update
    this.collectionEvents = [];

    return update;
  }

  /**
   * Gets all current item states
   */
  public getAllItemStates(): ItemInstanceState[] {
    return Array.from(this.itemStates.values());
  }

  /**
   * Applies a remote item snapshot to a mesh (and its kinematic physics body if present).
   *
   * Wire contract (Invariants P and E, MULTIPLAYER_SYNCH.md §5.2): `state.pos` is the
   * world-space position and `state.rot` is the pre-scale unit quaternion, both read
   * from the owner's local mesh channels and written verbatim onto the replica's local
   * channels. No matrix decomposition on either side; `mesh.scaling` is never touched
   * because it is a static per-client config value (see §5.2 pose-only transport).
   *
   * Apply strategy (MULTIPLAYER_SYNCH.md §B.9 — kinematic apply pattern):
   *   - **Never** call `setTargetTransform` on the physics body. `setTargetTransform`
   *     is designed for authored kinematic animation (moving platforms etc.); when
   *     fed with a new replica target every tick it produces the "whizzing demon"
   *     artefact on P2 as the interpolator is retargeted before it reaches each
   *     prior target.
   *   - **Never** toggle `body.disablePreStep`. The default (`false`) lets Havok's
   *     pre-step copy `mesh.position` / `mesh.rotationQuaternion` onto the body
   *     before each step — i.e. the canonical ANIMATED-body drive path.
   *   - **Never** call `setLinearVelocity` / `setAngularVelocity` — non-owner
   *     bodies are ANIMATED (kinematic) per the non-owner kinematic invariant
   *     (§4.7) and integrating velocities would violate that.
   *   - Euler channels (`mesh.rotation`) are never written (Invariant E).
   *
   * Short-circuit on DYNAMIC bodies: a DYNAMIC motion type implies the local client
   * IS the resolved owner. Receiving a remote snapshot for an owned item signals an
   * authority-routing bug upstream; blindly writing its pose would fight the local
   * simulation. We ignore and log so the mismatch is visible.
   */
  public static applyRemoteItemState(
    itemMesh: BABYLON.AbstractMesh,
    state: ItemInstanceState,
    body?: BABYLON.PhysicsAggregate | null
  ): void {
    if (!itemMesh) return;

    const physicsBody =
      body && !body.body.isDisposed ? body.body : this.resolveMeshPhysicsBody(itemMesh);

    if (!state.isCollected) {
      const hasPose =
        Array.isArray(state.pos) &&
        state.pos.length === 3 &&
        Array.isArray(state.rot) &&
        state.rot.length === 4;
      if (!hasPose) {
        // Collection status still needs to be applied below.
      } else if (
        physicsBody &&
        !physicsBody.isDisposed &&
        physicsBody.getMotionType() === BABYLON.PhysicsMotionType.DYNAMIC
      ) {
        // We own this body (DYNAMIC = local simulation). Remote state must not
        // be written; it would compete with our own physics step. The server's
        // owner-pin rule is supposed to prevent this from arriving, so log.
        console.warn(
          `[ItemSync] Received remote state for DYNAMIC (self-owned) item ${state.instanceId}; ignoring.`
        );
      } else {
        // ANIMATED (kinematic) or no body: write the pose (pos + rotationQuaternion)
        // directly onto the mesh. On the next physics tick, Havok's pre-step sync
        // (disablePreStep=false) copies those channels onto the body so collision
        // queries see the correct pose without any interpolation surprises.
        try {
          applyPoseToMesh(itemMesh, { pos: state.pos, rot: state.rot });
        } catch (e) {
          console.warn('[ItemSync] Failed to apply pose:', e);
        }
      }
    }

    try {
      if (state.isCollected) {
        itemMesh.isVisible = false;
        itemMesh.setEnabled(false);
      } else {
        itemMesh.isVisible = true;
        itemMesh.setEnabled(true);
      }
    } catch (e) {
      console.warn('[ItemSync] Failed to apply collection status:', e);
    }
  }

  private static resolveMeshPhysicsBody(mesh: BABYLON.AbstractMesh): BABYLON.PhysicsBody | null {
    const maybe = (mesh as BABYLON.AbstractMesh & { physicsBody?: BABYLON.PhysicsBody })
      .physicsBody;
    if (maybe && !maybe.isDisposed) {
      return maybe;
    }
    return null;
  }

  /**
   * Marks item collected (typically called by managers handling collection logic)
   * @param instanceId The item instance ID
   * @param collected Whether the item is collected
   */
  public markItemCollected(instanceId: string, collected: boolean): void {
    const state = this.itemStates.get(instanceId);
    if (state) {
      // Create updated state with collection status
      const updated: ItemInstanceState = {
        ...state,
        isCollected: collected,
        collectedByClientId: collected ? state.collectedByClientId : undefined
      };
      this.itemStates.set(instanceId, updated);
    }
  }

  /**
   * Removes item state (when item is permanently removed from world)
   */
  public removeItemState(instanceId: string): void {
    this.itemStates.delete(instanceId);
  }

  /**
   * Clears all tracked items (for scene switch)
   */
  public clearAll(): void {
    this.itemStates.clear();
    this.collectionEvents = [];
  }
}
