// ============================================================================
// CHARACTER STATE SYNC MODULE
// ============================================================================

import {
  deserializeQuaternion,
  serializeVector3,
  ThrottledFunction,
  hasSignificantVector3Change,
  hasSignificantQuaternionChange,
  hasSignificantNumberChange,
  toMultiplayerAnimationStateToken,
  yawRadiansToWireQuaternion
} from '../utils/multiplayer_serialization';

import type { CharacterController } from '../controllers/character_controller';
import type {
  CharacterState,
  CharacterStateUpdate,
  QuaternionSerializable,
  Vector3Serializable
} from '../types/multiplayer';

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
   * @param environmentName Current `ASSETS.ENVIRONMENTS[].name` (viewer routing for remote proxies).
   */
  public sampleState(timestamp: number, environmentName: string): CharacterState | null {
    if (!this.characterController) {
      return null;
    }

    // Check if enough time has passed since last update
    if (!this.throttle.shouldCall()) {
      return null;
    }

    const mesh = this.characterController.getPlayerMesh();
    if (!mesh) {
      return null;
    }

    const characterModelId = this.characterController.getCharacterModelId().trim();
    if (!characterModelId) {
      return null;
    }

    const state: CharacterState = {
      clientId: this.clientId,
      environmentName: environmentName.trim(),
      characterModelId,
      position: serializeVector3(mesh.position),
      rotation: yawRadiansToWireQuaternion(this.characterController.getFacingYawRadians()),
      velocity: serializeVector3(this.characterController.getVelocity()),
      animationState: toMultiplayerAnimationStateToken(this.characterController.getCurrentState()),
      animationFrame: this.characterController.animationController.getNormalizedPlaybackPhase(),
      isJumping: this.characterController.getVelocity().y > 0.1,
      isBoosting:
        this.characterController.isBoosting() ||
        this.characterController.getBoostStatus() !== 'Ready',
      boostType: this.getBoostType(),
      boostTimeRemaining: this.characterController.getBoostTimeRemainingMs(),
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
  public createStateUpdate(
    timestamp: number,
    characterStates: CharacterState[]
  ): CharacterStateUpdate {
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
   * - Rotation (quaternion [x,y,z,w] wire format only)
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

    // Apply rotation (quaternions only)
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
   * Applies rotation quaternion to mesh
   */
  private static applyRotation(mesh: BABYLON.AbstractMesh, rotation: QuaternionSerializable): void {
    try {
      mesh.rotationQuaternion ??= new BABYLON.Quaternion(0, 0, 0, 1);
      mesh.rotationQuaternion.copyFrom(deserializeQuaternion(rotation));
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
    if (
      last.position !== undefined &&
      hasSignificantVector3Change(last.position, newState.position, 0.1)
    ) {
      return true;
    }

    if (
      last.rotation !== undefined &&
      hasSignificantQuaternionChange(last.rotation, newState.rotation, 0.05)
    ) {
      return true;
    }

    if (last.characterModelId !== newState.characterModelId) {
      return true;
    }

    if (last.environmentName !== newState.environmentName) {
      return true;
    }

    // Check animation state change
    if (last.animationState !== newState.animationState) {
      return true;
    }

    if (hasSignificantNumberChange(last.animationFrame ?? 0, newState.animationFrame, 0.04)) {
      return true;
    }

    // Check jump/boost state change
    if (last.isJumping !== newState.isJumping || last.isBoosting !== newState.isBoosting) {
      return true;
    }

    if (hasSignificantNumberChange(last.boostTimeRemaining ?? 0, newState.boostTimeRemaining, 40)) {
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
