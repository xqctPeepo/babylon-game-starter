// ============================================================================
// MULTIPLAYER BOOTSTRAP — join session, send sync (leader), show remote proxies
// ============================================================================

import { ASSETS } from '../config/assets';
import { CONFIG } from '../config/game_config';
import {
  applyRemoteConfiguredCollections,
  applyRemoteConfiguredItemState,
  envScopedInstanceId,
  parseEnvScopedInstanceId,
  sampleConfiguredItems
} from '../sync/configured_items_sync';
import {
  ENV_PHYSICS_ITEM_MARKER,
  applyRemoteEnvironmentPhysicsState,
  makeEnvironmentPhysicsInstanceId,
  meshNameFromEnvironmentInstanceId,
  sampleEnvironmentPhysicsStates,
  setEnvironmentPhysicsMeshKinematic
} from '../sync/environment_physics_sync';
import { ItemAuthorityTracker } from '../sync/item_authority_tracker';
import { ItemSync } from '../sync/item_sync';
import {
  coerceCharacterState,
  coerceItemInstanceState
} from '../sync/multiplayer_wire_guards';
import {
  ProximityClaimObserver,
  type ProximityItem
} from '../sync/proximity_claim_observer';
import { yawRadiansToWireQuaternion, toMultiplayerAnimationStateToken } from '../utils/multiplayer_serialization';

import { CollectiblesManager } from './collectibles_manager';
import { getMultiplayerManager } from './multiplayer_manager';
import {
  applyRemotePeerState,
  refreshRemotePeerVisibilityForLocalEnvironment,
  removeRemotePeer
} from './remote_peer_proxy';



