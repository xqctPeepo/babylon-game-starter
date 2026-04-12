/// <reference types="babylonjs" />
/// <reference types="babylonjs-loaders" />
/// <reference types="babylonjs-materials" />

type BabylonAudioEngine = import('@babylonjs/core/AudioV2/abstractAudio/audioEngineV2').AudioEngineV2;
type CameraManagerGlobal = typeof import('./managers/CameraManager').CameraManager;
type BabylonDebugApi = {
	BABYLON: typeof globalThis.BABYLON;
	engine: () => BABYLON.Engine | null;
	scene: () => BABYLON.Scene | null;
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





