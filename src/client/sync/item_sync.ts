// ============================================================================
// ITEM STATE SYNC MODULE
// ============================================================================

import type BABYLON from '@babylonjs/core';
import type { ItemInstanceState, ItemStateUpdate, ItemCollectionEvent } from '../types/multiplayer';
import {
  serializeVector3,
  ThrottledFunction,
  hasSignificantVector3Change
} from '../utils/multiplayer_serialization';

/**
 * Tracks and detects item state changes for synchronization
 */
export class ItemSync {
  private itemStates: Map<string, ItemInstanceState> = new Map();
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
      collections:
        this.collectionEvents.length > 0 ? [...this.collectionEvents] : undefined,
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
   * Applies remote item state to mesh
   * 
   * Applied properties:
   * - Position
   * - Rotation (from [x, y, z] Euler angles)
   * - Velocity (stored for physics, not directly applied)
   * - Collection status
   */
  public static applyRemoteItemState(
    itemMesh: BABYLON.AbstractMesh,
    state: ItemInstanceState
  ): void {
    if (!itemMesh) return;

    // Apply position
    try {
      itemMesh.position.set(state.position[0], state.position[1], state.position[2]);
    } catch (e) {
      console.warn('[ItemSync] Failed to apply position:', e);
    }

    // Apply rotation from Euler angles [x, y, z]
    try {
      if (itemMesh.rotationQuaternion) {
        const quat = BABYLON.Quaternion.FromEulerAngles(
          state.rotation[0],
          state.rotation[1],
          state.rotation[2]
        );
        itemMesh.rotationQuaternion.copyFrom(quat);
      } else {
        itemMesh.rotation.set(state.rotation[0], state.rotation[1], state.rotation[2]);
      }
    } catch (e) {
      console.warn('[ItemSync] Failed to apply rotation:', e);
    }

    // Handle collection status visually
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
