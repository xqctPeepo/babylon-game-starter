// ============================================================================
// REMOTE PEER VISUALS — GLB + thruster particles from CharacterState
// ============================================================================

import { ASSETS } from '../config/assets';
import { CONFIG } from '../config/game_config';
import { clampCoordComponent } from '../sync/multiplayer_wire_guards';
import { deserializeQuaternion } from '../utils/multiplayer_serialization';

import { NodeMaterialManager } from './node_material_manager';

import type { Character } from '../types/character';
import type { CharacterState } from '../types/multiplayer';

const REMOTE_ROOT_PREFIX = 'mp-remote-';

interface PeerEntry {
  readonly root: BABYLON.TransformNode;
  /** GLB root or fallback box — drives facing like local `playerMesh` (not `entry.root`). */
  visualRootMesh: BABYLON.AbstractMesh | null;
  modelId: string;
  loadSeq: number;
  particleSystem: BABYLON.IParticleSystem | null;
  remoteAnimationGroups: BABYLON.AnimationGroup[];
  desiredBoost: boolean;
  /** Normalized locomotion token last applied (idle | walk | run | jump | fall). */
  lastAnimationToken: string;
  /** Last received peer environment (`CharacterState.environmentName`). */
  remoteEnvironmentName: string;
  /** Viewer’s env on last apply (for async model load visibility). */
  lastLocalEnvironmentName: string;
  /** Last full state for refresh when only local environment changes. */
  lastState: CharacterState | null;
}

const peers = new Map<string, PeerEntry>();

function sameEnvironment(remote: string, local: string): boolean {
  const r = remote.trim();
  const l = local.trim();
  return r !== '' && l !== '' && r === l;
}

function disposePreviousVisuals(entry: PeerEntry): void {
  entry.visualRootMesh = null;
  entry.lastAnimationToken = '';
  for (const g of entry.remoteAnimationGroups) {
    g.dispose();
  }
  entry.remoteAnimationGroups = [];

  if (entry.particleSystem) {
    entry.particleSystem.dispose();
  }
  entry.particleSystem = null;

  for (const child of entry.root.getChildren()) {
    child.dispose();
  }
}

function createFallbackBox(entry: PeerEntry, clientId: string): void {
  const parent = entry.root;
  const box = BABYLON.MeshBuilder.CreateBox(
    `${REMOTE_ROOT_PREFIX}fallback-${clientId}`,
    { height: 1.2, width: 0.7, depth: 0.5 },
    parent.getScene()
  );
  box.parent = parent;
  const mat = new BABYLON.StandardMaterial(`${box.name}-mat`, parent.getScene());
  mat.diffuseColor = new BABYLON.Color3(0.95, 0.35, 0.65);
  mat.emissiveColor = new BABYLON.Color3(0.15, 0.05, 0.1);
  box.material = mat;
  box.isPickable = false;
  entry.visualRootMesh = box;
}

/** Shows or hides GLB + particles; stops animations/particles when hidden. */
function applyPeerVisualLayer(entry: PeerEntry): void {
  const active = sameEnvironment(entry.remoteEnvironmentName, entry.lastLocalEnvironmentName);
  try {
    entry.root.setEnabled(active);
  } catch {
    /* ignore */
  }

  const ps = entry.particleSystem;
  if (ps) {
    try {
      if (!active) {
        ps.stop();
      } else if (entry.desiredBoost) {
        ps.start();
      } else {
        ps.stop();
      }
    } catch {
      /* ignore */
    }
  }

  if (!active) {
    stopAllRemoteGroups(entry.remoteAnimationGroups);
    entry.lastAnimationToken = '';
  }
}

async function createThrusterParticles(
  scene: BABYLON.Scene,
  emitter: BABYLON.AbstractMesh
): Promise<BABYLON.IParticleSystem | null> {
  const snippet = CONFIG.EFFECTS.PARTICLE_SNIPPETS.find(
    (s) => s.name === CONFIG.EFFECTS.DEFAULT_PARTICLE
  );
  if (!snippet || snippet.type !== 'legacy') {
    return null;
  }
  try {
    const ps = await BABYLON.ParticleHelper.ParseFromSnippetAsync(snippet.snippetId, scene);
    ps.emitter = emitter;
    ps.stop();
    return ps;
  } catch {
    return null;
  }
}

