// ============================================================================
// CONFIGURATION TYPE DEFINITIONS
// ============================================================================

import type { ParticleSnippet, SoundEffect } from './effects';

export interface CharacterSpeed {
  readonly WALK: number;
  readonly RUN: number;
  readonly JUMP: number;
}

export interface CharacterConfig {
  readonly SPEED: CharacterSpeed;
  readonly CAPSULE_HEIGHT: number;
  readonly CAPSULE_RADIUS: number;
  readonly MASS: number;
  readonly FRICTION: number;
  readonly RESTITUTION: number;
  readonly ROTATION_SMOOTHING: number;
  readonly ANIMATION_BLEND: number;
  readonly JUMP_DELAY: number;
}

export interface CameraConfig {
  readonly START_POSITION: BABYLON.Vector3;
  readonly OFFSET: BABYLON.Vector3;
  readonly DRAG_SENSITIVITY: number;
  readonly ZOOM_MIN: number;
  readonly ZOOM_MAX: number;
  readonly FOLLOW_SMOOTHING: number;
}

export interface PhysicsConfig {
  readonly GRAVITY: BABYLON.Vector3;
  readonly CHARACTER_GRAVITY: BABYLON.Vector3;
}

export interface AnimationConfig {
  readonly PLAYER_SCALE: number;
  readonly PLAYER_Y_OFFSET: number;
}

export interface DebugConfig {
  readonly CAPSULE_VISIBLE: boolean;
}

/** Rendering / engine tuning (SceneOptimizer, WebGPU, camera). OpenPBR / IBL / SDF text are optional product choices when a measured need appears. */
export interface PerformanceConfig {
  /** Far clip plane for the main camera (smaller = better depth precision when safe). */
  readonly CAMERA_MAX_Z: number;
  /** Babylon SceneOptimizer: adaptive hardware scaling toward a target FPS. */
  readonly SCENE_OPTIMIZER_ENABLED: boolean;
  readonly SCENE_OPTIMIZER_TARGET_FPS: number;
  readonly SCENE_OPTIMIZER_TRACK_MS: number;
  /** Passed to HardwareScalingOptimization (max engine hardware scaling level). */
  readonly HARDWARE_SCALING_MAX: number;
  readonly HARDWARE_SCALING_STEP: number;
  /**
   * Prefer WebGPUEngine when the browser exposes WebGPU; falls back to WebGL Engine.
   * Default off: some scenes still hit WebGPU material/bind-group edge cases; enable when validated.
   */
  readonly WEBGPU_WHEN_AVAILABLE: boolean;
}

export interface MultiplayerConfig {
  readonly ENABLED: boolean;
  readonly PRODUCTION_SERVER: string; // e.g., 'bgs-mp.onrender.com'
  readonly LOCAL_SERVER: string; // e.g., 'localhost:5000'
  readonly CONNECTION_TIMEOUT_MS: number; // Max time to wait for connection
  readonly PRODUCTION_FIRST: boolean; // Try production server before local
}

export interface GameConfig {
  readonly CHARACTER: CharacterConfig;
  readonly CAMERA: CameraConfig;
  readonly PHYSICS: PhysicsConfig;
  readonly ANIMATION: AnimationConfig;
  readonly DEBUG: DebugConfig;
  readonly PERFORMANCE: PerformanceConfig;
  readonly EFFECTS: EffectsConfig;
  readonly HUD: HUDConfig;
  readonly SETTINGS: SettingsConfig;
  readonly INVENTORY: InventoryConfig;
  readonly MULTIPLAYER: MultiplayerConfig;
}

// Forward declarations for circular dependencies
export interface EffectsConfig {
  readonly PARTICLE_SNIPPETS: readonly ParticleSnippet[];
  readonly DEFAULT_PARTICLE: string;
  readonly AUTO_SPAWN: boolean;
  readonly SOUND_EFFECTS: readonly SoundEffect[];
}

export interface HUDConfig {
  readonly POSITION: HUDPosition;
  readonly FONT_FAMILY: string;
  readonly PRIMARY_COLOR: string;
  readonly SECONDARY_COLOR: string;
  readonly HIGHLIGHT_COLOR: string;
  readonly BACKGROUND_COLOR: string;
  readonly BACKGROUND_OPACITY: number;
  readonly PADDING: number;
  readonly BORDER_RADIUS: number;
  readonly SHOW_COORDINATES: boolean;
  readonly SHOW_TIME: boolean;
  readonly SHOW_FPS: boolean;
  readonly SHOW_STATE: boolean;
  readonly SHOW_BOOST_STATUS: boolean;
  readonly SHOW_CREDITS: boolean;
  readonly UPDATE_INTERVAL: number;
  readonly MOBILE: {
    readonly SHOW_COORDINATES: boolean;
    readonly SHOW_TIME: boolean;
    readonly SHOW_FPS: boolean;
    readonly SHOW_STATE: boolean;
    readonly SHOW_BOOST_STATUS: boolean;
    readonly SHOW_CREDITS: boolean;
  };
  readonly IPadWithKeyboard: {
    readonly SHOW_COORDINATES: boolean;
    readonly SHOW_TIME: boolean;
    readonly SHOW_FPS: boolean;
    readonly SHOW_STATE: boolean;
    readonly SHOW_BOOST_STATUS: boolean;
    readonly SHOW_CREDITS: boolean;
  };
}

export type HUDPosition = 'top' | 'bottom' | 'left' | 'right';

export interface SettingsConfig {
  readonly HEADING_TEXT: string;
  readonly PANEL_WIDTH_RATIO: number;
  readonly FULL_SCREEN_THRESHOLD: number;
  readonly Z_INDEX: number;
  readonly BUTTON_Z_INDEX: number;
  readonly SECTIONS: readonly SettingsSection[];
}

export interface SettingsSection {
  readonly title: string;
  readonly uiElement: UIElementType;
  readonly visibility: VisibilityType;
  readonly defaultValue?: boolean | string;
  readonly options?: string[];
  readonly onChange?: (_value: boolean | string) => void | Promise<void>;
}

export type UIElementType = 'toggle' | 'dropdown';
export type VisibilityType = 'all' | 'mobile' | 'iPadWithKeyboard';

export interface InventoryConfig {
  readonly HEADING_TEXT: string;
  readonly PANEL_WIDTH_RATIO: number;
  readonly FULL_SCREEN_THRESHOLD: number;
  readonly Z_INDEX: number;
  readonly BUTTON_Z_INDEX: number;
  readonly TILES: readonly Tile[];
}

export interface Tile {
  readonly title: string;
  readonly thumbnail: string;
  readonly minSize: number;
  readonly maxSize: number;
  readonly count: number;
  readonly itemEffectKind: ItemEffectKind;
}

export type ItemEffectKind = 'superJump' | 'invisibility' | 'gamma';
