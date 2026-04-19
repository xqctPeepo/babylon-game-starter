// ============================================================================
// SWITCH ENVIRONMENT UTILITY
// ============================================================================
// Provides globally accessible helper function for switching game environments
// ============================================================================

import { ASSETS } from '../config/assets';
import { AudioManager } from '../managers/audio_manager';
import { CutSceneManager } from '../managers/cut_scene_manager';
import { SettingsUI } from '../ui/settings_ui';

import type { CutScene } from '../types/environment';

/**
 * Switches to the specified environment by name
 * @param environmentName - The name of the environment to switch to
 * @returns Promise that resolves when the environment switch is complete
 */
export async function switchToEnvironment(environmentName: string): Promise<void> {
  // Validate environment name is provided and non-empty
  if (environmentName.length === 0) {
    return; // Silently ignore empty environment names
  }

  const foundEnv = ASSETS.ENVIRONMENTS.find((env) => env.name === environmentName);
  if (!foundEnv) {
    await SettingsUI.changeEnvironment(environmentName);
    return;
  }

  // Check if environment has a cutscene and play it before switching
  // Use bracket notation to access optional property (bypasses TypeScript union type issues from satisfies)
  const cutSceneProperty = foundEnv.cutScene;
  if (cutSceneProperty) {
    const cutSceneData = cutSceneProperty;

    // Verify cutScene structure matches CutScene interface
    if (
      typeof cutSceneData === 'object' &&
      cutSceneData !== null &&
      'type' in cutSceneData &&
      'visualUrl' in cutSceneData
    ) {
      const csType = cutSceneData.type;
      const csVisualUrl = cutSceneData.visualUrl;

      // Validate types using discriminated union check
      if ((csType === 'image' || csType === 'video') && typeof csVisualUrl === 'string') {
        // Get scene - required for cutscene playback
        const scene = SettingsUI.getScene();
        if (scene) {
          // Stop old background music before playing cutscene to avoid awkward fade after cutscene
          try {
            await AudioManager.stopAndDisposeBackgroundMusic(500);
          } catch {
            // Ignore errors stopping background music
          }

          // Construct valid CutScene from verified properties
          const cutScene: CutScene = {
            type: csType,
            visualUrl: csVisualUrl,
            audioUrl:
              'audioUrl' in cutSceneData && typeof cutSceneData.audioUrl === 'string'
                ? cutSceneData.audioUrl
                : undefined
          };
          // Play cutscene - ensure it completes before environment switch
          // Continue even if cutscene fails to prevent blocking environment switch
          try {
            await CutSceneManager.playCutScene(scene, cutScene);
          } catch {
            // Cutscene failed, continue with environment switch
          }
        }
      }
    }
  }

  // Delegate to SettingsUI.changeEnvironment which handles all the logic
  // including checking if SettingsUI is initialized
  // Skip cutscene since we already played it above
  await SettingsUI.changeEnvironment(environmentName, true);
}