async function importRemoteCharacter(
  scene: BABYLON.Scene,
  entry: PeerEntry,
  character: Character,
  clientId: string,
  token: number
): Promise<void> {
  disposePreviousVisuals(entry);

  NodeMaterialManager.initialize(scene);

  const result = await BABYLON.ImportMeshAsync(character.model, scene);
  if (token !== entry.loadSeq) {
    result.meshes.forEach((m) => {
      m.dispose();
    });
    result.animationGroups.forEach((g) => {
      g.dispose();
    });
    return;
  }

  await NodeMaterialManager.processImportResult(result);
  await scene.whenReadyAsync();

  /** Same root pick as {@link CharacterLoader.loadCharacter} (`meshes[0]`). */
  const rootMesh = result.meshes[0] ?? result.meshes.find((mesh) => !mesh.parent) ?? null;
  if (!rootMesh) {
    createFallbackBox(entry, clientId);
    applyPeerVisualLayer(entry);
    return;
  }

  rootMesh.name = `${REMOTE_ROOT_PREFIX}model-${clientId}`;
  /** Match {@link CharacterLoader}: asset scale on every mesh, then visual-root-only {@link CONFIG.ANIMATION.PLAYER_SCALE}. */
  result.meshes.forEach((mesh) => {
    mesh.scaling.setAll(character.scale);
  });
  rootMesh.parent = entry.root;
  rootMesh.scaling.setAll(CONFIG.ANIMATION.PLAYER_SCALE);

  entry.visualRootMesh = rootMesh;
  if (entry.lastState) {
    rootMesh.rotationQuaternion ??= new BABYLON.Quaternion(0, 0, 0, 1);
    rootMesh.rotationQuaternion.copyFrom(deserializeQuaternion(entry.lastState.rotation));
  }

  entry.remoteAnimationGroups = result.animationGroups.slice();

  const idleName = character.animations.idle;
  const idleGroup =
    result.animationGroups.find((a) => a.name === idleName) ??
    result.animationGroups.find((a) => a.name.toLowerCase().includes('idle'));

  const ps = await createThrusterParticles(scene, rootMesh);
  if (token !== entry.loadSeq) {
    ps?.dispose();
    return;
  }
  entry.particleSystem = ps;

  const active = sameEnvironment(entry.remoteEnvironmentName, entry.lastLocalEnvironmentName);
  if (active) {
    idleGroup?.start(true);
    if (entry.particleSystem) {
      if (entry.desiredBoost) {
        entry.particleSystem.start();
      } else {
        entry.particleSystem.stop();
      }
    }
  } else {
    idleGroup?.stop();
    entry.particleSystem?.stop();
  }

  applyPeerVisualLayer(entry);
}

async function scheduleModelLoad(
  scene: BABYLON.Scene,
  entry: PeerEntry,
  clientId: string,
  characterModelId: string,
  token: number
): Promise<void> {
  const character = ASSETS.CHARACTERS.find((c) => c.name === characterModelId);
  if (!character) {
    if (token !== entry.loadSeq) {
      return;
    }
    disposePreviousVisuals(entry);
    createFallbackBox(entry, clientId);
    applyPeerVisualLayer(entry);
    return;
  }

  try {
    await importRemoteCharacter(scene, entry, character, clientId, token);
  } catch {
    if (token !== entry.loadSeq) {
      return;
    }
    disposePreviousVisuals(entry);
    createFallbackBox(entry, clientId);
    applyPeerVisualLayer(entry);
  }
}

function ensurePeerRoot(scene: BABYLON.Scene, clientId: string): PeerEntry {
  let entry = peers.get(clientId);
  if (entry) {
    return entry;
  }
  const root = new BABYLON.TransformNode(`${REMOTE_ROOT_PREFIX}${clientId}`, scene);
  root.setEnabled(false);
  entry = {
    root,
    visualRootMesh: null,
    modelId: '',
    loadSeq: 0,
    particleSystem: null,
    remoteAnimationGroups: [],
    desiredBoost: false,
    lastAnimationToken: '',
    remoteEnvironmentName: '',
    lastLocalEnvironmentName: '',
    lastState: null
  };
  peers.set(clientId, entry);
  return entry;
}

function syncBoostVisual(entry: PeerEntry): void {
  const ps = entry.particleSystem;
  if (!ps) {
    return;
  }
  if (!sameEnvironment(entry.remoteEnvironmentName, entry.lastLocalEnvironmentName)) {
    ps.stop();
    return;
  }
  if (entry.desiredBoost) {
    ps.start();
  } else {
    ps.stop();
  }
}

function normalizeAnimToken(raw: string): string {
  return raw.trim().toLowerCase();
}

function clipNameForLocomotion(character: Character, tokenRaw: string): string {
  const token = normalizeAnimToken(tokenRaw);
  if (token === 'idle') {
    return character.animations.idle;
  }
  if (token === 'walk' || token === 'run') {
    return character.animations.walk;
  }
  if (token === 'jump' || token === 'fall') {
    return character.animations.jump;
  }
  return character.animations.idle;
}

