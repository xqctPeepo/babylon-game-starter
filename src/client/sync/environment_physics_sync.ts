// ============================================================================
// ENVIRONMENT PHYSICS SYNC — replicate dynamic physicsObjects (Level Test cubes)
// ============================================================================
//
// Replicates transforms/velocities for `environment.physicsObjects` with mass > 0. Under the
// hybrid authority model these are **per-item authority** — each instance is owned by at most
// one client at a time and only its owner may publish rows. See MULTIPLAYER_SYNCH.md:
//   - §4.7 Item authority lifecycle
//     (../../../MULTIPLAYER_SYNCH.md#47-item-authority-lifecycle)
//   - §7.5 Item authority authorization
//     (../../../MULTIPLAYER_SYNCH.md#75-item-authority-authorization)
//
// `setEnvironmentPhysicsKinematic()` flips bodies between ANIMATED (kinematic, receivers) and
// DYNAMIC (owner). A future per-item tracker will flip each body independently; today's
// blanket non-synchronizer flip is a coarser approximation of the same invariant.

import { ASSETS } from '../config/assets';
import {
  applyMatrixToBody,
  applyMatrixToMesh,
  sampleWorldMatrix
} from '../utils/multiplayer_serialization';

import type { ItemInstanceState } from '../types/multiplayer';

/** `ItemInstanceState.itemName` marker so clients route updates to meshes, not collectibles. */
export const ENV_PHYSICS_ITEM_MARKER = '__env_physics__';

export function makeEnvironmentPhysicsInstanceId(
  environmentName: string,
  meshName: string
): string {
  return `${environmentName}::${meshName}`;
}

export function meshNameFromEnvironmentInstanceId(
  environmentName: string,
  instanceId: string
): string | null {
  const prefix = `${environmentName}::`;
  if (!instanceId.startsWith(prefix)) {
    return null;
  }
  const rest = instanceId.slice(prefix.length);
  return rest.trim() !== '' ? rest : null;
}

/**
 * Builds serializable snapshots for configured environment physics meshes (mass > 0).
 * Each row carries exactly one transform field: a 16-float row-major world matrix
 * (Invariant M; no Euler, no separate velocity — see MULTIPLAYER_SYNCH.md §5.2).
 */
export function sampleEnvironmentPhysicsStates(
  scene: BABYLON.Scene,
  environmentName: string
): ItemInstanceState[] {
  const env = ASSETS.ENVIRONMENTS.find((e) => e.name === environmentName);
  if (!env || environmentName.trim() === '') {
    return [];
  }

  const ts = Date.now();
  const out: ItemInstanceState[] = [];

  for (const po of env.physicsObjects) {
    if (po.mass <= 0 || !po.name || po.name.trim() === '') {
      continue;
    }
    const mesh = scene.getMeshByName(po.name);
    if (!mesh || mesh.isDisposed()) {
      continue;
    }

    out.push({
      instanceId: makeEnvironmentPhysicsInstanceId(environmentName, po.name),
      itemName: ENV_PHYSICS_ITEM_MARKER,
      matrix: sampleWorldMatrix(mesh),
      isCollected: false,
      timestamp: ts
    });
  }

  return out;
}

/**
 * Applies an authoritative 4x4 world-matrix snapshot onto a replicated environment body.
 * Per MULTIPLAYER_SYNCH.md §4.7 (non-owner kinematic invariant) and Invariants M/E, the
 * receiver decomposes the matrix and calls `body.setTargetTransform(pos, quat)`. It MUST
 * NOT call `setLinearVelocity` / `setAngularVelocity` — non-owner bodies are ANIMATED.
 * Synchronizer skips this path (does not apply its own echoed updates).
 */
