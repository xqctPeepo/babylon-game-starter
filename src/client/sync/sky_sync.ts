// ============================================================================
// SKY EFFECTS STATE SYNC MODULE
// ============================================================================

import { ThrottledFunction } from '../utils/multiplayer_serialization';

import type { SkyEffectState, SkyEffectStateUpdate } from '../types/multiplayer';

/**
 * Tracks and detects sky effect state changes for synchronization
 */
export class SkySync {
  private effects: SkyEffectState[] = [];
  private throttle: ThrottledFunction;

  constructor(throttleMs = 100) {
    this.throttle = new ThrottledFunction(throttleMs);
  }

  /**
   * Adds or updates sky effect
   */
  public updateEffect(state: SkyEffectState): void {
    // Replace existing effect of same type, or add new one
    const index = this.effects.findIndex((e) => e.effectType === state.effectType);
    if (index >= 0) {
      this.effects[index] = state;
    } else {
      this.effects.push(state);
    }
  }

  /**
   * Removes sky effect
   */
  public removeEffect(effectType: string): void {
    this.effects = this.effects.filter((e) => e.effectType !== effectType);
  }

  /**
   * Creates state update
   */
  public createStateUpdate(timestamp: number): SkyEffectStateUpdate | null {
    if (!this.throttle.shouldCall()) {
      return null;
    }

    if (this.effects.length === 0) {
      return null;
    }

    return {
      updates: [...this.effects],
      timestamp
    };
  }

  /**
   * Gets all active effects
   */
  public getActiveEffects(): SkyEffectState[] {
    return [...this.effects];
  }

  /**
   * Clears all effects
   */
  public clearAll(): void {
    this.effects = [];
  }
}
