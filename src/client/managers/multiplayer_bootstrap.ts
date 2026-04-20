// ============================================================================
// MULTIPLAYER BOOTSTRAP — join session, send sync (leader), show remote proxies
// ============================================================================

import { ASSETS } from '../config/assets';
import { CONFIG } from '../config/game_config';
import { yawRadiansToWireQuaternion, toMultiplayerAnimationStateToken } from '../utils/multiplayer_serialization';

import {
  coerceCharacterState,
  coerceItemInstanceState
} from '../sync/multiplayer_wire_guards';
import { getMultiplayerManager } from './multiplayer_manager';
import {
  applyRemotePeerState,
  refreshRemotePeerVisibilityForLocalEnvironment,
  removeRemotePeer
} from './remote_peer_proxy';
import {
  ENV_PHYSICS_ITEM_MARKER,
  applyRemoteEnvironmentPhysicsState,
  sampleEnvironmentPhysicsStates
} from '../sync/environment_physics_sync';
import { ItemSync } from '../sync/item_sync';

import type { SceneManager } from './scene_manager';
import type { CharacterController } from '../controllers/character_controller';
import type { CharacterState, CharacterStateUpdate, ItemStateUpdate } from '../types/multiplayer';

const SYNC_INTERVAL_MS = 80;
const WORLD_PHYS_SYNC_MS = 120;

function vec3FromMesh(m: BABYLON.AbstractMesh): [number, number, number] {
  const p = m.position;
  return [p.x, p.y, p.z];
}

function vel3(ctrl: CharacterController): [number, number, number] {
  const v = ctrl.getVelocity();
  return [v.x, v.y, v.z];
}

function deriveBoostType(ctrl: CharacterController): 'superJump' | 'invisibility' | undefined {
  const st = ctrl.getBoostStatus();
  if (st.includes('Super Jump')) {
    return 'superJump';
  }
  if (st.includes('Invisibility')) {
    return 'invisibility';
  }
  return undefined;
}

function sampleLocalState(
  clientId: string,
  ctrl: CharacterController,
  environmentName: string
): CharacterState | null {
  const mesh = ctrl.getPlayerMesh();
  if (!mesh || mesh.isDisposed()) {
    return null;
  }
  const characterModelId = ctrl.getCharacterModelId().trim();
  if (!characterModelId) {
    return null;
  }
  const vel = ctrl.getVelocity();
  return {
    clientId,
    environmentName: environmentName.trim(),
    characterModelId,
    position: vec3FromMesh(mesh),
    rotation: yawRadiansToWireQuaternion(ctrl.getFacingYawRadians()),
    velocity: vel3(ctrl),
    animationState: toMultiplayerAnimationStateToken(ctrl.getCurrentState()),
    animationFrame: ctrl.animationController.getNormalizedPlaybackPhase(),
    isJumping: vel.y > 0.12,
    isBoosting: ctrl.isBoosting() || ctrl.getBoostStatus() !== 'Ready',
    boostType: deriveBoostType(ctrl),
    boostTimeRemaining: ctrl.getBoostTimeRemainingMs(),
    timestamp: Date.now()
  };
}

