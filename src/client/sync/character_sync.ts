// ============================================================================
// CHARACTER STATE SYNC MODULE
// ============================================================================

import type BABYLON from '@babylonjs/core';
import type { CharacterController } from '../controllers/character_controller';
import type { CharacterState, CharacterStateUpdate, Vector3Serializable } from '../types/multiplayer';
import {
  serializeVector3,
  ThrottledFunction,
  hasSignificantVector3Change,
  hasSignificantAngleChange,
  hasSignificantNumberChange
} from '../utils/multiplayer_serialization';

/**
 * Tracks and detects character state changes for synchronization
 */
export class CharacterSync {
  private characterController: CharacterController | null = null;
  private lastSentState: Partial<CharacterState> | null = null;
  private throttle: ThrottledFunction;
  private clientId: string;

  constructor(clientId: string, throttleMs = 50) {
    this.clientId = clientId;
    this.throttle = new ThrottledFunction(throttleMs);
  }

  /**
   * Sets the character controller to track
   */
  public setCharacterController(controller: CharacterController): void {
    this.characterController = controller;
  }

  /**
   * Samples current character state and detects changes
   */
  public sampleState(timestamp: number): CharacterState | null {
    if (!this.characterController) {
      return null;
    }

    // Check if enough time has passed since last update
    if (!this.throttle.shouldCall()) {
      return null;
    }

    const mesh = this.characterController.getCharacterMesh();
    if (!mesh) {
      return null;
    }

    const state: CharacterState = {
      clientId: this.clientId,
      position: serializeVector3(mesh.position),
      rotation: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z],
      velocity: serializeVector3(this.characterController.getVelocity?.() ?? BABYLON.Vector3.Zero()),
      animationState: this.characterController.getCurrentState?.() ?? 'idle',
      animationFrame: 0, // TODO: Get from animation group
      isJumping: this.characterController.getVelocity?.()?.y > 0.1 ?? false,
      isBoosting: this.characterController.getBoostStatus?.() !== 'Ready' ?? false,
      boostType: this.getBoostType(),
      boostTimeRemaining: 0, // TODO: Track boost duration
      timestamp
    };

    // Check if significant change from last sent state
    if (this.hasSignificantChange(state)) {
      this.lastSentState = state;
      return state;
    }

    return null;
  }

  /**
   * Gets batch of characters to sync (for other players)
   */
  public createStateUpdate(timestamp: number, characterStates: CharacterState[]): CharacterStateUpdate {
    return {
      updates: characterStates,
      timestamp
    };
  }

  /**
   * Applies received character state to remote mesh
   * 
   * Applied properties:
   * - Position (direct assignment)
   * - Rotation (Euler angles as [x, y, z] in radians)
   * - Velocity (stored for interpolation, not directly applied)
   * 
   * NOTE: Animation state and physics velocity are handled by higher-level managers
   */
  public static applyRemoteCharacterState(
    remoteMesh: BABYLON.AbstractMesh,
    state: CharacterState
  ): void {
    if (!remoteMesh) return;

    // Apply position
    this.applyPosition(remoteMesh, state.position);

    // Apply rotation from Euler angles
    this.applyRotation(remoteMesh, state.rotation);

    // Store velocity for potential physics interpolation (not directly applied to mesh)
    // Velocity should be handled by physics controller, not mesh transform
  }

  /**
   * Applies position to mesh with bounds checking
   */
  private static applyPosition(mesh: BABYLON.AbstractMesh, pos: Vector3Serializable): void {
    try {
      mesh.position.set(pos[0], pos[1], pos[2]);
    } catch (e) {
      console.warn('[CharacterSync] Failed to apply position:', e);
    }
  }

  /**
   * Applies rotation (Euler angles) to mesh
   * Uses rotationQuaternion if available, falls back to rotation property
   */
  private static applyRotation(mesh: BABYLON.AbstractMesh, euler: Vector3Serializable): void {
    try {
      // Prefer quaternion for better rotation interpolation
      if (mesh.rotationQuaternion) {
        const quat = BABYLON.Quaternion.FromEulerAngles(euler[0], euler[1], euler[2]);
        mesh.rotationQuaternion.copyFrom(quat);
      } else {
        mesh.rotation.set(euler[0], euler[1], euler[2]);
      }
    } catch (e) {
      console.warn('[CharacterSync] Failed to apply rotation:', e);
    }
  }

  // ========================================================================
  // Private methods
  // ========================================================================

  private hasSignificantChange(newState: CharacterState): boolean {
    const last = this.lastSentState;
    if (!last) return true;

    // Check position change (threshold: 0.1 units)
    if (hasSignificantVector3Change(last.position as any, newState.position, 0.1)) {
      return true;
    }

    // Check rotation change (threshold: 0.05 radians)
    if (hasSignificantAngleChange((last.rotation?.[1] ?? 0), newState.rotation[1], 0.05)) {
      return true;
    }

    // Check animation state change
    if (last.animationState !== newState.animationState) {
      return true;
    }

    // Check jump/boost state change
    if (last.isJumping !== newState.isJumping || last.isBoosting !== newState.isBoosting) {
      return true;
    }

    return false;
  }

  private getBoostType(): 'superJump' | 'invisibility' | undefined {
    const boostStatus = this.characterController?.getBoostStatus?.();
    if (boostStatus?.includes('Super Jump')) {
      return 'superJump';
    }
    if (boostStatus?.includes('Invisibility')) {
      return 'invisibility';
    }
    return undefined;
  }
}
