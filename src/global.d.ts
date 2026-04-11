/// <reference types="babylonjs" />
/// <reference types="babylonjs-loaders" />
/// <reference types="babylonjs-materials" />

declare global {
	var HK: unknown;
	var HavokPhysics: (() => Promise<unknown>) | undefined;
}

export {};





