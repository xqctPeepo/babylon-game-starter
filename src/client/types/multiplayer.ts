// ============================================================================
// MULTIPLAYER SYNCHRONIZED STATE TYPES
// ============================================================================

import type BABYLON from '@babylonjs/core';

/**
 * Serializable Vector3 as [x, y, z]
 */
export type Vector3Serializable = [number, number, number];

/**
 * Serializable Color3/Color4 as [r, g, b] or [r, g, b, a]
 */
export type ColorSerializable = [number, number, number] | [number, number, number, number];

/**
 * Client multiplayer state
 */
export interface MultiplayerClientState {
  readonly clientId: string;
  readonly isSynchronizer: boolean;
  readonly sessionStarted: string; // ISO timestamp
  readonly environment: string; // Current environment name
  readonly character: string; // Current character name
}

/**
 * Join response from server
 */
export interface JoinResponse {
  readonly clientId: string;
  readonly isSynchronizer: boolean;
  readonly existingClients: number;
  readonly sessionId: string; // Session token for SSE auth
}

// ============================================================================
// CHARACTER SYNCHRONIZATION
// ============================================================================

export interface CharacterState {
  readonly clientId: string;
  readonly position: Vector3Serializable;
  readonly rotation: Vector3Serializable; // [x, y, z] in radians
  readonly velocity: Vector3Serializable;
  readonly animationState: string; // idle|walk|run|jump|fall
  readonly animationFrame: number; // 0-1 normalized
  readonly isJumping: boolean;
  readonly isBoosting: boolean;
  readonly boostType?: 'superJump' | 'invisibility';
  readonly boostTimeRemaining: number; // ms
  readonly timestamp: number; // server unix ms
}

// ============================================================================
// ITEM SYNCHRONIZATION
// ============================================================================

export interface ItemInstanceState {
  readonly instanceId: string;
  readonly itemName: string;
  readonly position: Vector3Serializable;
  readonly rotation: Vector3Serializable;
  readonly velocity: Vector3Serializable;
  readonly isCollected: boolean;
  readonly collectedByClientId?: string;
  readonly timestamp: number;
}

export interface ItemCollectionEvent {
  readonly instanceId: string;
  readonly itemName: string;
  readonly collectedByClientId: string;
  readonly creditsEarned: number;
  readonly timestamp: number;
}

// ============================================================================
// PARTICLE EFFECT SYNCHRONIZATION
// ============================================================================

export interface ParticleEffectState {
  readonly effectId: string;
  readonly snippetName: string;
  readonly position: Vector3Serializable;
  readonly isActive: boolean;
  readonly frameIndex?: number; // For deterministic playback
  readonly ownerClientId?: string;
  readonly timestamp: number;
}

export interface EnvironmentParticleState {
  readonly name: string; // Named environment particle from config
  readonly position: Vector3Serializable;
  readonly isActive: boolean;
  readonly timestamp: number;
}

// ============================================================================
// LIGHT SYNCHRONIZATION
// ============================================================================

export type LightType = 'POINT' | 'DIRECTIONAL' | 'SPOT' | 'HEMISPHERIC' | 'RECTANGULAR_AREA';

export interface LightState {
  readonly lightId: string;
  readonly lightType: LightType;
  readonly position?: Vector3Serializable;
  readonly direction?: Vector3Serializable;
  readonly diffuseColor: ColorSerializable;
  readonly intensity: number;
  readonly specularColor?: ColorSerializable;
  readonly range?: number; // Point lights
  readonly radius?: number; // Area lights
  readonly angle?: number; // Spot lights
  readonly exponent?: number; // Spot lights
  readonly isEnabled: boolean;
  readonly timestamp: number;
}

// ============================================================================
// SKY EFFECT SYNCHRONIZATION
// ============================================================================

export type SkyEffectType = 'base' | 'heatLightning' | 'colorBlend' | 'colorTint';

export interface SkyEffectState {
  readonly effectType: SkyEffectType;
  readonly isActive: boolean;
  readonly visibility?: number; // For heat lightning: 0-1
  readonly colorModifier?: ColorSerializable;
  readonly intensity?: number;
  readonly durationMs?: number;
  readonly elapsedMs?: number;
  readonly timestamp: number;
}

// ============================================================================
// BULK UPDATE MESSAGES
// ============================================================================

/**
 * Bulk character updates from synchronizer
 */
export interface CharacterStateUpdate {
  readonly updates: readonly CharacterState[];
  readonly timestamp: number;
}

/**
 * Bulk item updates from synchronizer
 */
export interface ItemStateUpdate {
  readonly updates: readonly ItemInstanceState[];
  readonly collections?: readonly ItemCollectionEvent[];
  readonly timestamp: number;
}

/**
 * Bulk particle effect updates from synchronizer
 */
export interface EffectStateUpdate {
  readonly particleEffects?: readonly ParticleEffectState[];
  readonly environmentParticles?: readonly EnvironmentParticleState[];
  readonly timestamp: number;
}

/**
 * Bulk light updates from synchronizer
 */
export interface LightStateUpdate {
  readonly updates: readonly LightState[];
  readonly timestamp: number;
}

/**
 * Bulk sky effect updates from synchronizer
 */
export interface SkyEffectStateUpdate {
  readonly updates: readonly SkyEffectState[];
  readonly timestamp: number;
}

// ============================================================================
// SERVER MESSAGES
// ============================================================================

/**
 * Synchronizer changed notification
 */
export interface SynchronizerChangedMessage {
  readonly newSynchronizerId: string;
  readonly reason: 'connection' | 'disconnection' | 'failover';
  readonly timestamp: number;
}

/**
 * Connection status update (join/leave notifications)
 */
export interface ClientConnectionEvent {
  readonly eventType: 'joined' | 'left';
  readonly clientId: string;
  readonly totalClients: number;
  readonly timestamp: number;
}

/**
 * Server error message
 */
export interface ServerErrorMessage {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly timestamp: number;
}

// ============================================================================
// CLIENT REQUEST TYPES
// ============================================================================

/**
 * Client environment switch notification
 */
export interface ClientEnvironmentSwitchRequest {
  readonly clientId: string;
  readonly previousEnvironment: string;
  readonly newEnvironment: string;
}

/**
 * Client character switch notification
 */
export interface ClientCharacterSwitchRequest {
  readonly clientId: string;
  readonly previousCharacter: string;
  readonly newCharacter: string;
}
