// ============================================================================
// CHARACTER TYPE DEFINITIONS
// ============================================================================

import type { ItemEffectKind } from './config';
import type { CharacterController } from '../controllers/character_controller';

export type ItemEffect = Readonly<
  Record<ItemEffectKind, (characterController: CharacterController) => void>
>;

// Custom animation config: a named animation triggered by a specific key
export interface CustomAnimationConfig {
  /** Babylon `AnimationGroup.name` in the character GLB (all groups tagged on import for cache-safe playback). */
  readonly name: string;
  readonly key: string; // Keyboard key to trigger (e.g., "j", "d")
  readonly loop: boolean; // Whether the custom animation should loop when triggered
}

// Animation entries can be either standard strings or custom animation configs
export type AnimationEntry = string | CustomAnimationConfig;

export interface CharacterAnims {
  readonly idle: string;
  readonly walk: string;
  readonly jump: string;
  readonly [key: string]: AnimationEntry; // Allow custom animations with any key name
}

export interface Character {
  readonly name: string;
  readonly model: string;
  locked?: boolean; // Locked state - runtime state managed separately via CharacterLock utility
  readonly animations: CharacterAnims;
  readonly scale: number;
  readonly mass: number; // Physics mass for different character weights
  readonly height: number; // Character capsule height
  readonly radius: number; // Character capsule radius
  readonly speed: {
    readonly inAir: number;
    readonly onGround: number;
    readonly boostMultiplier: number;
  };
  readonly jumpHeight: number; // Jump height for physics calculations
  readonly rotationSpeed: number; // Rotation speed in radians
  readonly rotationSmoothing: number; // Rotation smoothing factor
  readonly animationBlend?: number; // Animation blend time in milliseconds, defaults to 400
  readonly jumpDelay?: number; // Jump animation delay in milliseconds, defaults to 100
  readonly friction?: number; // Character-specific friction coefficient (0.0-1.0), defaults to mass-adjusted calculation
}