export function applyRemoteEnvironmentPhysicsState(
  scene: BABYLON.Scene,
  currentEnvironmentName: string,
  state: ItemInstanceState
): void {
  try {
    if (!scene || scene.isDisposed) {
      return;
    }
  } catch {
    return;
  }

  if (state.itemName !== ENV_PHYSICS_ITEM_MARKER) {
    return;
  }

  if (!Array.isArray(state.matrix) || state.matrix.length !== 16) {
    return;
  }

  const meshName = meshNameFromEnvironmentInstanceId(currentEnvironmentName, state.instanceId);
  if (!meshName) {
    return;
  }

  const mesh = scene.getMeshByName(meshName);
  if (!mesh || mesh.isDisposed()) {
    return;
  }

  const node = mesh as BABYLON.TransformNode & {
    physicsBody?: BABYLON.PhysicsBody;
  };
  const body = node.physicsBody;

  try {
    if (body && !body.isDisposed) {
      applyMatrixToBody(body, state.matrix);
    } else {
      applyMatrixToMesh(mesh, state.matrix);
    }
  } catch {
    /* Havok/plugin edge — skip frame */
  }
}

/**
 * Flips every `env.physicsObjects` mesh (mass > 0) between kinematic (`ANIMATED`) and
 * dynamic (`DYNAMIC`) motion types.
 *
 * Non-synchronizer clients set `kinematic=true` so Havok does not fight the authoritative
 * `setTargetTransform` updates from the synchronizer (prevents gravity / local collisions
 * from knocking replicated bodies around between 120ms snapshots). On promotion to
 * synchronizer, callers flip back to `kinematic=false` to resume the authoritative sim.
 */
/**
 * Flips a single environment physics mesh's motion type. Used by the per-item authority
 * pipeline so a dynamic mesh is kinematic on non-owners and dynamic on the owner.
 * Returns true on a successful flip (or no-op when already in the requested state).
 */
export function setEnvironmentPhysicsMeshKinematic(
  scene: BABYLON.Scene,
  meshName: string,
  kinematic: boolean
): boolean {
  if (!meshName || meshName.trim() === '') {
    return false;
  }
  const mesh = scene.getMeshByName(meshName);
  if (!mesh || mesh.isDisposed()) {
    return false;
  }
  const node = mesh as BABYLON.TransformNode & { physicsBody?: BABYLON.PhysicsBody };
  const body = node.physicsBody;
  if (!body || body.isDisposed) {
    return false;
  }
  const motionType = kinematic
    ? BABYLON.PhysicsMotionType.ANIMATED
    : BABYLON.PhysicsMotionType.DYNAMIC;
  try {
    if (body.getMotionType() !== motionType) {
      body.setMotionType(motionType);
    }
    if (kinematic) {
      body.setLinearVelocity(BABYLON.Vector3.Zero());
      body.setAngularVelocity(BABYLON.Vector3.Zero());
    }
    return true;
  } catch {
    return false;
  }
}

export function setEnvironmentPhysicsKinematic(
  scene: BABYLON.Scene,
  environmentName: string,
  kinematic: boolean
): void {
  const env = ASSETS.ENVIRONMENTS.find((e) => e.name === environmentName);
  if (!env) {
    return;
  }

  const motionType = kinematic
    ? BABYLON.PhysicsMotionType.ANIMATED
    : BABYLON.PhysicsMotionType.DYNAMIC;

  for (const po of env.physicsObjects) {
    if (po.mass <= 0 || !po.name || po.name.trim() === '') {
      continue;
    }
    const mesh = scene.getMeshByName(po.name);
    if (!mesh || mesh.isDisposed()) {
      continue;
    }
    const node = mesh as BABYLON.TransformNode & { physicsBody?: BABYLON.PhysicsBody };
    const body = node.physicsBody;
    if (!body || body.isDisposed) {
      continue;
    }
    try {
      if (body.getMotionType() !== motionType) {
        body.setMotionType(motionType);
      }
      if (kinematic) {
        body.setLinearVelocity(BABYLON.Vector3.Zero());
        body.setAngularVelocity(BABYLON.Vector3.Zero());
      }
    } catch {
      /* Havok edge cases — retry next frame */
    }
  }
}
