// ============================================================================
// MULTIPLAYER WIRE GUARDS — validate/coerce SSE & REST payloads defensively
// ============================================================================

import { normalizeQuaternion } from '../utils/multiplayer_serialization';

import type {
  CharacterState,
  ItemInstanceState,
  QuaternionSerializable
} from '../types/multiplayer';

/** World-space limits (meters); rejects absurd/grief payloads before Havok sees them. */
export const MAX_ABS_WORLD_COORD = 5e6;

export function clampCoordComponent(n: number): number {
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.max(-MAX_ABS_WORLD_COORD, Math.min(MAX_ABS_WORLD_COORD, n));
}

/** Position or linear velocity in world units (clamped). */
export function coerceWorldVector3(raw: unknown): [number, number, number] | null {
  if (!Array.isArray(raw) || raw.length !== 3) {
    return null;
  }
  const a = Number(raw[0]);
  const b = Number(raw[1]);
  const c = Number(raw[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) {
    return null;
  }
  return [clampCoordComponent(a), clampCoordComponent(b), clampCoordComponent(c)];
}

/** @deprecated alias — world-space triplets (position / velocity). */
export function coerceTriplet(raw: unknown): [number, number, number] | null {
  return coerceWorldVector3(raw);
}

/**
 * Wire rotation for **character sync only**: unit quaternion [x, y, z, w].
 * Item rotation is not a separate field on the wire — items carry a single 4x4 world
 * matrix (Invariant M in [MULTIPLAYER_SYNCH.md §5.2](../../../MULTIPLAYER_SYNCH.md#52-item-state)).
 */
export function coerceQuaternion(raw: unknown): QuaternionSerializable | null {
  if (!Array.isArray(raw) || raw.length !== 4) {
    return null;
  }
  const x = Number(raw[0]);
  const y = Number(raw[1]);
  const z = Number(raw[2]);
  const w = Number(raw[3]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(w)) {
    return null;
  }
  return normalizeQuaternion([x, y, z, w]);
}

/**
 * Coerce the item-wire `matrix` field per Invariant M. Requires an array of length exactly 16
 * with finite, per-component-clampable entries. Returns the clamped array on success, `null`
 * on any failure (length mismatch, non-finite component). Callers MUST drop rows that return
 * `null`.
 */
export function coerceMatrix16(raw: unknown): readonly number[] | null {
  if (!Array.isArray(raw) || raw.length !== 16) {
    return null;
  }
  const out = new Array<number>(16);
  for (let i = 0; i < 16; i++) {
    const v = Number(raw[i]);
    if (!Number.isFinite(v)) {
      return null;
    }
    out[i] = clampCoordComponent(v);
  }
  return out;
}

export function coerceItemInstanceState(raw: unknown): ItemInstanceState | null {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const o = raw as Record<string, unknown>;
  const instanceId = typeof o.instanceId === 'string' ? o.instanceId.trim() : '';
  const itemName = typeof o.itemName === 'string' ? o.itemName.trim() : '';
  if (!instanceId || !itemName) {
    return null;
  }

  const isCollected = Boolean(o.isCollected);
  const matrix = coerceMatrix16(o.matrix);
  // Invariant M: a live (non-collected) row MUST carry a valid 16-float matrix.
  // Collection-only rows (isCollected=true) are tolerated without a matrix because
  // the receiver hides the mesh and the transform is irrelevant.
  if (!matrix && !isCollected) {
    return null;
  }

  const tsNum = Number(o.timestamp);
  const timestamp = Number.isFinite(tsNum) ? tsNum : Date.now();

  let collectedBy: string | undefined;
  if (typeof o.collectedByClientId === 'string' && o.collectedByClientId.trim() !== '') {
    collectedBy = o.collectedByClientId.trim();
  }

  let ownerClientId: string | null | undefined;
  if (typeof o.ownerClientId === 'string' && o.ownerClientId.trim() !== '') {
    ownerClientId = o.ownerClientId.trim();
  } else if (o.ownerClientId === null) {
    ownerClientId = null;
  }

  return {
    instanceId,
    itemName,
    matrix: matrix ?? [],
    isCollected,
    collectedByClientId: collectedBy,
    ownerClientId,
    timestamp
  };
}

export function coerceCharacterState(raw: unknown): CharacterState | null {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const o = raw as Record<string, unknown>;
  const clientId = typeof o.clientId === 'string' ? o.clientId.trim() : '';
  if (!clientId) {
    return null;
  }

  let characterModelId = typeof o.characterModelId === 'string' ? o.characterModelId.trim() : '';
  if (!characterModelId) {
    characterModelId = 'Red';
  }

  const environmentName =
    typeof o.environmentName === 'string' ? o.environmentName.trim() : '';

  const position = coerceWorldVector3(o.position);
  const rotation = coerceQuaternion(o.rotation);
  const velocity = coerceWorldVector3(o.velocity);
  if (!position || !rotation || !velocity) {
    return null;
  }

  let animationState = typeof o.animationState === 'string' ? o.animationState.trim() : '';
  if (!animationState) {
    animationState = 'idle';
  }

  const afNum = Number(o.animationFrame);
  const animationFrame =
    Number.isFinite(afNum) ? Math.min(1, Math.max(0, afNum)) : 0;

  const isJumping = Boolean(o.isJumping);
  const isBoosting = Boolean(o.isBoosting);

  let boostType: 'superJump' | 'invisibility' | undefined;
  if (o.boostType === 'superJump' || o.boostType === 'invisibility') {
    boostType = o.boostType;
  }

  const btNum = Number(o.boostTimeRemaining);
  const boostTimeRemaining = Number.isFinite(btNum) ? Math.max(0, btNum) : 0;

  const tsNum = Number(o.timestamp);
  const timestamp = Number.isFinite(tsNum) ? tsNum : Date.now();

  return {
    clientId,
    environmentName,
    characterModelId,
    position,
    rotation,
    velocity,
    animationState,
    animationFrame,
    isJumping,
    isBoosting,
    boostType,
    boostTimeRemaining,
    timestamp
  };
}
