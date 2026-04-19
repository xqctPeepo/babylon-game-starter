/**
 * Keys on scene.metadata so dev console + __babylon.logSceneStats() can show
 * which environment load and which character were last stamped.
 */
const META_ENV = 'babylon_game_starter_perfEnv';
const META_CHARACTER = 'babylon_game_starter_perfCharacter';
const META_AT = 'babylon_game_starter_perfAt';

let deferredScenePerfDevLogFlush: ((scene: BABYLON.Scene) => void) | undefined;

/**
 * SceneManager registers this so the first dev [ScenePerf] line can wait until
 * the playable character exists (env load completes before loadCharacterModel in index.ts).
 */
export function registerDeferredScenePerfDevLogFlush(fn: (scene: BABYLON.Scene) => void): void {
  deferredScenePerfDevLogFlush = fn;
}

export function tryFlushDeferredScenePerfDevLog(scene: BABYLON.Scene): void {
  deferredScenePerfDevLogFlush?.(scene);
}

export function stampScenePerfConsoleContext(
  scene: BABYLON.Scene,
  options: {
    readonly environmentName?: string;
    readonly characterName?: string;
    readonly loggedAtIso?: string;
  }
): void {
  const prev = scene.metadata;
  const bag =
    prev != null && typeof prev === 'object' && !Array.isArray(prev)
      ? { ...(prev as Record<string, unknown>) }
      : {};
  if (options.environmentName !== undefined) {
    bag[META_ENV] = options.environmentName;
  }
  if (options.characterName !== undefined) {
    bag[META_CHARACTER] = options.characterName;
  }
  if (options.loggedAtIso !== undefined) {
    bag[META_AT] = options.loggedAtIso;
  }
  scene.metadata = bag;
}

export function readScenePerfConsoleContext(scene: BABYLON.Scene): {
  readonly environmentName: string;
  readonly characterName: string;
} {
  const meta = scene.metadata;
  let environmentName = '(unknown)';
  let characterName = '(unknown)';
  if (meta != null && typeof meta === 'object' && !Array.isArray(meta)) {
    const bag = meta as Record<string, unknown>;
    const env = bag[META_ENV];
    if (typeof env === 'string' && env !== '') {
      environmentName = env;
    }
    const ch = bag[META_CHARACTER];
    if (typeof ch === 'string' && ch !== '') {
      characterName = ch;
    }
  }
  return { environmentName, characterName };
}
