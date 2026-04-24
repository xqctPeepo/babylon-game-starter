# Serialization quick reference

> [!TIP]
> For the full reference (pipeline diagrams, server-side validation rules, rationale), see [`SERIALIZATION_GUIDE.md`](SERIALIZATION_GUIDE.md). This page is a cheat-sheet for the common import + call patterns.

> [!IMPORTANT]
> **Item paths are pose-only.** Per Invariants P and E in [`MULTIPLAYER_SYNCH.md §5.2`](MULTIPLAYER_SYNCH.md#52-item-state), every `ItemInstanceState` row carries exactly `pos: readonly [number, number, number]` (world-space position) and `rot: readonly [number, number, number, number]` (unit quaternion `[x,y,z,w]`). No `matrix`, no Euler `rotation`, no `velocity`, and no `scale` on item paths. The Euler / quaternion serializers below are used by **character sync only**; item sync uses `sampleMeshPose` and `applyPoseToMesh` in [`src/client/utils/multiplayer_serialization.ts`](src/client/utils/multiplayer_serialization.ts).

## Contents

- [Quick start](#quick-start)
- [Wire formats](#wire-formats)
- [Import paths](#import-paths)
- [Bandwidth rough order](#bandwidth-rough-order)
- [Validation at a glance](#validation-at-a-glance)

## Quick start

### Character state

```typescript
const state = characterSync.sampleState(Date.now());
CharacterSync.applyRemoteCharacterState(remoteMesh, state);
```

### Item state (pose-only, Invariant P)

```typescript
const pose = sampleMeshPose(presentMesh); // { pos: [x,y,z], rot: [x,y,z,w] }
itemSync.updateItemState({
  instanceId: 'rv-life:present-1',
  itemName: 'present',
  pos: pose.pos,
  rot: pose.rot,
  isCollected: false,
  timestamp: Date.now(),
});

ItemSync.applyRemoteItemState(itemMesh, itemState);
```

### Light state

```typescript
lightsSync.updateLight({ lightType: 'POINT', position: [5, 10, 15], intensity: 1.0 });
LightsSync.applyRemoteLightState(babylonLight, lightState);
```

## Wire formats

| Type | Format | Example | Used by |
|------|--------|---------|---------|
| Vector3 | `[x, y, z]` | `[10.5, 5.2, -15.3]` | characters, effects, lights |
| Quaternion | `[x, y, z, w]` | `[0.1, 0.2, 0.3, 0.92]` | characters |
| Euler (radians) | `[x, y, z]` | `[0.1, 1.5, -0.2]` | characters (legacy; avoid on any new path) |
| Item pose | `{ pos: [x,y,z], rot: [x,y,z,w] }` | `{ pos: [10.5, 5.2, -15.3], rot: [0, 0.707, 0, 0.707] }` | **items / physics objects only** (Invariant P) |
| Color3 | `[r, g, b]` | `[1.0, 0.5, 0.2]` | all |
| Color4 | `[r, g, b, a]` | `[1.0, 0.5, 0.2, 0.8]` | all |

## Import paths

The repository does not configure a `@/` path alias; imports are always relative to the importing file. Examples below assume a caller in `src/client/**`.

### Serialization and deserialization helpers

```typescript
import {
  serializeVector3,
  serializeQuaternion,
  serializeColor3,
  deserializeVector3,
  deserializeQuaternion,
  deserializeColor3,
  eulerToQuaternion,
  quaternionToEuler,
  slerpQuaternion,
  sampleMeshPose,
  applyPoseToMesh,
} from '../utils/multiplayer_serialization';
```

### Validation helpers

```typescript
import {
  isFiniteVector3,
  isValidWorldPosition,
  isValidEulerAngles,
  isValidQuaternion,
  isValidColor,
  hasSignificantVector3Change,
  hasSignificantAngleChange,
  hasSignificantQuaternionChange,
} from '../utils/multiplayer_serialization';
```

### Mesh application entry points

```typescript
import { CharacterSync } from '../sync/character_sync';
import { ItemSync } from '../sync/item_sync';
import { LightsSync } from '../sync/lights_sync';

CharacterSync.applyRemoteCharacterState(mesh, characterState);
ItemSync.applyRemoteItemState(mesh, itemState);
LightsSync.applyRemoteLightState(light, lightState);
```

## Bandwidth rough order

| Entity | Update size | Frequency | Bandwidth per entity |
|--------|-------------|-----------|----------------------|
| Character | ~300 bytes | 10–20 Hz | 3–6 KB/s |
| Item | ~150 bytes | 1–5 Hz | 0.15–0.75 KB/s |
| Light | ~200 bytes | 1–5 Hz | 0.2–1 KB/s |
| Effect | ~100 bytes | 1–5 Hz | 0.1–0.5 KB/s |
| Sky | ~150 bytes | <1 Hz | <0.15 KB/s |

## Validation at a glance

| Stage | Check |
|-------|-------|
| Pre-serialize (client) | Finite; position within ±10000; Euler within `[-2π, 2π]`; color components in `[0, 1]`; timestamp within ±30 s |
| Server validation ([`src/server/multiplayer/utils.go`](src/server/multiplayer/utils.go)) | NaN / Infinity rejection; bounds check; quaternion normalization (length ≈ 1.0); enum validation (animation states); timestamp freshness |
| Mesh application | Quaternion-first (`mesh.rotationQuaternion` — never Euler on item paths); safe fallback to disable on error |

See [`SERIALIZATION_GUIDE.md`](SERIALIZATION_GUIDE.md) for the full rules, including error-scenario handling and interpolation strategy.
