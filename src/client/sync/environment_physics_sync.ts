// ============================================================================
// ENVIRONMENT PHYSICS SYNC — replicate dynamic physicsObjects (Level Test cubes)
// ============================================================================

import { ASSETS } from '../config/assets';

import { deserializeQuaternion, meshRotationToWireQuaternion } from '../utils/multiplayer_serialization';

import { clampCoordComponent, coerceQuaternion, coerceWorldVector3 } from './multiplayer_wire_guards';

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

function velocityFromPhysicsBody(mesh: BABYLON.AbstractMesh): [number, number, number] {
  const node = mesh as BABYLON.TransformNode & {
    physicsBody?: BABYLON.PhysicsBody;
  };
  const body = node.physicsBody;
  if (!body || body.isDisposed) {
    return [0, 0, 0];
  }
  try {
    const v = body.getLinearVelocity();
    return [
      clampCoordComponent(v.x),
      clampCoordComponent(v.y),
      clampCoordComponent(v.z)
    ];
  } catch {
    return [0, 0, 0];
  }
}

/**
 * Builds serializable snapshots for configured environment physics meshes (mass > 0).
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

    let wx: number;
    let wy: number;
    let wz: number;
    try {
      if (mesh.getAbsolutePosition) {
        const p = mesh.getAbsolutePosition();
        wx = p.x;
        wy = p.y;
        wz = p.z;
      } else {
        wx = mesh.absolutePosition.x;
        wy = mesh.absolutePosition.y;
        wz = mesh.absolutePosition.z;
      }
    } catch {
      continue;
    }

    const pos: [number, number, number] = [
      clampCoordComponent(wx),
      clampCoordComponent(wy),
      clampCoordComponent(wz)
    ];

    out.push({
      instanceId: makeEnvironmentPhysicsInstanceId(environmentName, po.name),
      itemName: ENV_PHYSICS_ITEM_MARKER,
      position: pos,
      rotation: meshRotationToWireQuaternion(mesh),
      velocity: velocityFromPhysicsBody(mesh),
      isCollected: false,
      timestamp: ts
    });
  }

  return out;
}

/**
 * Applies authoritative transform/velocity onto a replicated environment body.
 * Synchronizer skips this path (does not apply its own echoed updates).
 */
export function applyRemoteEnvironmentPhysicsState(
  scene: BABYLON.Scene,
  currentEnvironmentName: string,
  state: ItemInstanceState
): void {
  try {
    if (!scene || scene.isDisposed === true) {
      return;
    }
  } catch {
    return;
  }

  const posTri = coerceWorldVector3(state.position);
  const rotQ = coerceQuaternion(state.rotation);
  const velTri = coerceWorldVector3(state.velocity);
  if (!posTri || !rotQ || !velTri) {
    return;
  }

  if (state.itemName !== ENV_PHYSICS_ITEM_MARKER) {
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

  const pos = new BABYLON.Vector3(posTri[0], posTri[1], posTri[2]);
  const quat = deserializeQuaternion(rotQ);

  const node = mesh as BABYLON.TransformNode & {
    physicsBody?: BABYLON.PhysicsBody;
  };
  const body = node.physicsBody;

  if (body && !body.isDisposed) {
    try {
      body.setTargetTransform(pos, quat);
      body.setLinearVelocity(new BABYLON.Vector3(velTri[0], velTri[1], velTri[2]));
      body.setAngularVelocity(BABYLON.Vector3.Zero());
    } catch {
      /* Havok/plugin edge — skip frame */
    }
  } else {
    try {
      mesh.position.copyFrom(pos);
      mesh.rotationQuaternion ??= new BABYLON.Quaternion(0, 0, 0, 1);
      mesh.rotationQuaternion.copyFrom(quat);
    } catch {
      /* skip */
    }
  }
}