async function waitForPlayableMesh(ctrl: CharacterController): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const m = ctrl.getPlayerMesh();
    if (m && !m.isDisposed() && m.name === 'player') {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * After the default environment + async character GLB load, joins multiplayer (if enabled),
 * streams each tab's local character pose (server broadcasts to everyone), and draws other clients as proxies.
 */
export async function initMultiplayerAfterCharacterReady(
  sceneManager: SceneManager,
  environmentName: string
): Promise<void> {
  if (!CONFIG.MULTIPLAYER.ENABLED) {
    return;
  }

  const ctrl = sceneManager.getCharacterController();
  if (!ctrl) {
    return;
  }

  await waitForPlayableMesh(ctrl);

  const defaultChar = ASSETS.CHARACTERS[0];
  const trimmedModelId = ctrl.getCharacterModelId().trim();
  const characterModelId = trimmedModelId !== '' ? trimmedModelId : (defaultChar?.name ?? 'player');

  const mp = getMultiplayerManager();
  const scene = sceneManager.getScene();

  /** Subscribe before join so SSE snapshot(s) sent on connect are not dropped. */
  const unsubState = mp.on('character-state-update', (raw: unknown) => {
    const myId = mp.getClientID();
    if (!myId) {
      return;
    }
    const msg = raw as CharacterStateUpdate;
    if (!msg?.updates?.length) {
      return;
    }
    for (const rawSt of msg.updates) {
      const st = coerceCharacterState(rawSt);
      if (!st || st.clientId === myId) {
        continue;
      }
      applyRemotePeerState(scene, st, sceneManager.getCurrentEnvironment());
    }
  });

  const unsubLeft = mp.on('client-left', (raw: unknown) => {
    let id = '';
    if (
      raw !== null &&
      typeof raw === 'object' &&
      'clientId' in raw &&
      typeof (raw as { clientId: unknown }).clientId === 'string'
    ) {
      id = (raw as { clientId: string }).clientId;
    }
    if (id) {
      removeRemotePeer(id);
    }
  });

  const unsubItems = mp.on('item-state-update', (raw: unknown) => {
    if (mp.isSynchronizer()) {
      return;
    }
    const msg = raw as ItemStateUpdate;
    if (!msg?.updates?.length) {
      return;
    }
    const envName = sceneManager.getCurrentEnvironment();
    for (const rawSt of msg.updates) {
      const st = coerceItemInstanceState(rawSt);
      if (!st || st.itemName !== ENV_PHYSICS_ITEM_MARKER) {
        continue;
      }
      applyRemoteEnvironmentPhysicsState(scene, envName, st);
    }
  });

  try {
    await mp.join(environmentName, characterModelId);
  } catch (e) {
    console.warn('[MultiplayerBootstrap] join skipped or failed:', e);
    unsubState();
    unsubLeft();
    unsubItems();
    return;
  }

  const clientId = mp.getClientID();
  if (!clientId) {
    unsubState();
    unsubLeft();
    unsubItems();
    return;
  }

  const worldPhysicsItemSync = new ItemSync(WORLD_PHYS_SYNC_MS);
  let lastTrackedEnvironment = sceneManager.getCurrentEnvironment();
  /** When local scene changes only — remote proxies show/hide via cached peer state. */
  let lastPeerVisibilityEnv = '';

  let lastSend = 0;

  const obs = scene.onBeforeRenderObservable.add(() => {
    if (!mp.isMultiplayerActive()) {
      return;
    }

    const envNow = sceneManager.getCurrentEnvironment();
    if (envNow !== lastTrackedEnvironment) {
      lastTrackedEnvironment = envNow;
      worldPhysicsItemSync.clearAll();
    }

    if (envNow !== lastPeerVisibilityEnv) {
      lastPeerVisibilityEnv = envNow;
      refreshRemotePeerVisibilityForLocalEnvironment(scene, envNow);
    }

    if (mp.isSynchronizer() && sceneManager.isEnvironmentLoaded()) {
      const physStates = sampleEnvironmentPhysicsStates(scene, envNow);
      for (const st of physStates) {
        worldPhysicsItemSync.updateItemState(st);
      }
      const worldUpdate = worldPhysicsItemSync.createStateUpdate(Date.now());
      if (worldUpdate?.updates?.length) {
        void mp.updateItemState(worldUpdate);
      }
    }

    const now = performance.now();
    if (now - lastSend < SYNC_INTERVAL_MS) {
      return;
    }
    lastSend = now;
    const state = sampleLocalState(clientId, ctrl, envNow);
    if (!state) {
      return;
    }
    const update: CharacterStateUpdate = { updates: [state], timestamp: Date.now() };
    void mp.updateCharacterState(update);
  });

  scene.onDisposeObservable.add(() => {
    scene.onBeforeRenderObservable.remove(obs);
    unsubState();
    unsubLeft();
    unsubItems();
  });
}