function stopAllRemoteGroups(groups: BABYLON.AnimationGroup[]): void {
  for (const g of groups) {
    try {
      g.stop();
    } catch {
      /* ignore */
    }
  }
}

function syncRemoteLocomotion(entry: PeerEntry, state: CharacterState): void {
  const groups = entry.remoteAnimationGroups;
  if (!groups.length) {
    return;
  }

  const tokenNorm = normalizeAnimToken(state.animationState ?? 'idle');
  if (entry.lastAnimationToken === tokenNorm) {
    return;
  }

  const character = ASSETS.CHARACTERS.find((c) => c.name === state.characterModelId);
  if (!character) {
    return;
  }

  const clipName = clipNameForLocomotion(character, state.animationState ?? 'idle');
  const target =
    groups.find((g) => g.name === clipName) ??
    groups.find((g) => g.name.toLowerCase() === clipName.toLowerCase()) ??
    groups.find((g) => g.name.toLowerCase().includes(tokenNorm));

  stopAllRemoteGroups(groups);
  entry.lastAnimationToken = tokenNorm;

  if (target) {
    const loop = tokenNorm !== 'jump' && tokenNorm !== 'fall';
    try {
      target.start(loop, 1);
    } catch {
      /* disposed GLB edge */
    }
  } else {
    const idleName = character.animations.idle;
    const idle =
      groups.find((g) => g.name === idleName) ??
      groups.find((g) => g.name.toLowerCase().includes('idle'));
    try {
      idle?.start(true, 1);
    } catch {
      /* disposed GLB edge */
    }
  }
}

/**
 * Re-apply visibility for all remote peers when only the **local** scene changes
 * (same cached peer states, new local environment name).
 */
export function refreshRemotePeerVisibilityForLocalEnvironment(
  scene: BABYLON.Scene,
  localEnvironmentName: string
): void {
  try {
    if (!scene || scene.isDisposed) {
      return;
    }
  } catch {
    return;
  }

  const local = localEnvironmentName.trim();
  for (const entry of peers.values()) {
    entry.lastLocalEnvironmentName = local;
    applyPeerVisualLayer(entry);
    if (!sameEnvironment(entry.remoteEnvironmentName, entry.lastLocalEnvironmentName)) {
      continue;
    }
    if (entry.lastState) {
      syncBoostVisual(entry);
      syncRemoteLocomotion(entry, entry.lastState);
    }
  }
}

/**
 * Updates pose, character GLB (when `characterModelId` changes), and thruster particles from network state.
 * Peers are shown only when `state.environmentName` matches `localEnvironmentName`.
 */
export function applyRemotePeerState(
  scene: BABYLON.Scene,
  state: CharacterState,
  localEnvironmentName: string
): void {
  if (!state.clientId?.trim()) {
    return;
  }
  try {
    if (!scene || scene.isDisposed) {
      return;
    }
  } catch {
    return;
  }

  const entry = ensurePeerRoot(scene, state.clientId);

  entry.remoteEnvironmentName = state.environmentName.trim();
  entry.lastLocalEnvironmentName = localEnvironmentName.trim();
  entry.lastState = state;

  entry.root.position.set(
    clampCoordComponent(state.position[0]),
    clampCoordComponent(state.position[1]),
    clampCoordComponent(state.position[2])
  );
  /** World position only on parent — facing matches local `playerMesh` (yaw on visual root, not bind × parent). */
  entry.root.rotationQuaternion ??= new BABYLON.Quaternion(0, 0, 0, 1);
  entry.root.rotationQuaternion.copyFromFloats(0, 0, 0, 1);
  const rotTarget = entry.visualRootMesh ?? entry.root;
  rotTarget.rotationQuaternion ??= new BABYLON.Quaternion(0, 0, 0, 1);
  rotTarget.rotationQuaternion.copyFrom(deserializeQuaternion(state.rotation));

  entry.desiredBoost = state.isBoosting;

  if (entry.modelId !== state.characterModelId) {
    entry.lastAnimationToken = '';
    entry.modelId = state.characterModelId;
    entry.loadSeq++;
    const token = entry.loadSeq;
    void scheduleModelLoad(scene, entry, state.clientId, state.characterModelId, token);
    return;
  }

  applyPeerVisualLayer(entry);

  if (!sameEnvironment(entry.remoteEnvironmentName, entry.lastLocalEnvironmentName)) {
    return;
  }

  syncBoostVisual(entry);
  syncRemoteLocomotion(entry, state);
}

/** Removes remote peer meshes and clears tracking (call on `client-left`). */
export function removeRemotePeer(clientId: string): void {
  const entry = peers.get(clientId);
  if (!entry) {
    return;
  }
  disposePreviousVisuals(entry);
  entry.root.dispose();
  peers.delete(clientId);
}
