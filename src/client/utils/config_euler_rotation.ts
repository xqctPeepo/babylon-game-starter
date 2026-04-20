// ============================================================================
// CONFIG EULER ROTATION — authoring-facing Euler only (asset JSON, spawn data)
// ============================================================================
//
// Multiplayer and runtime sync use **quaternions only** on the wire.
// Euler [x,y,z] radians exists here so configs stay human-readable for designers.

import type { QuaternionSerializable, Vector3Serializable } from '../types/multiplayer';

import { deserializeQuaternion, serializeQuaternion } from './multiplayer_serialization';

/** Config Euler ( Pitch→Yaw→Roll order ) → quaternion for runtime / GLB placement. */
export function eulerToQuaternion(euler: Vector3Serializable): QuaternionSerializable {
  const q = BABYLON.Quaternion.FromEulerAngles(euler[0], euler[1], euler[2]);
  return serializeQuaternion(q);
}

/** Optional: inspect quaternion as Euler in tooling — do not use for multiplayer payloads. */
export function quaternionToEuler(q: QuaternionSerializable): Vector3Serializable {
  const quat = deserializeQuaternion(q);
  const euler = quat.toEulerAnglesToRef(new BABYLON.Vector3());
  return [euler.x, euler.y, euler.z];
}

/** Validate config Euler triple before feeding `eulerToQuaternion`. */
export function isValidEulerAngles(euler: Vector3Serializable): boolean {
  const MAX_ANGLE = Math.PI * 2;
  return (
    Number.isFinite(euler[0]) &&
    Number.isFinite(euler[1]) &&
    Number.isFinite(euler[2]) &&
    Math.abs(euler[0]) <= MAX_ANGLE &&
    Math.abs(euler[1]) <= MAX_ANGLE &&
    Math.abs(euler[2]) <= MAX_ANGLE
  );
}
