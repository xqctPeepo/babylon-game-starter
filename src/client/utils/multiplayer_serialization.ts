// ============================================================================
// MULTIPLAYER SERIALIZATION UTILITIES
// ============================================================================
//
// Rotation on the wire is **quaternion [x,y,z,w] only**. Euler angles appear only in
// asset/config authoring — see `config_euler_rotation.ts`.

import type {
  ColorSerializable,
  QuaternionSerializable,
  Vector3Serializable
} from '../types/multiplayer';

export type { QuaternionSerializable } from '../types/multiplayer';

/** Minimal vector shape so callers can pass global `BABYLON.Vector3` or ESM imports without duplicate-type clashes. */
interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Serializes a Babylon-like Vector3 to [x, y, z]
 */
export function serializeVector3(v: Vec3Like): Vector3Serializable {
  return [v.x, v.y, v.z];
}

/**
 * Deserializes [x, y, z] back to BABYLON.Vector3 (global namespace from babylonjs typings).
 */
export function deserializeVector3(v: Vector3Serializable): BABYLON.Vector3 {
  return new BABYLON.Vector3(v[0], v[1], v[2]);
}

/**
 * Serializes BABYLON.Quaternion to [x, y, z, w]
 * Standard order: x, y, z, w (not w, x, y, z)
 */
export function serializeQuaternion(q: BABYLON.Quaternion): QuaternionSerializable {
  return [q.x, q.y, q.z, q.w];
}

/**
 * Deserializes [x, y, z, w] back to BABYLON.Quaternion
 */
export function deserializeQuaternion(q: QuaternionSerializable): BABYLON.Quaternion {
  return new BABYLON.Quaternion(q[0], q[1], q[2], q[3]);
}

/**
 * Validates a quaternion is normalized (length ≈ 1.0)
 */
export function isValidQuaternion(q: QuaternionSerializable, tolerance = 0.01): boolean {
  const lengthSq = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
  return Math.abs(lengthSq - 1.0) < tolerance;
}

/**
 * Normalizes a quaternion to unit length
 */
