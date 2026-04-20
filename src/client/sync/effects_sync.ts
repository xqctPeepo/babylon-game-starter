// ============================================================================
// EFFECTS STATE SYNC MODULE
// ============================================================================

import { ThrottledFunction } from '../utils/multiplayer_serialization';

import type {
  ParticleEffectState,
  EnvironmentParticleState,
  EffectStateUpdate
} from '../types/multiplayer';

/**
 * Tracks and detects particle effect state changes for synchronization
 */
export class EffectsSync {
  private particleEffects = new Map<string, ParticleEffectState>();
  private environmentParticles = new Map<string, EnvironmentParticleState>();
  private throttle: ThrottledFunction;

  constructor(throttleMs = 100) {
    this.throttle = new ThrottledFunction(throttleMs);
  }

  /**
   * Updates particle effect state
   */
  public updateParticleEffect(state: ParticleEffectState): void {
    this.particleEffects.set(state.effectId, state);
  }

  /**
   * Updates environment particle state
   */
  public updateEnvironmentParticle(state: EnvironmentParticleState): void {
    this.environmentParticles.set(state.name, state);
  }

  /**
   * Removes particle effect (when stopped)
   */
  public removeParticleEffect(effectId: string): void {
    this.particleEffects.delete(effectId);
  }

  /**
   * Removes environment particle
   */
  public removeEnvironmentParticle(name: string): void {
    this.environmentParticles.delete(name);
  }

  /**
   * Creates state update
   */
  public createStateUpdate(timestamp: number): EffectStateUpdate | null {
    if (!this.throttle.shouldCall()) {
      return null;
    }

    if (this.particleEffects.size === 0 && this.environmentParticles.size === 0) {
      return null;
    }

    return {
      particleEffects:
        this.particleEffects.size > 0 ? Array.from(this.particleEffects.values()) : undefined,
      environmentParticles:
        this.environmentParticles.size > 0
          ? Array.from(this.environmentParticles.values())
          : undefined,
      timestamp
    };
  }

  /**
   * Gets all active effects
   */
  public getActiveEffects(): {
    particleEffects: ParticleEffectState[];
    environmentParticles: EnvironmentParticleState[];
  } {
    return {
      particleEffects: Array.from(this.particleEffects.values()),
      environmentParticles: Array.from(this.environmentParticles.values())
    };
  }

  /**
   * Clears all effects (for scene switch)
   */
  public clearAll(): void {
    this.particleEffects.clear();
    this.environmentParticles.clear();
  }
}
