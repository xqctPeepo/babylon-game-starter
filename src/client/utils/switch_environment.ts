// ============================================================================
// SWITCH ENVIRONMENT UTILITY
// ============================================================================
// Provides globally accessible helper function for switching game environments
// ============================================================================

import { SettingsUI } from '../ui/settings_ui';

/**
 * Switches to the specified environment by name.
 *
 * Multiplayer env-switch propagation (MULTIPLAYER_SYNCH.md §4.8) is handled inside
 * {@link SettingsUI.changeEnvironment} — the single chokepoint every env-change path
 * funnels through (portal triggers, the in-game settings dropdown, and the
 * `environment_lock` fallback). Keeping the PATCH emission there guarantees any future
 * caller that bypasses this utility still notifies the server.
 *
 * @param environmentName - The name of the environment to switch to
 * @returns Promise that resolves when the environment switch is complete
 */
export async function switchToEnvironment(environmentName: string): Promise<void> {
  // Validate environment name is provided and non-empty
  if (environmentName.length === 0) {
    return; // Silently ignore empty environment names
  }

  // Cutscene (including concurrent vs sequential) is handled inside SettingsUI.changeEnvironment
  await SettingsUI.changeEnvironment(environmentName, false);
}
