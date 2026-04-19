/**
 * Minimal scene shape for inventory stats (works with global BABYLON.Scene).
 */
export interface ScenePerformanceStatsInput {
  readonly meshes: { readonly length: number };
  readonly lights: { readonly length: number };
  readonly particleSystems: { readonly length: number };
  readonly animationGroups: { readonly length: number };
  readonly skeletons: { readonly length: number };
  readonly materials: { readonly length: number };
  readonly textures: { readonly length: number };
  readonly transformNodes: { readonly length: number };
}

export interface ScenePerformanceStats {
  /** Present when stats were taken right after an environment load (or from console with stamped metadata). */
  readonly environmentName?: string;
  /** Playable character name at snapshot time (anim groups / skeletons depend on this). */
  readonly characterName?: string;
  /** ISO-8601 time when this snapshot was taken (disambiguates rapid switches in the console). */
  readonly loggedAtIso?: string;
  readonly meshCount: number;
  readonly lightCount: number;
  readonly particleSystemCount: number;
  readonly animationGroupCount: number;
  readonly skeletonCount: number;
  readonly materialCount: number;
  readonly textureCount: number;
  readonly transformNodeCount: number;
}

export interface CollectScenePerformanceStatsContext {
  readonly environmentName?: string;
  readonly characterName?: string;
  readonly loggedAtIso?: string;
}

/**
 * Lightweight scene inventory for profiling (Chrome Performance is still the source of truth for JS vs GPU).
 */
export function collectScenePerformanceStats(
  scene: ScenePerformanceStatsInput,
  context?: CollectScenePerformanceStatsContext
): ScenePerformanceStats {
  return {
    ...(context?.environmentName !== undefined && context.environmentName !== ''
      ? { environmentName: context.environmentName }
      : {}),
    ...(context?.loggedAtIso !== undefined && context.loggedAtIso !== ''
      ? { loggedAtIso: context.loggedAtIso }
      : {}),
    ...(context?.characterName !== undefined && context.characterName !== ''
      ? { characterName: context.characterName }
      : {}),
    meshCount: scene.meshes.length,
    lightCount: scene.lights.length,
    particleSystemCount: scene.particleSystems.length,
    animationGroupCount: scene.animationGroups.length,
    skeletonCount: scene.skeletons.length,
    materialCount: scene.materials.length,
    textureCount: scene.textures.length,
    transformNodeCount: scene.transformNodes.length
  };
}

export function formatScenePerformanceStats(stats: ScenePerformanceStats): string {
  const env =
    stats.environmentName !== undefined && stats.environmentName !== ''
      ? ` env=${JSON.stringify(stats.environmentName)}`
      : '';
  const at =
    stats.loggedAtIso !== undefined && stats.loggedAtIso !== ''
      ? ` at=${JSON.stringify(stats.loggedAtIso)}`
      : '';
  const character =
    stats.characterName !== undefined && stats.characterName !== ''
      ? ` character=${JSON.stringify(stats.characterName)}`
      : '';
  return `[ScenePerf]${env}${character}${at} meshes=${stats.meshCount} lights=${stats.lightCount} particles=${stats.particleSystemCount} animGroups=${stats.animationGroupCount} skeletons=${stats.skeletonCount} materials=${stats.materialCount} textures=${stats.textureCount} transformNodes=${stats.transformNodeCount}`;
}
