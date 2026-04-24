// ============================================================================
// LIGHTS STATE SYNC MODULE
// ============================================================================
//
// NOTE FOR PLAYGROUND CONTRIBUTORS:
// Do not add `import * as BABYLON from '@babylonjs/core'` to this file (or to
// any file under `exportRoots` in `scripts/generate-playground-json.mjs`).
// `BABYLON` is an ambient global throughout this project — see `PLAYGROUND.md`
// ("The ambient `BABYLON` global: never `import * as BABYLON`") for the full
// rationale. The smoke checker rejects that import in bundled files.

import { ThrottledFunction } from '../utils/multiplayer_serialization';

import type { LightState, LightStateUpdate } from '../types/multiplayer';

/**
 * Tracks and detects light state changes for synchronization
 */
export class LightsSync {
  private lights = new Map<string, LightState>();
  private throttle: ThrottledFunction;

  constructor(throttleMs = 100) {
    this.throttle = new ThrottledFunction(throttleMs);
  }

  /**
   * Updates light state
   */
  public updateLight(state: LightState): void {
    this.lights.set(state.lightId, state);
  }

  /**
   * Removes light (when disposed)
   */
  public removeLight(lightId: string): void {
    this.lights.delete(lightId);
  }

  /**
   * Creates state update
   */
  public createStateUpdate(timestamp: number): LightStateUpdate | null {
    if (!this.throttle.shouldCall()) {
      return null;
    }

    if (this.lights.size === 0) {
      return null;
    }

    return {
      updates: Array.from(this.lights.values()),
      timestamp
    };
  }

  /**
   * Gets all active lights
   */
  public getActiveLights(): LightState[] {
    return Array.from(this.lights.values());
  }

  /**
   * Applies remote light state to mesh/light object
   *
   * Applied properties (type-specific):
   * - All types: intensity, isEnabled, diffuse/specular colors
   * - POINT: position, range
   * - DIRECTIONAL: direction
   * - SPOT: position, direction, angle, exponent
   * - HEMISPHERIC: (no position needed, affects entire scene)
   * - RECTANGULAR_AREA: position, radius (if supported)
   */
  public static applyRemoteLightState(light: BABYLON.Light, state: LightState): void {
    if (!light) return;

    try {
      // Apply common light properties
      light.intensity = state.intensity;
      light.setEnabled(state.isEnabled);

      // Apply colors
      if (state.diffuseColor) {
        light.diffuse = new BABYLON.Color3(
          state.diffuseColor[0],
          state.diffuseColor[1],
          state.diffuseColor[2]
        );
      }

      if (state.specularColor) {
        light.specular = new BABYLON.Color3(
          state.specularColor[0],
          state.specularColor[1],
          state.specularColor[2]
        );
      }

      // Type-specific properties
      switch (state.lightType) {
        case 'POINT':
          if (light instanceof BABYLON.PointLight) {
            this.applyPointLightState(light, state);
          }
          break;

        case 'SPOT':
          if (light instanceof BABYLON.SpotLight) {
            this.applySpotLightState(light, state);
          }
          break;

        case 'DIRECTIONAL':
          if (light instanceof BABYLON.DirectionalLight) {
            this.applyDirectionalLightState(light, state);
          }
          break;

        case 'HEMISPHERIC':
          // Hemispheric lights don't have position/direction
          break;

        case 'RECTANGULAR_AREA':
          // Rectangular area lights treated as point lights with range
          if (light instanceof BABYLON.PointLight && state.position) {
            this.applyPointLightState(light, state);
          }
          break;
      }
    } catch (e) {
      console.warn('[LightsSync] Failed to apply light state:', e);
    }
  }

  /**
   * Applies point light specific state (position, range)
   */
  private static applyPointLightState(light: BABYLON.PointLight, state: LightState): void {
    if (state.position) {
      light.position.set(state.position[0], state.position[1], state.position[2]);
    }

    if (state.range !== undefined) {
      light.range = state.range;
    }
  }

  /**
   * Applies spot light specific state (position, direction, angle, exponent)
   */
  private static applySpotLightState(light: BABYLON.SpotLight, state: LightState): void {
    if (state.position) {
      light.position.set(state.position[0], state.position[1], state.position[2]);
    }

    if (state.direction) {
      light.direction.set(state.direction[0], state.direction[1], state.direction[2]);
    }

    if (state.angle !== undefined) {
      light.angle = state.angle;
    }

    if (state.exponent !== undefined) {
      light.exponent = state.exponent;
    }
  }

  /**
   * Applies directional light specific state (direction)
   */
  private static applyDirectionalLightState(
    light: BABYLON.DirectionalLight,
    state: LightState
  ): void {
    if (state.direction) {
      light.direction.set(state.direction[0], state.direction[1], state.direction[2]);
    }
  }

  /**
   * Clears all lights (for scene switch)
   */
  public clearAll(): void {
    this.lights.clear();
  }
}
