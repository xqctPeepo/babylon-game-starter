# Babylon Game Starter - Multiplayer Implementation Plan

## Overview
Transform babylon-game-starter into a multiplayer-capable game using **Datastar** for real-time state synchronization. The first connected client acts as the "synchronizer," broadcasting entity updates to all other clients.

---

## Architecture

### Server Architecture (Go with Datastar SDK)
- **Role**: Maintains ordered client collection and broadcast mechanism
- **Clients Storage**: `OrderedMap[clientId] -> ClientConnection`
- **State Sync Flow**:
  1. Synchronizer client detects entity changes
  2. Sends updates to server via Datastar
  3. Server validates and broadcasts to all clients
  4. Non-synchronizer clients apply received updates

### Client Architecture (TypeScript + Babylon.js)
- **Role Assignment**: On connection, server determines if client is synchronizer (first in ordered collection)
- **Synchronizer Role**: 
  - Detects entity state changes (characters, items, effects, lights, sky effects)
  - Broadcasts updates via Datastar PATCH messages
  - Authoritative on entity updates
- **Non-Synchronizer Role**:
  - Receives and applies updates from server
  - Cannot send entity updates (server rejects them)
  - Can send local input/actions

---

## Synchronized State Interfaces

### 1. Character Synchronization (`multiplayer/character_sync.ts`)
```typescript
interface CharacterState {
  clientId: string;                    // Owner of this character
  position: Vector3Serializable;       // World position
  rotation: Vector3Serializable;       // Y-axis rotation + tilt
  velocity: Vector3Serializable;       // Current momentum
  animationState: string;              // idle|walk|run|jump|fall
  animationFrame: number;              // Animation playhead
  isJumping: boolean;
  isBoosting: boolean;                 // Super jump or invisibility
  boostType?: 'superJump' | 'invisibility'; // If boosting
  boostTimeRemaining: number;          // Milliseconds
  timestamp: number;                   // Server timestamp (ms)
}
```

### 2. Item Synchronization (`multiplayer/item_sync.ts`)
```typescript
interface ItemInstanceState {
  instanceId: string;                  // Unique item instance
  itemName: string;                    // Reference to ItemConfig name
  position: Vector3Serializable;
  rotation: Vector3Serializable;
  velocity: Vector3Serializable;       // Physics velocity
  isCollected: boolean;
  collectedByClientId?: string;        // If collected
  timestamp: number;
}

interface ItemCollectionEvent {
  instanceId: string;
  collectedByClientId: string;
  creditsEarned: number;
  timestamp: number;
}
```

### 3. Particle Effect Synchronization (`multiplayer/effects_sync.ts`)
```typescript
interface ParticleEffectState {
  effectId: string;                    // Unique effect instance
  snippetName: string;                 // Reference to ParticleSnippet name
  position: Vector3Serializable;
  isActive: boolean;
  frameIndex?: number;                 // Playhead for deterministic effects
  ownerClientId?: string;              // If effect belongs to a character
  timestamp: number;
}

interface EnvironmentParticleState {
  name: string;                        // Named environment particle
  position: Vector3Serializable;
  isActive: boolean;
  timestamp: number;
}
```

### 4. Light Synchronization (`multiplayer/lights_sync.ts`)
```typescript
interface LightState {
  lightId: string;
  lightType: 'POINT' | 'DIRECTIONAL' | 'SPOT' | 'HEMISPHERIC' | 'RECTANGULAR_AREA';
  position?: Vector3Serializable;      // For positioned lights
  direction?: Vector3Serializable;     // For directional/spot
  diffuseColor: ColorSerializable;     // [r, g, b]
  intensity: number;
  specularColor?: ColorSerializable;
  range?: number;                      // For point lights
  radius?: number;                     // For area lights
  angle?: number;                      // For spot lights
  exponent?: number;                   // For spot lights
  isEnabled: boolean;
  timestamp: number;
}
```

### 5. Sky Effect Synchronization (`multiplayer/sky_sync.ts`)
```typescript
interface SkyEffectState {
  effectType: 'base' | 'heatLightning' | 'colorBlend';
  isActive: boolean;
  visibility?: number;                 // For heat lightning
  colorModifier?: ColorSerializable;   // For color effects
  intensity?: number;
  durationMs?: number;
  elapsedMs?: number;
  timestamp: number;
}
```

### 6. Shared Helpers (`multiplayer/serialization.ts`)
```typescript
type Vector3Serializable = [number, number, number];
type ColorSerializable = [number, number, number] | [number, number, number, number];

interface MultiplayerClientState {
  clientId: string;
  isSynchronizer: boolean;
  sessionStarted: number;              // ISO timestamp
  environment: string;                 // Current environment name
  character: string;                   // Current character name
}
```

---

## Datastar Integration Points

