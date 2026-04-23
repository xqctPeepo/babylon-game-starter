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
// remote snapshots to physics aggregates (teleporting kinematic bodies via
// `setTargetTransform`). It is intentionally authority-agnostic: callers (e.g.
// `configured_items_sync.ts`) decide whether the local client currently owns an instanceId
// and may publish rows for it.

import { deserializeQuaternion, ThrottledFunction } from '../utils/multiplayer_serialization';

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
   * Applies remote item state to a mesh (and optionally teleports its physics body).
   *
   * Applied properties:
   * - Position
   * - Rotation (quaternion [x, y, z, w] wire format only)
   * - Collection status (visibility + enabled)
   *
   * When `body` is provided and the item is not collected, the physics body is teleported
   * to the authoritative transform and its velocities are zeroed so the local simulation
   * does not fight the remote state.
   */
  public static applyRemoteItemState(
    itemMesh: BABYLON.AbstractMesh,
    state: ItemInstanceState,
    body?: BABYLON.PhysicsAggregate | null
  ): void {
    if (!itemMesh) return;

    const pos = new BABYLON.Vector3(state.position[0], state.position[1], state.position[2]);
    let quat: BABYLON.Quaternion;
    try {
      quat = deserializeQuaternion(state.rotation);
    } catch (e) {
      console.warn('[ItemSync] Failed to deserialize rotation:', e);
      quat = new BABYLON.Quaternion(0, 0, 0, 1);
    }

    const physicsBody =
      body && !body.body.isDisposed ? body.body : this.resolveMeshPhysicsBody(itemMesh);

    if (physicsBody && !state.isCollected) {
      try {
        physicsBody.setTargetTransform(pos, quat);
        physicsBody.setLinearVelocity(
          new BABYLON.Vector3(state.velocity[0], state.velocity[1], state.velocity[2])
        );
        physicsBody.setAngularVelocity(BABYLON.Vector3.Zero());
      } catch {
        try {
          itemMesh.position.copyFrom(pos);
          itemMesh.rotationQuaternion ??= new BABYLON.Quaternion(0, 0, 0, 1);
          itemMesh.rotationQuaternion.copyFrom(quat);
        } catch (e) {
          console.warn('[ItemSync] Fallback transform apply failed:', e);
        }
      }
    } else {
      try {
        itemMesh.position.copyFrom(pos);
        itemMesh.rotationQuaternion ??= new BABYLON.Quaternion(0, 0, 0, 1);
        itemMesh.rotationQuaternion.copyFrom(quat);
      } catch (e) {
        console.warn('[ItemSync] Failed to apply transform:', e);
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

  private static resolveMeshPhysicsBody(
    mesh: BABYLON.AbstractMesh
  ): BABYLON.PhysicsBody | null {
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
