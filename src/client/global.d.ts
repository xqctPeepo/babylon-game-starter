/// <reference types="babylonjs" />
/// <reference types="babylonjs-loaders" />
/// <reference types="babylonjs-materials" />

type BabylonAudioEngine =
  import('@babylonjs/core/AudioV2/abstractAudio/audioEngineV2').AudioEngineV2;
type CameraManagerGlobal = typeof import('./managers/camera_manager').CameraManager;
type ScenePerformanceStatsExport = import('./utils/scene_performance_stats').ScenePerformanceStats;
type BabylonDebugApi = {
  BABYLON: typeof globalThis.BABYLON;
  engine: () => BABYLON.Engine | null;
  scene: () => BABYLON.Scene | null;
  logSceneStats: () => ScenePerformanceStatsExport | undefined;
};

declare global {
  var HK: unknown;
  var HavokPhysics: (() => Promise<unknown>) | undefined;
  var __babylonAudioEngine: BabylonAudioEngine | undefined;

  interface Window {
    __babylon?: BabylonDebugApi;
    CameraManager?: CameraManagerGlobal;
  }
}

export {};