### TypeScript Client
1. **Subscribe to Server Broadcasts**:
   - Listen for `character-state-update` signals
   - Listen for `item-state-update` signals
   - Listen for `effects-state-update` signals
   - Listen for `light-state-update` signals
   - Listen for `sky-state-update` signals

2. **Send Synchronizer Updates**:
   - PATCH `/api/multiplayer/character-state` (if synchronizer)
   - PATCH `/api/multiplayer/item-state` (if synchronizer)
   - PATCH `/api/multiplayer/effects-state` (if synchronizer)
   - PATCH `/api/multiplayer/lights-state` (if synchronizer)
   - PATCH `/api/multiplayer/sky-effects-state` (if synchronizer)

3. **Lifecycle Events**:
   - POST `/api/multiplayer/join` → receive `clientId` and `isSynchronizer`
   - POST `/api/multiplayer/leave` (on disconnect)

### Go Backend (Datastar)
1. **SSE endpoint**: `GET /api/multiplayer/stream` (Server-Sent Events via Datastar)
2. **Client Registry**: Ordered map of connected clients
3. **Broadcast Flow**:
   - Receive state update from synchronizer
   - Validate update (security/constraints)
   - Store in memory or database
   - Send SIGNAL to all clients with updated state
4. **Synchronizer Failover**:
   - If synchronizer disconnects, next client in order becomes synchronizer
   - Broadcast `synchronizer-changed` signal to all clients

---

## Implementation Files to Create

### Client-Side
1. **`src/client/types/multiplayer.ts`** - Synchronized state interfaces
2. **`src/client/managers/multiplayer_manager.ts`** - Connection & sync orchestration
3. **`src/client/utils/multiplayer_serialization.ts`** - Vector3/Color serialization
4. **`src/client/sync/character_sync.ts`** - Character state tracking
5. **`src/client/sync/item_sync.ts`** - Item state tracking
6. **`src/client/sync/effects_sync.ts`** - Particle effect tracking
7. **`src/client/sync/lights_sync.ts`** - Light state tracking
8. **`src/client/sync/sky_sync.ts`** - Sky effect state tracking
9. **`src/client/datastar/datastar_client.ts`** - Datastar SDK wrapper

### Server-Side (Go)
1. **`src/server/multiplayer/main.go`** - Entry point
2. **`src/server/multiplayer/handlers.go`** - HTTP handlers (join, leave, health)
3. **`src/server/multiplayer/client.go`** - Client model
4. **`src/server/multiplayer/sync.go`** - State sync handlers
5. **`src/server/multiplayer/broadcast.go`** - Broadcasting logic
6. **`src/server/multiplayer/go.mod`** - Go module file
7. **`src/server/multiplayer/go.sum`** - Go dependencies

---

## State Update Flow

### Synchronizer → Server → All Clients (Example: Character Move)

```
┌─ Synchronizer Client ──────────────────────────────────────┐
│  1. CharacterController updates position/rotation          │
│  2. new CharacterState { clientId, position, rotation } │
│  3. PATCH /api/multiplayer/character-state                 │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─ Datastar Go Server ───────────────────────────────────────┐ 
│  1. Receive PATCH from synchronizer                        │
│  2. Validate clientId is synchronizer                      │
│  3. Broadcast SIGNAL to all clients with updated state     │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─ All Connected Clients ────────────────────────────────────┐
│  1. Receive character-state-update signal                  │
│  2. For each CharacterState in update:                     │
│     - If clientId != own: apply to remote character mesh   │
│     - Update position, rotation, animation                 │
│  3. Render updated scene                                   │
└─────────────────────────────────────────────────────────────┘
```

---

## Constraints & Security

1. **Only synchronizer can update entity state**
   - Server validates `ClientId` header matches synchronizer ID
   - Rejects updates from non-synchronizer clients

2. **Entity Ownership**
   - Characters tied to clientId
   - Items can be globally or client-owned

3. **Update Frequency**
   - Throttle character updates to ~20 Hz (50ms)
   - Throttle item updates to ~10 Hz (100ms)
   - Broadcast all updates in single SIGNAL message

4. **Data Validation**
   - Position within world bounds
   - Rotation normalized [0, 2π)
   - Velocity magnitude sanity checks
   - Timestamp ordering (reject old updates)

---

## Fallback & Offline Play

- If server unreachable: single-player mode
- Synchronizer role determined client-side when offline
- On reconnect: re-sync full state and determine new role
- Previous single-player session resumes

---

## Next Steps

1. ✅ Design synchronized state interfaces
2. ⏳ Create TypeScript multiplayer types & serialization
3. ⏳ Implement Go backend with Datastar SDK
4. ⏳ Integrate multiplayer_manager into SceneManager
5. ⏳ Add per-manager sync wrappers (CharacterController, CollectiblesManager, etc.)
6. ⏳ Test with 2+ connected clients
7. ⏳ Implement synchronizer failover
8. ⏳ Add UI for multiplayer status