import type { SceneManager } from './scene_manager';
import type { CharacterController } from '../controllers/character_controller';
import type {
  CharacterState,
  CharacterStateUpdate,
  ItemAuthorityChangedMessage,
  ItemCollectionEvent,
  ItemInstanceState,
  ItemStateUpdate
} from '../types/multiplayer';

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

  const authorityTracker = new ItemAuthorityTracker();

  /** Last `item-state-update` we applied; re-run on environment change for late-join alignment. */
  let lastAppliedItemSnapshot: ItemStateUpdate | null = null;

  const applyItemSnapshot = (msg: ItemStateUpdate): void => {
    const envName = sceneManager.getCurrentEnvironment();
    if (msg.updates?.length) {
      for (const rawSt of msg.updates) {
        const st = coerceItemInstanceState(rawSt);
        if (!st) {
          continue;
        }
        if (authorityTracker.isOwnedBySelf(st.instanceId)) {
          continue;
        }
        if (st.itemName === ENV_PHYSICS_ITEM_MARKER) {
          applyRemoteEnvironmentPhysicsState(scene, envName, st);
        } else {
          applyRemoteConfiguredItemState(envName, st);
        }
      }
    }
    if (msg.collections?.length) {
      applyRemoteConfiguredCollections(envName, msg.collections);
    }
  };

  const unsubItems = mp.on('item-state-update', (raw: unknown) => {
    const msg = raw as ItemStateUpdate;
    if (!msg || (!msg.updates?.length && !msg.collections?.length)) {
      return;
    }
    applyItemSnapshot(msg);
    lastAppliedItemSnapshot = msg;
  });

  const unsubAuthority = mp.on('item-authority-changed', (raw: unknown) => {
    const msg = raw as ItemAuthorityChangedMessage;
    if (!msg?.instanceId) {
      return;
    }
    authorityTracker.applyAuthorityChange(msg);
  });

  try {
    await mp.join(environmentName, characterModelId);
  } catch (e) {
    console.warn('[MultiplayerBootstrap] join skipped or failed:', e);
    unsubState();
    unsubLeft();
    unsubItems();
    unsubAuthority();
    return;
  }

  const clientId = mp.getClientID();
  if (!clientId) {
    unsubState();
    unsubLeft();
    unsubItems();
    unsubAuthority();
    return;
  }

  authorityTracker.setSelfClientId(clientId);

  const worldPhysicsItemSync = new ItemSync(WORLD_PHYS_SYNC_MS);
  let lastTrackedEnvironment = sceneManager.getCurrentEnvironment();
  let lastEnvironmentLoaded = sceneManager.isEnvironmentLoaded();
  /** When local scene changes only — remote proxies show/hide via cached peer state. */
  let lastPeerVisibilityEnv = '';

  /**
   * Feed every local collection into the world ItemSync so the broadcast includes
   * `collections` + keeps the item's `isCollected` flag true in its next updates snapshot.
   * Collections are first-write-wins on the server, so any client may publish — we do not
   * gate on base-synchronizer role here.
   */
  CollectiblesManager.onItemCollected = (
    localId: string,
    itemName: string,
    creditsEarned: number
  ): void => {
    const envName = sceneManager.getCurrentEnvironment();
    if (!envName) {
      return;
    }
    const instanceId = envScopedInstanceId(envName, localId);
    const ev: ItemCollectionEvent = {
      instanceId,
      itemName,
      collectedByClientId: clientId,
      creditsEarned,
      timestamp: Date.now()
    };
    worldPhysicsItemSync.recordCollection(ev);
    worldPhysicsItemSync.markItemCollected(instanceId, true);
  };

  const unsubSyncChanged = mp.on('synchronizer-changed', () => {
    if (mp.isSynchronizer()) {
      worldPhysicsItemSync.clearAll();
    }
  });

  // Per-item motion-type flip driven by the authority tracker. Each client keeps peer-owned
  // items kinematic (ANIMATED) so local Havok does not fight the authoritative
  // `setTargetTransform` updates, and flips its own items to DYNAMIC so collisions produce
  // real motion that the owner then broadcasts.
  const applyMotionTypeForInstance = (instanceId: string, dynamic: boolean): void => {
    const envNow = sceneManager.getCurrentEnvironment();
    const parsed = parseEnvScopedInstanceId(instanceId);
    if (parsed && parsed.envName === envNow) {
      CollectiblesManager.setItemKinematic(parsed.localId, !dynamic);
      return;
    }
    const meshName = meshNameFromEnvironmentInstanceId(envNow, instanceId);
    if (meshName) {
      setEnvironmentPhysicsMeshKinematic(scene, meshName, !dynamic);
    }
  };

  const unsubAuthorityChange = authorityTracker.onChange((evt) => {
    applyMotionTypeForInstance(evt.instanceId, evt.selfOwnsNow);
  });

  // ---- Proximity claim observer ----
  const claimCfg = CONFIG.MULTIPLAYER;
  const proximity = new ProximityClaimObserver(mp, authorityTracker, {
    claimRadiusMeters: claimCfg.CLAIM_RADIUS_METERS,
    claimGraceMs: claimCfg.CLAIM_GRACE_MS,
    getCharacterPosition: () => {
      const m = ctrl.getPlayerMesh();
      return m && !m.isDisposed() ? m.position : null;
    },
    shouldPause: () => !sceneManager.isEnvironmentLoaded()
  });

  const rebuildProximityItems = (envName: string): void => {
    if (!envName || !sceneManager.isEnvironmentLoaded()) {
      proximity.clear();
      return;
    }
    const items: ProximityItem[] = [];

    for (const [localId, entry] of CollectiblesManager.getPhysicsItemEntries()) {
      const instanceId = envScopedInstanceId(envName, localId);
      items.push({
        instanceId,
        getPosition: () => {
          const m = entry.mesh;
          if (!m || m.isDisposed()) {
            return null;
          }
          try {
            return m.getAbsolutePosition ? m.getAbsolutePosition() : m.absolutePosition;
          } catch {
            return null;
          }
        }
      });
    }

    const envCfg = ASSETS.ENVIRONMENTS.find((e) => e.name === envName);
    if (envCfg) {
      for (const po of envCfg.physicsObjects) {
        if (po.mass <= 0 || !po.name || po.name.trim() === '') {
          continue;
        }
        const instanceId = makeEnvironmentPhysicsInstanceId(envName, po.name);
        items.push({
          instanceId,
          getPosition: () => {
            const m = scene.getMeshByName(po.name);
            if (!m || m.isDisposed()) {
              return null;
            }
            try {
              return m.getAbsolutePosition ? m.getAbsolutePosition() : m.absolutePosition;
            } catch {
              return null;
            }
          }
        });
      }
    }

    proximity.setItems(items);
  };

  // Default every dynamic item in the current env to kinematic. The tracker flips back to
  // DYNAMIC on per-item ownership changes.
  const seedMotionTypesForEnv = (envName: string): void => {
    if (!envName || !sceneManager.isEnvironmentLoaded()) {
      return;
    }
    for (const [localId] of CollectiblesManager.getPhysicsItemEntries()) {
      const instanceId = envScopedInstanceId(envName, localId);
      const dyn = authorityTracker.isOwnedBySelf(instanceId);
      CollectiblesManager.setItemKinematic(localId, !dyn);
    }
    const envCfg = ASSETS.ENVIRONMENTS.find((e) => e.name === envName);
    if (envCfg) {
      for (const po of envCfg.physicsObjects) {
        if (po.mass <= 0 || !po.name) {
          continue;
        }
        const instanceId = makeEnvironmentPhysicsInstanceId(envName, po.name);
        const dyn = authorityTracker.isOwnedBySelf(instanceId);
        setEnvironmentPhysicsMeshKinematic(scene, po.name, !dyn);
      }
    }
  };

  // ---- Sample gate: publish only rows this client is authorized to publish ----
  const includeRow = (st: ItemInstanceState): boolean => {
    if (authorityTracker.isOwnedBySelf(st.instanceId)) {
      return true;
    }
    if (authorityTracker.isUnowned(st.instanceId) && mp.isSynchronizer()) {
      return true;
    }
    return false;
  };

  let lastSend = 0;

  const obs = scene.onBeforeRenderObservable.add(() => {
    if (!mp.isMultiplayerActive()) {
      return;
    }

    const envNow = sceneManager.getCurrentEnvironment();
    const envLoadedNow = sceneManager.isEnvironmentLoaded();
    if (envNow !== lastTrackedEnvironment) {
      lastTrackedEnvironment = envNow;
      worldPhysicsItemSync.clearAll();
      proximity.clear();
      lastEnvironmentLoaded = envLoadedNow;
      if (envLoadedNow) {
        seedMotionTypesForEnv(envNow);
        rebuildProximityItems(envNow);
      }
    } else if (envLoadedNow && !lastEnvironmentLoaded) {
      // Environment finished (re)loading — re-apply last authoritative snapshot so a
      // late joiner immediately sees collected presents and repositioned cake.
      lastEnvironmentLoaded = true;
      if (lastAppliedItemSnapshot) {
        applyItemSnapshot(lastAppliedItemSnapshot);
      }
      seedMotionTypesForEnv(envNow);
      rebuildProximityItems(envNow);
    } else {
      lastEnvironmentLoaded = envLoadedNow;
    }

    if (envNow !== lastPeerVisibilityEnv) {
      lastPeerVisibilityEnv = envNow;
      refreshRemotePeerVisibilityForLocalEnvironment(scene, envNow);
    }

    if (envLoadedNow) {
      proximity.tick();

      const physStates = sampleEnvironmentPhysicsStates(scene, envNow);
      for (const st of physStates) {
        if (includeRow(st)) {
          worldPhysicsItemSync.updateItemState(st);
        }
      }
      const itemStates = sampleConfiguredItems(envNow);
      for (const st of itemStates) {
        if (st.isCollected) {
          worldPhysicsItemSync.updateItemState(st);
          continue;
        }
        if (includeRow(st)) {
          worldPhysicsItemSync.updateItemState(st);
        }
      }
      const worldUpdate = worldPhysicsItemSync.createStateUpdate(Date.now());
      if (worldUpdate && ((worldUpdate.updates?.length ?? 0) > 0 || (worldUpdate.collections?.length ?? 0) > 0)) {
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
    unsubAuthority();
    unsubSyncChanged();
    unsubAuthorityChange();
    proximity.clear();
    if (CollectiblesManager.onItemCollected) {
      CollectiblesManager.onItemCollected = null;
    }
  });
}
