// ============================================================================
// MULTIPLAYER SYNCHRONIZED STATE TYPES
// ============================================================================

/**
 * Serializable Vector3 as [x, y, z]
 */
export type Vector3Serializable = [number, number, number];

/**
 * Serializable unit quaternion [x, y, z, w] — **only** wire format for rotation in multiplayer payloads.
 */
export type QuaternionSerializable = [number, number, number, number];

/**
 * Serializable Color3/Color4 as [r, g, b] or [r, g, b, a]
 */
export type ColorSerializable = [number, number, number] | [number, number, number, number];

/**
 * Client multiplayer state
 */
export interface MultiplayerClientState {
  readonly clientId: string;
  /** Updated in place when `synchronizer-changed` patch-signals arrive. */
  isSynchronizer: boolean;
  readonly sessionStarted: string; // ISO timestamp
  readonly environment: string; // Current environment name
  readonly character: string; // Current character name
}

/**
 * Join response from server (JSON matches Go `JoinResponse` snake_case tags).
 */
export interface JoinResponse {
  readonly client_id: string;
  readonly is_synchronizer: boolean;
  readonly existing_clients: number;
  /** Session token for SSE auth (`GET /api/multiplayer/stream?sid=…`). */
  readonly session_id: string;
}

// ============================================================================
// CHARACTER SYNCHRONIZATION
// ============================================================================

export interface CharacterState {
  readonly clientId: string;
  /** `ASSETS.ENVIRONMENTS[].name` for the peer’s loaded scene; must match viewer’s env to show proxies. */
  readonly environmentName: string;
  /** Stable asset key for the loaded character (e.g. ASSETS.CHARACTERS[].name); BGS-MP-SYNC §5.1.1 */
  readonly characterModelId: string;
  readonly position: Vector3Serializable;
  readonly rotation: QuaternionSerializable;
  readonly velocity: Vector3Serializable;
  /** Semantic locomotion token: idle | walk | run | jump | fall (BGS-MP-SYNC §5.1.1) */
  readonly animationState: string;
  /** Normalized playback phase in [0, 1] for the active clip (BGS-MP-SYNC §5.1.1) */
  readonly animationFrame: number;
  readonly isJumping: boolean;
  readonly isBoosting: boolean;
  readonly boostType?: 'superJump' | 'invisibility';
  /** Milliseconds remaining for timed boost effects; 0 when inactive (BGS-MP-SYNC §5.1.1) */
  readonly boostTimeRemaining: number; // ms
  readonly timestamp: number; // client sample time, unix ms
}

// ============================================================================
// ITEM SYNCHRONIZATION
// ============================================================================

export interface ItemInstanceState {
  readonly instanceId: string;
  readonly itemName: string;
  readonly position: Vector3Serializable;
  readonly rotation: QuaternionSerializable;
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
