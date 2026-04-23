# Babylon Game Starter - Multiplayer Implementation Plan

## Overview

Transform babylon-game-starter into a multiplayer-capable game using **Datastar** for real-time state synchronization, using a **three-tier authority model**:

- **Per-client authority** for each player's own character state (everyone publishes their own avatar).
- **Tier 1 — Base-synchronizer authority** (one client, global scope) for global world state: lights, sky effects, environment particles. The first connected client is elected base synchronizer and promoted on failover. Base synchronizer has **no** special item privilege.
- **Tier 2 — Environment item authority** (one client per environment) for every item in that environment that lacks an explicit per-item claim. Assigned to the first-in-env and failed over to the next-earliest remaining arrival on leave / disconnect / env switch. This tier is what keeps gravity / physics running on a newly-loaded environment before anyone has reached a claim radius.
- **Tier 3 — Explicit item owner** (any client, per `instanceId`) for an individual dynamic item. Set via a proximity claim and overrides env-authority for that one row. Released on grace expiry, env switch, disconnect, or idle timeout.
- **First-write-wins collection** for collectible items. Collection events are broadcast once; item transforms for collectibles are bootstrap-only.

The **resolved owner** of any item row is computed in that order: explicit item owner if present, else env-authority of the row's environment, else no owner (row rejected).

Complementary performance guarantee: the server maintains an **item transform cache** and broadcasts only rows whose observable state has actually changed (the "dirty filter"). Clean repeats are silently dropped to reduce compute and bandwidth without losing convergence on late-joiners (who receive a cache bootstrap replay on SSE open).