export function normalizeQuaternion(q: QuaternionSerializable): QuaternionSerializable {
  const lengthSq = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
  if (lengthSq === 0) {
    return [0, 0, 0, 1]; // Identity quaternion
  }
  const length = Math.sqrt(lengthSq);
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

/**
 * Mesh transform → multiplayer wire quaternion [x,y,z,w].
 * Prefer `rotationQuaternion`; if absent, converts Babylon’s internal Euler (`rotation`) once — **not** the wire format (multiplayer payloads are **only** quaternions; Euler belongs in asset/config only).
 */
export function meshRotationToWireQuaternion(mesh: BABYLON.AbstractMesh): QuaternionSerializable {
  const q = mesh.rotationQuaternion
    ? mesh.rotationQuaternion
    : BABYLON.Quaternion.FromEulerAngles(mesh.rotation.x, mesh.rotation.y, mesh.rotation.z);
  return normalizeQuaternion(serializeQuaternion(q));
}

/**
 * Locomotion-facing yaw only — matches `CharacterController` capsule bearing.
 * Prefer this for multiplayer wire rotation so we never ship baked GLB root quaternions or
 * animation-posture drift from `playerMesh` after locomotion clips run.
 */
export function yawRadiansToWireQuaternion(yawRadians: number): QuaternionSerializable {
  const q = BABYLON.Quaternion.FromEulerAngles(0, yawRadians, 0);
  return normalizeQuaternion(serializeQuaternion(q));
}

/**
 * Spherical linear interpolation between two quaternions
 */
export function slerpQuaternion(
  from: QuaternionSerializable,
  to: QuaternionSerializable,
  t: number
): QuaternionSerializable {
  const clamped = clamp(t, 0, 1);
  const qFrom = deserializeQuaternion(from);
  const qTo = deserializeQuaternion(to);
  const result = BABYLON.Quaternion.Slerp(qFrom, qTo, clamped);
  return serializeQuaternion(result);
}

/**
 * Detects significant change in quaternion rotation
 * (threshold in radians, typically 0.05 for 2.9 degrees)
 */
export function hasSignificantQuaternionChange(
  oldQ: QuaternionSerializable,
  newQ: QuaternionSerializable,
  thresholdRadians = 0.05
): boolean {
  const qOld = deserializeQuaternion(oldQ);
  const qNew = deserializeQuaternion(newQ);

  // Calculate dot product to get angle between quaternions
  let dot = qOld.x * qNew.x + qOld.y * qNew.y + qOld.z * qNew.z + qOld.w * qNew.w;

  // Clamp dot product to valid range
  dot = clamp(Math.abs(dot), -1, 1);

  // Angular difference in radians
  const angleRadians = 2 * Math.acos(dot);

  return angleRadians > thresholdRadians;
}

/**
 * Serializes BABYLON.Color3 to [r, g, b]
 */
export function serializeColor3(c: BABYLON.Color3): ColorSerializable {
  return [c.r, c.g, c.b];
}

/**
 * Deserializes [r, g, b] back to BABYLON.Color3
 */
export function deserializeColor3(c: [number, number, number]): BABYLON.Color3 {
  return new BABYLON.Color3(c[0], c[1], c[2]);
}

/**
 * Serializes BABYLON.Color4 to [r, g, b, a]
 */
export function serializeColor4(c: BABYLON.Color4): ColorSerializable {
  return [c.r, c.g, c.b, c.a];
}

/**
 * Deserializes [r, g, b, a] back to BABYLON.Color4
 */
export function deserializeColor4(c: [number, number, number, number]): BABYLON.Color4 {
  return new BABYLON.Color4(c[0], c[1], c[2], c[3]);
}

/**
 * Normalizes a rotation angle to [0, 2π)
 */
export function normalizeAngle(angle: number): number {
  const TWO_PI = Math.PI * 2;
  const normalized = angle % TWO_PI;
  return normalized < 0 ? normalized + TWO_PI : normalized;
}

/**
 * Deserializes color (handles both Color3 and Color4 formats)
 */
export function deserializeColor(c: ColorSerializable): BABYLON.Color3 | BABYLON.Color4 {
  if (c.length === 4) {
    return deserializeColor4(c);
  }
  return deserializeColor3(c);
}

/**
 * Clamps a number between min and max
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Calculates squared distance for perf-critical comparisons (avoids sqrt)
 */
export function distanceSquaredV3(a: Vector3Serializable, b: Vector3Serializable): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Linearly interpolates between two Vector3s
 */
export function lerpVector3(
  from: Vector3Serializable,
  to: Vector3Serializable,
  t: number
): Vector3Serializable {
  const clamped = clamp(t, 0, 1);
  return [
    from[0] + (to[0] - from[0]) * clamped,
    from[1] + (to[1] - from[1]) * clamped,
    from[2] + (to[2] - from[2]) * clamped
  ];
}

/**
 * Linearly interpolates between two Colors
 */
export function lerpColor(
  from: ColorSerializable,
  to: ColorSerializable,
  t: number
): ColorSerializable {
  const clamped = clamp(t, 0, 1);
  const result: number[] = [];

  const n = Math.min(from.length, to.length);
  for (let i = 0; i < n; i++) {
    result.push(from[i]! + (to[i]! - from[i]!) * clamped);
  }

  return result as ColorSerializable;
}

/**
 * Converts milliseconds since epoch to ISO string
 */
export function timestampToISO(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Converts ISO string to milliseconds since epoch
 */
export function isoToTimestamp(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * Generates a unique ID for entities
 */
export function generateEntityId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Validates Vector3 is within reasonable world bounds
 */
export function isValidWorldPosition(v: Vector3Serializable, maxDistance = 10000): boolean {
  const distSq = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  return distSq <= maxDistance * maxDistance;
}

/**
 * Validates color component is in valid range [0, 1]
 */
export function isValidColor(c: ColorSerializable): boolean {
  for (let i = 0; i < c.length; i++) {
    const comp = c[i];
    if (comp === undefined || comp < 0 || comp > 1) {
      return false;
    }
  }
  return true;
}

/**
 * Validates Vector3 components are finite numbers
 */
export function isFiniteVector3(v: Vector3Serializable): boolean {
  return Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}

/**
 * Throttles function calls to a maximum frequency
 */
export class ThrottledFunction {
  private lastCallTime = 0;
  private throttleMs: number;

  constructor(throttleMs: number) {
    this.throttleMs = Math.max(0, throttleMs);
  }

  public shouldCall(): boolean {
    const now = Date.now();
    if (now - this.lastCallTime >= this.throttleMs) {
      this.lastCallTime = now;
      return true;
    }
    return false;
  }

  public reset(): void {
    this.lastCallTime = 0;
  }
}

/**
 * Detects significant change in Vector3 (useful for update throttling)
 */
export function hasSignificantVector3Change(
  oldV: Vector3Serializable,
  newV: Vector3Serializable,
  threshold = 0.01
): boolean {
  const threshold_sq = threshold * threshold;
  return distanceSquaredV3(oldV, newV) > threshold_sq;
}

/**
 * Detects significant change in number (e.g., animation frame)
 */
export function hasSignificantNumberChange(oldN: number, newN: number, threshold = 0.01): boolean {
  return Math.abs(oldN - newN) > threshold;
}

/**
 * Detects significant change in angle (handles wraparound)
 * threshold should be in radians (e.g., 0.05 ≈ 2.9 degrees)
 */
export function hasSignificantAngleChange(
  oldAngle: number,
  newAngle: number,
  threshold = 0.05
): boolean {
  let diff = newAngle - oldAngle;
  const PI = Math.PI;
  if (diff > PI) {
    diff -= 2 * PI;
  } else if (diff < -PI) {
    diff += 2 * PI;
  }
  return Math.abs(diff) > threshold;
}

/**
 * Maps gameplay `CharacterController#getCurrentState()` labels to BGS-MP-SYNC §5.1.1 semantic tokens.
 */
export function toMultiplayerAnimationStateToken(gameplayStateLabel: string): string {
  const locomotionMap: Record<string, string> = {
    Idle: 'idle',
    Walking: 'walk',
    Running: 'run',
    Jumping: 'jump',
    Falling: 'fall'
  };
  return locomotionMap[gameplayStateLabel] ?? gameplayStateLabel.toLowerCase();
}
