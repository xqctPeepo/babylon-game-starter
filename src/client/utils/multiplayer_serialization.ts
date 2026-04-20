// ============================================================================
// MULTIPLAYER SERIALIZATION UTILITIES
// ============================================================================

import type BABYLON from '@babylonjs/core';
import type { Vector3Serializable, ColorSerializable } from '../types/multiplayer';

/**
 * Serializable Quaternion as [x, y, z, w]
 */
export type QuaternionSerializable = [number, number, number, number];

/**
 * Serializes BABYLON.Vector3 to [x, y, z]
 */
export function serializeVector3(v: BABYLON.Vector3): Vector3Serializable {
  return [v.x, v.y, v.z];
}

/**
 * Deserializes [x, y, z] back to BABYLON.Vector3
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
 * Converts Euler angles [x, y, z] (in radians) to quaternion [x, y, z, w]
 * Order: applied as Pitch (X) -> Yaw (Y) -> Roll (Z)
 */
export function eulerToQuaternion(euler: Vector3Serializable): QuaternionSerializable {
  const q = BABYLON.Quaternion.FromEulerAngles(euler[0], euler[1], euler[2]);
  return serializeQuaternion(q);
}

/**
 * Converts quaternion [x, y, z, w] to Euler angles [x, y, z] (in radians)
 * Extracts Pitch (X), Yaw (Y), Roll (Z)
 */
export function quaternionToEuler(q: QuaternionSerializable): Vector3Serializable {
  const quat = deserializeQuaternion(q);
  const euler = quat.toEulerAnglesToRef(new BABYLON.Vector3());
  return [euler.x, euler.y, euler.z];
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
export function deserializeColor(
  c: ColorSerializable
): BABYLON.Color3 | BABYLON.Color4 {
  if (c.length === 4) {
    return deserializeColor4(c as [number, number, number, number]);
  }
  return deserializeColor3(c as [number, number, number]);
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
export function distanceSquaredV3(
  a: Vector3Serializable,
  b: Vector3Serializable
): number {
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

  for (let i = 0; i < from.length; i++) {
    result.push(from[i] + (to[i] - from[i]) * clamped);
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
  const maxLen = Math.max(3, c.length);
  for (let i = 0; i < maxLen; i++) {
    if (c[i] < 0 || c[i] > 1) {
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
 * Validates all Euler angle components are within valid range [-2π, 2π]
 */
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
export function hasSignificantNumberChange(
  oldN: number,
  newN: number,
  threshold = 0.01
): boolean {
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