Normative details live in [MULTIPLAYER_SYNCH.md §4.7](MULTIPLAYER_SYNCH.md#47-item-authority-lifecycle) (explicit item authority), [§4.8](MULTIPLAYER_SYNCH.md#48-environment-item-authority-lifecycle) (environment item authority), [§5.2](MULTIPLAYER_SYNCH.md#52-item-state) (per-row filtering + dirty filter), [§5.6–§5.7](MULTIPLAYER_SYNCH.md#56-item-authority-claim) (claim/release), [§6.8](MULTIPLAYER_SYNCH.md#68-item-authority-changed) (explicit authority signal), and [§6.9](MULTIPLAYER_SYNCH.md#69-env-item-authority-changed) (env-authority signal).

---

## Architecture

### Server Architecture (Go with Datastar SDK)

- **Role**: Maintains ordered client collection, authority registries, item transform cache, and broadcast mechanism.
- **Clients Storage**: `OrderedMap[clientId] -> ClientConnection`.
- **Authority Registries** (three parallel, independent tables):
  - `baseSynchronizerId: clientId` — single global-world-state writer ([§4.6](MULTIPLAYER_SYNCH.md#46-base-synchronizer-changes)).
  - `envAuthority: map[envName] clientId` — default item owner per environment.
  - `envArrivalOrder: map[envName] []clientId` — FIFO of clients currently present in each env, in server-observed arrival order; head of the list is the env-authority ([§4.8](MULTIPLAYER_SYNCH.md#48-environment-item-authority-lifecycle)).
  - `itemOwners: map[instanceId] { ownerClientId, lastUpdatedAt }` — explicit per-item claims that override env-authority ([§4.7](MULTIPLAYER_SYNCH.md#47-item-authority-lifecycle)).
- **Item Transform Cache**:
  - `itemTransformCache: map[instanceId] CachedItemTransform { position, rotation, velocity, isCollected, collectedByClientId, ownerClientId, lastBroadcastAt }`.
  - Used by the dirty filter to drop rebroadcasts of unchanged rows ([§5.2](MULTIPLAYER_SYNCH.md#52-item-state)).
  - Replayed wholesale to every new SSE session so late-joiners are not starved by the filter.
- **State Sync Flow**:
  1. Each client publishes its own character state.
  2. The **base synchronizer** publishes lights / sky / env-particle state.
  3. The **resolved owner** of each item (explicit owner if any, else env-authority for the item's env) publishes `ItemInstanceState` rows.
  4. The server row-filters item rows by resolved owner ([§7.5](MULTIPLAYER_SYNCH.md#75-item-authority-authorization)), then applies the dirty filter against `itemTransformCache` ([§5.2](MULTIPLAYER_SYNCH.md#52-item-state)), then broadcasts surviving DIRTY rows only.
  5. Claim / release PATCHes mutate `itemOwners`; transitions emit `item-authority-changed`.
  6. Joins, env switches, leaves, and disconnects mutate `envAuthority` / `envArrivalOrder`; transitions emit `env-item-authority-changed`.

#### SSE transport compression

The multiplayer SSE stream (`GET /api/multiplayer/stream`) carries many small, highly repetitive JSON payloads per client — the same field names and near-constant numeric magnitudes in every `item-state-update` frame. That payload shape is the best-case scenario for dictionary-based compression. The Go server enables **Brotli** on the SSE route by default via a small middleware that wraps the multiplayer mux with [`github.com/CAFxX/httpcompression`](https://github.com/CAFxX/httpcompression) (which composes [`github.com/andybalholm/brotli`](https://github.com/andybalholm/brotli) for Brotli and [`klauspost/compress`](https://github.com/klauspost/compress) for gzip fallback).

Design constraints ([MULTIPLAYER_SYNCH.md §9.1](MULTIPLAYER_SYNCH.md#91-sse-transport-compression-non-normative)):

- **Flush-aware.** The compression middleware must preserve `http.Flusher` on the wrapped response writer. `datastar-go` calls `Flush()` after every `MarshalAndPatchSignals`; buffering multiple SSE events into one compression window would introduce unbounded latency. `CAFxX/httpcompression` forwards `Flusher` correctly; this is the reason we do not hand-roll a compress-on-write decorator.
- **Low-latency Brotli.** Quality is set to 3–5 (streaming mode, small window) rather than the default 11. Quality 11 buffers tens of kilobytes before emitting output and would defeat the flush-per-event cadence.
- **Content-Type allow-list.** Compression is restricted to `text/event-stream` (and optionally `application/json` on PATCH responses). Other responses pass through uncompressed to avoid double-encoding or wasted CPU on already-small replies.
- **Env-var opt-out.** `MULTIPLAYER_SSE_COMPRESSION=off` disables the middleware at startup (also accepts `brotli` | `gzip`). This is the operational escape hatch for proxies that mishandle `Content-Encoding`.
- **Dev-proxy pass-through.** `vite.config.ts` uses Vite's built-in proxy, which does not decompress or re-compress by default; `Content-Encoding: br` reaches the browser unchanged.

Bandwidth saving is workload-dependent but the per-recipient fan-out defined by [§5.2.2](MULTIPLAYER_SYNCH.md#522-per-client-freshness-matrix) is particularly compressible — Brotli quality 4 typically reduces SSE traffic by 70–85% on synthetic item-heavy workloads without measurably increasing frame-to-frame latency.

### Client Architecture (TypeScript + Babylon.js)

Each client holds up to **three independent roles** at any moment (all optional, all non-exclusive):

- **Base Synchronizer Role** (at most one client, global scope). Responsible for global world state:
  - Lights, sky effects, environment particles.
  - Server reassigns on disconnect via `synchronizer-changed`.
- **Environment Item Authority Role** (at most one client per environment). Responsible for every item in its environment that isn't explicitly claimed:
  - Runs its physics bodies as `DYNAMIC` so gravity / contacts resolve locally.
  - Samples and publishes `ItemInstanceState` rows for those items.
  - Acquired by being first-in-env; handed off to the next-earliest remaining arrival when the current authority leaves or env-switches.
  - Observed via `env-item-authority-changed` signals.
- **Explicit Item Owner Role** (per `instanceId`, independently held by any client). Responsible for one dynamic item's transform / velocity stream; overrides env-authority for that row:
  - Flips the local physics body for that one item to `DYNAMIC` on own, `ANIMATED` (kinematic) on yield.
  - Emits proximity claims before collision so the body is already dynamic at contact.
  - Releases after `claimGraceMs` of non-proximity at rest, on env-switch, or on disconnect.

All clients always publish their own character state and MAY apply any received state update.

The client-side `ItemAuthorityTracker` is the single **resolver** used across the rest of the code: for any `instanceId` it answers "am I the resolved owner?" by checking (a) the explicit `itemOwners` map mirrored from the server, then (b) the `envAuthority` map mirrored from the server for the item's environment. Motion-type flipping, item-state sampling, and proximity claim emission all read through the tracker.

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
   - Listen for `item-state-update` signals (dirty-filtered; may arrive with empty `updates` when only collections change)
   - Listen for `effects-state-update` signals
   - Listen for `light-state-update` signals
   - Listen for `sky-state-update` signals
   - Listen for `synchronizer-changed` signals (base-sync only)
   - Listen for `item-authority-changed` signals (explicit per-item claims)
   - Listen for `env-item-authority-changed` signals (environment-scope defaults)

2. **Send Updates** (per role):
   - PATCH `/api/multiplayer/character-state` — **every client** publishes its own row.
   - PATCH `/api/multiplayer/effects-state` — **base synchronizer only**.
   - PATCH `/api/multiplayer/lights-state` — **base synchronizer only**.
   - PATCH `/api/multiplayer/sky-effects-state` — **base synchronizer only**.
   - PATCH `/api/multiplayer/item-state` — **resolved owner per row** (explicit item owner, otherwise env-authority for that item's env) ([§5.2](MULTIPLAYER_SYNCH.md#52-item-state)).
   - PATCH `/api/multiplayer/item-authority-claim` — any client, on proximity enter ([§5.6](MULTIPLAYER_SYNCH.md#56-item-authority-claim)).
   - PATCH `/api/multiplayer/item-authority-release` — current explicit owner, on grace expiry or env switch ([§5.7](MULTIPLAYER_SYNCH.md#57-item-authority-release)).

3. **Lifecycle Events**:
   - POST `/api/multiplayer/join` → receive `clientId` and `isSynchronizer`
   - POST `/api/multiplayer/leave` (on disconnect)

### Go Backend (Datastar)
1. **SSE endpoint**: `GET /api/multiplayer/stream` (Server-Sent Events via Datastar)
2. **Client Registry**: Ordered map of connected clients
3. **Authority Registries**:
   - `itemOwners: map[instanceId] { ownerClientId, lastUpdatedAt }` (explicit claims).
   - `envAuthority: map[envName] clientId` + `envArrivalOrder: map[envName] []clientId` (env default).
4. **Item Transform Cache**: `itemTransformCache: map[instanceId] CachedItemTransform` backing the dirty filter and the SSE bootstrap replay.
5. **Broadcast Flow**:
   - Receive state update (character, global-world, or item).
   - For global-world routes: verify sender is base synchronizer; else 403.
   - For item-state: compute resolved owner (explicit → env-authority → none); drop unauthorized rows silently. For surviving rows, consult `itemTransformCache` and drop CLEAN repeats while still refreshing `itemOwners.lastUpdatedAt` for activity tracking; include DIRTY rows (update cache first). If zero rows remain and no collections were accepted, elide the broadcast.
   - Send SIGNAL to all clients with the dirty-filtered delta.
6. **Base-Synchronizer Failover**:
   - If the base synchronizer disconnects, the next client in order becomes base synchronizer.
   - Broadcast `synchronizer-changed` signal. Item authority (neither explicit nor env) is **not** affected.
7. **Explicit Item Authority Management**:
   - Apply claim / release requests per [§4.7](MULTIPLAYER_SYNCH.md#47-item-authority-lifecycle).
   - On client disconnect, release every `instanceId` they owned and emit `item-authority-changed` (`reason: "disconnect"`).
   - Replay current `itemOwners` as `item-authority-changed` signals to late-joiners on SSE open.
8. **Environment Item Authority Management**:
   - On join / env-switch-in: append sender to `envArrivalOrder[env]`; if `envAuthority[env]` was empty, set it to sender and emit `env-item-authority-changed` (`reason: "arrival"`).
   - On leave / disconnect / env-switch-out: remove sender from `envArrivalOrder[env]`; if sender was env-authority, promote the new head (or clear) and emit `env-item-authority-changed` (`reason: "failover" | "env_switch" | "disconnect"`).
   - Replay current `envAuthority` as `env-item-authority-changed` signals (one per non-empty env) on SSE open, after the `item-state-update` cache bootstrap.
9. **SSE Bootstrap for Late Joiners**:
   - Send the current `itemTransformCache` as an `item-state-update` with all cached rows (unconditionally DIRTY for this new session).
   - Send the current `itemOwners` as `item-authority-changed` signals.
   - Send the current `envAuthority` as `env-item-authority-changed` signals.
   - Only after all three bootstraps does live traffic begin flowing through the dirty filter.

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

### Character flow (every client publishes its own avatar)

```
┌─ Any Client ────────────────────────────────────────────────┐
│  1. CharacterController updates local position / rotation   │
│  2. Build CharacterState { clientId = self, ... }           │
│  3. PATCH /api/multiplayer/character-state                  │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─ Go Server ────────────────────────────────────────────────┐
│  1. Verify every row's clientId == X-Client-ID             │
│  2. Broadcast character-state-update                       │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─ All Clients ──────────────────────────────────────────────┐
│  For each row: if clientId != self, apply to remote peer   │
└─────────────────────────────────────────────────────────────┘
```

### Global world flow (base synchronizer only)

```
┌─ Base Synchronizer ─────────────────────────────────────────┐
│  1. Sample lights / sky / env particles                     │
│  2. PATCH /api/multiplayer/(lights|sky-effects|effects)-    │
│     state                                                   │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─ Go Server ────────────────────────────────────────────────┐
│  Enforce X-Client-ID == baseSynchronizerId; else 403       │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─ All Clients ──────────────────────────────────────────────┐
│  Apply lights-state-update / sky-effects-state-update /    │
│  effects-state-update                                      │
└─────────────────────────────────────────────────────────────┘
```

### Environment item authority flow (default, on env entry / exit)

```
┌─ Client joins session or switches environment to E ────────┐
│  1. POST /api/multiplayer/join (or char-state env change)  │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─ Go Server ────────────────────────────────────────────────┐
│  1. Append sender to envArrivalOrder[E].                   │
│  2. If envAuthority[E] was empty:                          │
│       envAuthority[E] ← sender                             │
│       broadcast env-item-authority-changed                 │
│         (reason: "arrival")                                │
│     Else: no signal; sender stays a waiter.                │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─ All Clients ──────────────────────────────────────────────┐
│  Apply env-item-authority-changed:                         │
│  - If newAuthorityId == self for env E, for every item in  │
│    E that has no explicit itemOwners entry: flip body →    │
│    DYNAMIC; begin sampling rows.                           │
│  - Else, keep those items ANIMATED (kinematic); they are   │
│    driven by setTargetTransform() from incoming rows.      │
└─────────────────────────────────────────────────────────────┘
```

On leave / disconnect / env switch the env-authority is handed off to the head of the remaining `envArrivalOrder[E]` (or cleared if empty), again via `env-item-authority-changed`. See [MULTIPLAYER_SYNCH.md §4.8](MULTIPLAYER_SYNCH.md#48-environment-item-authority-lifecycle).

### Explicit item authority flow (proximity claim, overrides env-authority)

```
┌─ Any Client (character approaches item) ───────────────────┐
│  1. Proximity observer detects capsule ∈ item's            │
│     claimRadiusMeters bubble.                              │
│  2. PATCH /api/multiplayer/item-authority-claim            │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─ Go Server ────────────────────────────────────────────────┐
│  1. Evaluate claim vs. current itemOwners entry.           │
│  2. If accepted, update itemOwners + broadcast             │
│     item-authority-changed (reason: "claim").              │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─ All Clients ──────────────────────────────────────────────┐
│  Apply item-authority-changed:                             │
│  - If newOwnerId == self, flip body → DYNAMIC; begin       │
│    publishing ItemInstanceState rows for that instanceId.  │
│  - Else, flip body → ANIMATED (kinematic); stop publishing.│
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─ Resolved Owner (explicit owner OR env-authority) ─────────┐
│  PATCH /api/multiplayer/item-state with rows for every     │
│  instanceId the client is the resolved owner of.           │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─ Go Server (row filter → dirty filter → freshness proj.) ─┐
│  1. For each row, accept iff sender is the resolved owner. │
│  2. For surviving rows, compare to itemTransformCache:     │
│     - CLEAN (within epsilon): refresh lastUpdatedAt only;  │
│       drop from broadcast.                                 │
│     - DIRTY: update cache.                                 │
│  3. Freshness projection: for DIRTY rows, mark every in-   │
│     env cell (E, I, X ≠ resolvedOwner) as STALE. The       │
│     owner's cell stays FRESH by the owner-pin invariant;   │
│     the owner is NEVER in the fan-out for its own items.   │
│  4. Per-recipient fan-out producer: for each in-env client │
│     with stale cells or pending collections, emit exactly  │
│     one item-state-update containing only its stale rows + │
│     its undelivered collections; flip those cells to FRESH │
│     after enqueue. No row is sent twice to the same        │
│     recipient; no row is ever sent to the resolved owner.  │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─ Non-owner Clients only ───────────────────────────────────┐
│  Apply collections[] independently (hide / despawn item).  │
│  Apply updates[] to kinematic bodies via                   │
│  setTargetTransform(); NO impulse / force / velocity.      │
│  Drop any row whose instanceId resolves as self-owned      │
│  (defense-in-depth).                                       │
└─────────────────────────────────────────────────────────────┘
┌─ Resolved Owner ───────────────────────────────────────────┐
│  Receives NOTHING for its own items (owner pin). Local     │
│  physics is the canonical source for those bodies.         │
└─────────────────────────────────────────────────────────────┘
```

Explicit release happens symmetrically when the owner leaves proximity for `claimGraceMs` with the body at rest, on env switch, or on disconnect. See [MULTIPLAYER_SYNCH.md §4.7](MULTIPLAYER_SYNCH.md#47-item-authority-lifecycle) for the full state machine. After release the item falls back to the env-authority default.

### Item Authority Lifecycle (summary)

- **Env default (Tier 2).** On first-in-env, env-authority is assigned; on leave / disconnect / env switch, it fails over to the next-earliest remaining arrival in that env, or clears if the env is empty. Handed-off clients resume publishing within one send-tick.
- **Explicit override (Tier 3).** `Unowned → Claimed` on accepted proximity claim. `Claimed → Claimed` on accepted claim refresh or `item-state-update` from current owner. `Claimed → Unowned` on explicit release, owner disconnect, `claimIdleTimeoutMs` elapsed without updates, or environment switch — after which the item returns to the env-authority default.
- Reference tunables: `claimRadiusMeters = 2.5`, `claimGraceMs = 3000`, `claimIdleTimeoutMs = 1500`, `positionEpsilon = 1e-3`, `rotationEpsilon = 1e-3`, `velocityEpsilon = 1e-3`.

### Per-client freshness matrix

The Go server maintains a boolean **freshness matrix** `freshness[environmentName][instanceId][clientId] → {fresh | stale}` whose cells exist for every in-env `(item, client)` pair. The matrix is the one-bit projection of the Wuu-Bernstein Two-Dimensional Time Table ([MULTIPLAYER_SYNCH.md §10](MULTIPLAYER_SYNCH.md#10-informative-references-non-normative)); the boolean collapse is sufficient because SSE delivery within a connection is TCP-reliable, and reconnect resets all cells to `stale`, which naturally rehydrates. The industrial analog is Valve Source Engine's per-client view table driving `IClientNetworkable::NotifyShouldTransmit`.

Five operational rules govern the matrix (full normative text in [MULTIPLAYER_SYNCH.md §5.2.2](MULTIPLAYER_SYNCH.md#522-per-client-freshness-matrix)):

1. **Owner pin.** `freshness[E][I][resolvedOwner(I)]` is always `fresh`. The server never puts a row for `I` into the resolved owner's fan-out — self-echo is eliminated at the protocol level rather than at the client.
2. **Dirty-broadcast projection.** A DIRTY row (§5.2.1) for `I` from owner `O` marks every `(E, I, X ≠ O)` cell `stale`; the fan-out producer emits that row to each `stale` client and flips the cell back to `fresh` after enqueue.
3. **AOI enter.** Environment entry (initial join, env-switch, or SSE reconnect) seeds all in-env cells for the arriving client to `stale`, causing the next broadcast window to emit a single per-env bootstrap `item-state-update` containing every cached row. There is no separate "bootstrap replay" code path; it is the steady-state broadcast run against a fully-stale column.
4. **AOI leave.** Env exit, disconnect, or env-switch evicts `freshness[E][*][leaver]` and feeds the same server tick that emits `env-item-authority-changed` and releases the leaver's explicit claims.
5. **Ownership transition.** On `item-authority-changed` or `env-item-authority-changed` for `I`, the server re-pins `freshness[E][I][newOwner] = fresh` and marks `freshness[E][I][previousOwner] = stale`; the new owner's next DIRTY row flows through the regular projection to everyone else.

This one structure simultaneously implements self-echo elimination, late-joiner bootstrap, ownership-transition rehydrate, orphan reassignment delivery, and the server-side subscription list.

### Local physics is king (resolved-owner invariant)

The resolved owner's local physics simulation is the canonical, authoritative source of state for its items. Three consequences:

- **The server MUST NOT echo the owner's rows back to the owner.** Enforced by the freshness matrix owner-pin (rule 1 above). A conforming client MUST additionally drop any self-owned row it receives (defense-in-depth for reconnect races).
- **Non-owners MUST NOT run dynamic physics on non-owned items.** Non-owner bodies stay in `PhysicsMotionType.ANIMATED` (kinematic); incoming rows are applied exclusively via `setTargetTransform()` or equivalent. Non-owners MUST NOT call `setLinearVelocity`, `applyImpulse`, or `addForce` on such bodies. Velocity in the row is advisory (extrapolation hint) only.
- **Gravity and contact response for an item originate on exactly one client — the resolved owner.** This is the fix for the "cake hovering and oscillating on the env-authority" and "presents dropping in slow motion" symptoms: the env-authority was fighting its own echoes through the kinematic target path. With owner-pin in place, the env-authority's body falls under gravity, its own simulation, exactly once.

### Motion-type invariants

| Situation | Item `I` in env `E` | Client `C`'s body for `I` |
|-----------|---------------------|---------------------------|
| `C` is explicit owner of `I` | `itemOwners[I].ownerClientId == C` | `DYNAMIC` |
| No explicit owner; `C` is env-authority for `E` | `envAuthority[E] == C` | `DYNAMIC` |
| `C` is in `E`, not resolved owner | otherwise | `ANIMATED` (kinematic) |
| `C` is not in `E` | — | body not instantiated (or despawned on env switch) |
| `C` just entered `E`, has not yet processed bootstrap | pre-seed | `ANIMATED` (kinematic), held until bootstrap applied (next subsection) |

Transitions are driven exclusively by `item-authority-changed`, `env-item-authority-changed`, and env-switch signals. On every transition, the client MUST atomically set the motion type and clear any queued kinematic target before running the next physics tick on `I`.

### Environment bootstrap ordering

On environment entry, the client MUST apply the following sequence **before starting its local physics loop** in the entered environment:

1. Receive and apply `env-item-authority-changed` for the entered environment.
2. Receive and apply `item-authority-changed` for every explicit claim in the entered environment.
3. Receive and apply the bootstrap `item-state-update` that results from [§5.2.2](MULTIPLAYER_SYNCH.md#522-per-client-freshness-matrix) rule 4 (AOI enter), which includes every `ItemInstanceState` row currently in the server's `itemTransformCache` for the env plus any undelivered `ItemCollectionEvent`s.
4. Seed motion type per the table above for every item in the env.
5. Only then begin ticking the local physics engine against env items.

This ordering fixes the "items whizzing in a blur on P2" symptom, which was caused by Player 2 starting local physics on un-seeded (zero-initialized) bodies before the authoritative snapshot was applied.

### Orphan reassignment on leave

Ownership is never left dangling. When a client `O` leaves environment `E` (via disconnect, explicit `/leave`, or env-switch), the server performs the following in one atomic tick:

1. **Release every explicit claim held by `O`.** For each `instanceId I` where `itemOwners[I].ownerClientId == O`, delete the entry and broadcast `item-authority-changed` with `reason = "disconnect" | "env_switch"`. The item's resolved owner falls back to the env-authority (if any) with no manufactured claim.
2. **Evict `O`'s AOI column.** `freshness[E][*][O]` is deleted (§5.2.2 rule 5), preventing any stale-row emission to a departed client.
3. **Fail env-authority over if `O` was env-authority.** Pop `O` from `envArrivalOrder[E]`. If the list is non-empty, promote the new head `N`: `envAuthority[E] ← N`, broadcast `env-item-authority-changed` with `reason = "failover"`, re-pin `freshness[E][I][N] = fresh` for every item in `E` that was resolved to the old env-authority, and mark `itemTransformCache[I]` terminal so the next row from `N` is unconditionally DIRTY and delivered to every remaining in-env client. If the list is empty, clear `envAuthority[E]`; items in `E` park at their last cached transform until the next arrival.
4. **Preserve physics continuity.** Because the freshness matrix re-pins the new resolved owner and the client flips `ANIMATED → DYNAMIC` in response to the signals above, there is no simulation gap: the new owner resumes `I` from the last broadcast transform within one send-tick.

This flow ensures that "a client who never came within claim distance" can still take over every item in the environment on the predecessor's departure, and that no item is ever stranded in a state where nobody is authoritative for it while some client is still in the env.

### Future: versioned freshness cells

The boolean cell used today is the minimal form of the Wuu-Bernstein 2DTT entry. It is sufficient because the two assumptions of the current deployment — TCP-reliable single-connection SSE, and reconnect-equals-full-rehydrate — absorb any gap that a version counter would otherwise cover. Both assumptions are simplicity decisions, not correctness constraints.

The upgrade path is a single-file refactor of the freshness matrix module on the server:

```text
freshness[E][I][X] : {fresh | stale}
                     ↓
freshness[E][I][X] : uint64   // monotonic version
itemVersion[E][I]  : uint64   // per-item counter, incremented on every DIRTY accept
```

The four lifecycle rules translate mechanically:

- **Owner pin (rule 2 upgrade):** `freshness[E][I][owner] := itemVersion[E][I]` on every accepted row. Owner is "fresh" iff its cell equals the counter.
- **Dirty projection (rule 3 upgrade):** Enqueue the row for `X` iff `freshness[E][I][X] < itemVersion[E][I]`; after enqueue, assign the counter. Owner is already at the counter and is never queued.
- **AOI enter (rule 4 upgrade):** Initialize `freshness[E][I][X] := 0`. Every cached item has version ≥ 1, so every cell is strictly less than the counter — a natural full-env rehydrate without a special-case code path.
- **Ownership transition (rule 6 upgrade):** `freshness[E][I][newOwner] := itemVersion[E][I]`; other cells keep their values and re-project on the next DIRTY row.

Features that unlock only after this upgrade:

1. **Client-side ack.** Client reports "I have up to V for I" and the server re-sends V+1..N without dropping the connection.
2. **Partial rehydrate on reconnect.** Instead of evicting the reconnecting client's column, the client sends its last-known `(E, I, V)` tuples; the server replies with only the delta. Reconnect bandwidth scales with outage duration, not env size.
3. **Message-loss tolerance.** Under lossy transports (e.g., WebTransport datagrams, or proxies that occasionally reset) the counter detects gaps — missing version V+1 triggers targeted retransmission, not a stream reset.
4. **Multi-region replication.** The 2DTT full form, `T[k, u]` per origin shard `k`, generalizes this cell into a matrix clock. Required once more than one origin writes to the same `(E, I)`; until then a scalar counter suffices.
5. **Observability.** A monotonic counter gives operators a direct read on how far behind each client is per item, without having to probe internal boolean state.

Features 1–3 are internal server optimizations with no wire-format change; feature 4 introduces `ItemInstanceState.version` on the wire and is the only one that breaks protocol compatibility. Current guidance: keep the cell type abstracted behind a small internal API (`fresh(E, I, X) → bool`, `markStale(E, I, X)`, `markFresh(E, I, X)`) so the eventual swap is a localized change.

Full rationale and the Wuu-Bernstein `hasrec` predicate are in [MULTIPLAYER_SYNCH.md §10 *Future evolution of the freshness cell*](MULTIPLAYER_SYNCH.md#future-evolution-of-the-freshness-cell-non-normative).

---

## Constraints & Security

1. **Role-scoped write authority (three-tier)**
   - Global world state (lights / sky / env particles): base-synchronizer-only; server rejects non-synchronizer PATCHes with `403 Forbidden` ([§7.2](MULTIPLAYER_SYNCH.md#72-global-world-state-authorization)).
   - Item state: per-row layered filter — explicit `itemOwners` entry takes precedence; otherwise the row must come from the env-authority for the item's env; otherwise silently dropped ([§7.5](MULTIPLAYER_SYNCH.md#75-item-authority-authorization)).
   - Character state: each row's `clientId` must equal `X-Client-ID`.
   - Base synchronizer has **no** item privilege; env-authority does not bypass explicit item claims.

2. **Entity Ownership**
   - Characters tied to `clientId`.
   - Dynamic items: resolved per-row — explicit owner if present, else env-authority of the item's env.
   - Collectible items: not owned for transform beyond env-authority bootstrap; collection events are first-write-wins.

3. **Update Frequency & Bandwidth**
   - Throttle character updates to ~20 Hz (50ms).
   - Throttle item updates to ~10 Hz (100ms) at the sender.
   - Server-side dirty filter compares each accepted row to `itemTransformCache` with per-field epsilons and drops CLEAN repeats from the broadcast; only changed rows travel over SSE ([§5.2](MULTIPLAYER_SYNCH.md#52-item-state)).
   - Broadcast all updates in a single SIGNAL message; elide the broadcast entirely when zero rows and zero collections survive.

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
