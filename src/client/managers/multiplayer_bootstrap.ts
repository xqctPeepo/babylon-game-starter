// ============================================================================
// MULTIPLAYER BOOTSTRAP — join session, send sync (leader), show remote proxies
// ============================================================================

import { ASSETS } from '../config/assets';
import { CONFIG } from '../config/game_config';
import type { CharacterState, CharacterStateUpdate } from '../types/multiplayer';

import { getMultiplayerManager } from './multiplayer_manager';
import type { SceneManager } from './scene_manager';

const REMOTE_PREFIX = 'mp-remote-';
const SYNC_INTERVAL_MS = 80;

function vec3FromMesh(m: BABYLON.AbstractMesh): [number, number, number] {
  const p = m.position;
  return [p.x, p.y, p.z];
}

function rot3FromMesh(m: BABYLON.AbstractMesh): [number, number, number] {
  const r = m.rotation;
  return [r.x, r.y, r.z];
}

function vel3(ctrl: import('../controllers/character_controller').CharacterController): [number, number, number] {
  const v = ctrl.getVelocity();
  return [v.x, v.y, v.z];
}

function sampleLocalState(
  clientId: string,
  ctrl: import('../controllers/character_controller').CharacterController
): CharacterState | null {
  const mesh = ctrl.getPlayerMesh();
  if (!mesh || mesh.isDisposed()) {
    return null;
  }
  const vel = ctrl.getVelocity();
  return {
    clientId,
    position: vec3FromMesh(mesh),
    rotation: rot3FromMesh(mesh),
    velocity: vel3(ctrl),
    animationState: ctrl.getCurrentState(),
    animationFrame: 0,
    isJumping: vel.y > 0.12,
    isBoosting: ctrl.getBoostStatus() !== 'Ready',
    boostType: undefined,
    boostTimeRemaining: 0,
    timestamp: Date.now()
  };
}

async function waitForPlayableMesh(
  ctrl: import('../controllers/character_controller').CharacterController
): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const m = ctrl.getPlayerMesh();
    if (m && !m.isDisposed() && m.name === 'player') {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function ensureRemoteProxy(scene: BABYLON.Scene, clientId: string): BABYLON.Mesh {
  const name = `${REMOTE_PREFIX}${clientId}`;
  const existing = scene.getMeshByName(name) as BABYLON.Mesh | null;
  if (existing && !existing.isDisposed()) {
    return existing;
  }
  const box = BABYLON.MeshBuilder.CreateBox(name, { height: 1.2, width: 0.7, depth: 0.5 }, scene);
  const mat = new BABYLON.StandardMaterial(`${name}-mat`, scene);
  mat.diffuseColor = new BABYLON.Color3(0.95, 0.35, 0.65);
  mat.emissiveColor = new BABYLON.Color3(0.15, 0.05, 0.1);
  box.material = mat;
  box.isPickable = false;
  return box;
}

function applyRemoteState(scene: BABYLON.Scene, state: CharacterState): void {
  const mesh = ensureRemoteProxy(scene, state.clientId);
  mesh.position.set(state.position[0], state.position[1], state.position[2]);
  mesh.rotation.set(state.rotation[0], state.rotation[1], state.rotation[2]);
}

function removeRemoteProxy(scene: BABYLON.Scene, clientId: string): void {
  const m = scene.getMeshByName(`${REMOTE_PREFIX}${clientId}`) as BABYLON.Mesh | null;
  if (m && !m.isDisposed()) {
    m.dispose();
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

  const tabId =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('mp') ??
        `tab-${Math.random().toString(36).slice(2, 9)}`
      : `headless-${Date.now()}`;
  const defaultChar = ASSETS.CHARACTERS[0];
  const characterLabel = `${defaultChar?.name ?? 'player'}-${tabId}`;

  const mp = getMultiplayerManager();
  try {
    await mp.join(environmentName, characterLabel);
  } catch (e) {
    console.warn('[MultiplayerBootstrap] join skipped or failed:', e);
    return;
  }

  const scene = sceneManager.getScene();
  const clientId = mp.getClientID();
  if (!clientId) {
    return;
  }

  let lastSend = 0;

  const obs = scene.onBeforeRenderObservable.add(() => {
    if (!mp.isMultiplayerActive()) {
      return;
    }
    const now = performance.now();
    if (now - lastSend < SYNC_INTERVAL_MS) {
      return;
    }
    lastSend = now;
    const state = sampleLocalState(clientId, ctrl);
    if (!state) {
      return;
    }
    const update: CharacterStateUpdate = { updates: [state], timestamp: Date.now() };
    void mp.updateCharacterState(update);
  });

  const unsubState = mp.on('character-state-update', (raw: unknown) => {
    const msg = raw as CharacterStateUpdate;
    if (!msg?.updates?.length) {
      return;
    }
    for (const st of msg.updates) {
      if (st.clientId === clientId) {
        continue;
      }
      applyRemoteState(scene, st);
    }
  });

  const unsubLeft = mp.on('client-left', (raw: unknown) => {
    const id =
      raw && typeof raw === 'object' && 'clientId' in raw
        ? String((raw as { clientId: string }).clientId)
        : '';
    if (id) {
      removeRemoteProxy(scene, id);
    }
  });

  scene.onDisposeObservable.add(() => {
    scene.onBeforeRenderObservable.remove(obs);
    unsubState();
    unsubLeft();
  });
}
