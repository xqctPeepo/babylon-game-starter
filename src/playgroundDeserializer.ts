/**
 * Playground Deserializer
 * Handles parsing and deserialization of BabylonJS playground JSON format
 */

import * as BABYLON from '@babylonjs/core';

export interface PlaygroundData {
    engine: string;
    version: number;
    [key: string]: any;
}

/**
 * Deserializes playground.json file data
 * The playground data may be base64 encoded or contain encoded snippets
 * @param playgroundJson - The raw playground.json as string or object
 * @returns Deserialized playground data
 */
export function deserializePlayground(playgroundJson: any): PlaygroundData {
    // If it's a string, parse it as JSON
    if (typeof playgroundJson === 'string') {
        try {
            playgroundJson = JSON.parse(playgroundJson);
        } catch (e) {
            console.error('Failed to parse playground JSON:', e);
            throw new Error('Invalid playground JSON format');
        }
    }

    // Validate basic structure
    if (!playgroundJson || typeof playgroundJson !== 'object') {
        throw new Error('Playground data must be a valid object');
    }

    // Extract and decode main source code if base64 encoded
    let playgroundData: PlaygroundData = { ...playgroundJson };

    // Check if there's a code property that's base64 encoded
    if (playgroundData.code && typeof playgroundData.code === 'string') {
        try {
            const decodedCode = atob(playgroundData.code);
            playgroundData.code = decodedCode;
        } catch (e) {
            // If decoding fails, assume it's already decoded
            console.warn('Could not decode code property, assuming it is already decoded');
        }
    }

    // Check if main content is base64 encoded
    if (playgroundData.main && typeof playgroundData.main === 'string' && playgroundData.main.length > 0) {
        try {
            // Try to decode if it looks like base64
            if (isBase64(playgroundData.main)) {
                const decodedMain = atob(playgroundData.main);
                playgroundData.main = decodedMain;
            }
        } catch (e) {
            console.warn('Could not decode main property');
        }
    }

    // Parse the playground data structure
    if (playgroundData.main && typeof playgroundData.main === 'string') {
        try {
            const parsedMain = JSON.parse(playgroundData.main);
            playgroundData.playgroundContent = parsedMain;
        } catch (e) {
            // Main might be raw code, not JSON
            console.warn('Main is not JSON, treating as raw code');
        }
    }

    return playgroundData;
}

/**
 * Checks if a string appears to be base64 encoded
 * @param str - String to check
 * @returns True if string appears to be base64
 */
function isBase64(str: string): boolean {
    try {
        return btoa(atob(str)) === str;
    } catch (err) {
        return false;
    }
}

/**
 * Loads playground.json from file
 * @param filePath - Path to playground.json
 * @returns Promise resolving to deserialized playground data
 */
export async function loadPlayground(filePath: string): Promise<PlaygroundData> {
    try {
        const response = await fetch(filePath);
        if (!response.ok) {
            throw new Error(`Failed to load playground: ${response.statusText}`);
        }
        const json = await response.json();
        return deserializePlayground(json);
    } catch (error) {
        console.error('Error loading playground:', error);
        throw error;
    }
}

/**
 * Creates a BabylonJS scene from playground data
 * This is a simplified implementation that handles the basic scene structure
 * @param engine - BabylonJS engine instance
 * @param playgroundData - Deserialized playground data
 * @returns Promise resolving to created BABYLON.Scene
 */
export async function createSceneFromPlayground(
    engine: BABYLON.Engine,
    playgroundData: PlaygroundData
): Promise<BABYLON.Scene> {
    // Create a basic scene
    const scene = new BABYLON.Scene(engine);

    // Set scene properties if available
    if (playgroundData.playgroundContent) {
        const content = playgroundData.playgroundContent;

        // Apply scene gravity if specified
        if (content.gravity && Array.isArray(content.gravity)) {
            scene.gravity = new BABYLON.Vector3(content.gravity[0], content.gravity[1], content.gravity[2]);
        }

        // Apply scene properties
        if (content.clearColor && Array.isArray(content.clearColor)) {
            scene.clearColor = new BABYLON.Color4(
                content.clearColor[0],
                content.clearColor[1],
                content.clearColor[2],
                content.clearColor[3] ?? 1
            );
        }
    }

    // If there's executable code, we would need to evaluate it in a safe manner
    // For now, we'll create a minimal scene that can be extended
    if (!scene.activeCamera) {
        const camera = new BABYLON.ArcRotateCamera('camera', -Math.PI / 2, Math.PI / 2, 20, new BABYLON.Vector3(0, 0, 0), scene);
        camera.attachControl(engine.getRenderingCanvas() as HTMLCanvasElement, true);
    }

    // Add basic lighting
    if (scene.lights.length === 0) {
        new BABYLON.HemisphericLight('light', new BABYLON.Vector3(1, 1, 0), scene);
    }

    return scene;
}
