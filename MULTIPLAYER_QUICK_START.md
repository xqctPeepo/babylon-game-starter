# Babylon Game Starter - Multiplayer Quick Start

## 30-Second Overview

babylon-game-starter supports **multiplayer** with a **three-tier authority model**. Here's how it works:

1. **Every client publishes its own character** (position, rotation, animation, boost).
2. **Tier 1 — Base synchronizer** (one client, global): the first connected client publishes lights, sky effects, and environment particles.
3. **Tier 2 — Environment item authority** (one client per environment): the **first person into an environment runs item physics by default** for that environment. Their client simulates gravity and contacts for every item in that env that nobody has explicitly claimed; everyone else runs those bodies as kinematic and receives target transforms over SSE. When the current env-authority leaves, authority is handed off in arrival order to the next remaining client in that env.
4. **Tier 3 — Explicit item owner** (any client, per item): the client that walks up to a specific dynamic item can claim it with a proximity claim, overriding env-authority for that one row until release / disconnect / env switch.
5. **Server broadcasts** updates to all clients every 50-100 ms, with a **server-side dirty filter** that drops unchanged item rows so bandwidth stays proportional to actual motion.
6. **On disconnect**: the next client in join order becomes base synchronizer; the next remaining arrival in each env becomes that env's new env-authority; items the leaver explicitly owned fall back to env-authority.

> **Authority model**: See [MULTIPLAYER_SYNCH.md §4.7](MULTIPLAYER_SYNCH.md#47-item-authority-lifecycle) for explicit per-item authority and [§4.8](MULTIPLAYER_SYNCH.md#48-environment-item-authority-lifecycle) for the environment-scope default. Tunables: `claimRadiusMeters`, `claimGraceMs`, `claimIdleTimeoutMs`; per-field dirty-filter epsilons live in [§5.2](MULTIPLAYER_SYNCH.md#52-item-state).

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                   Babylon Game Starter                      │
│                   Multiplayer Enabled                       │
└─────────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
   ┌────▼─────┐        ┌────▼─────┐       ┌────▼─────┐
   │ Client 1  │        │ Client 2  │       │ Client 3  │
   │(Sync)    │◄─ SSE ─►│(Member)   │       │(Member)  │
   └────┬─────┘        └────┬─────┘       └────┬─────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            │
                     ┌──────▼──────┐
                     │  Go Server  │
                     │  + Datastar │
                     │             │
                     │ - Validates │
                     │ - Broadcasts│
                     │ - Manages   │
                     │   Role      │
                     └─────────────┘
```

---

## What's Synchronized

✅ **Characters**: Position, rotation, animation, boost status  
✅ **Items**: World transform as a single 4x4 matrix (row-major, 16 floats — Invariant M in [MULTIPLAYER_SYNCH.md §5.2](MULTIPLAYER_SYNCH.md#52-item-state)), collection state, collection credits  
✅ **Particle Effects**: Position, active state  
✅ **Lights**: Position, color, intensity  
✅ **Sky Effects**: Heat lightning, color blends  

---

## Configuration

Multiplayer is configured in `src/client/config/game_config.ts`:

```typescript
MULTIPLAYER: {
  ENABLED: true,                           // Set to false to disable multiplayer
  PRODUCTION_SERVER: 'bgs-mp.onrender.com', // Production server endpoint
  LOCAL_SERVER: 'localhost:5000',          // Local development server
  CONNECTION_TIMEOUT_MS: 15000,            // 15 seconds (Render cold start tolerance)
  PRODUCTION_FIRST: true                   // Try production before local
}
```

**Customization options:**
- `ENABLED: false` → Disable multiplayer entirely
- `PRODUCTION_SERVER` → Point to your own multiplayer server
- `LOCAL_SERVER` → Use different local development endpoint
- `CONNECTION_TIMEOUT_MS` → Increase for slower networks (Render takes ~1 minute to cold start)
- `PRODUCTION_FIRST: false` → Prefer local server, fall back to production

---

## Quick Integration (5 Steps)

### 1. Start the Go Backend

```bash
cd src/server/multiplayer
go run *.go
# Should output: [Multiplayer Server] Listening on :5000
```

### 2. Add Multiplayer Manager to SceneManager

```typescript
// src/client/managers/scene_manager.ts
import { getMultiplayerManager } from './multiplayer_manager';

export class SceneManager {
  private multiplayerManager: MultiplayerManager;

  constructor(engine: BABYLON.Engine, canvas: HTMLCanvasElement) {
    // ... existing setup
    
    this.multiplayerManager = getMultiplayerManager();
    this.setupMultiplayerListeners();
  }

  private setupMultiplayerListeners(): void {
    this.multiplayerManager.on('character-state-update', (update) => {
      for (const state of update.updates) {
        if (state.clientId !== this.multiplayerManager.getClientID()) {
          // Apply to remote character mesh
        }
      }
    });
    
    // Similar for item-state-update, effects-state-update, etc.
  }
}
```

### 3. Optionally Enable Multiplayer at Startup

```typescript
// src/client/main.ts or index.ts
import { getMultiplayerManager } from './managers/multiplayer_manager';

async function initialize(): Promise<void> {
  // ... existing init logic
  
  // Optional: Enable multiplayer (if configured)
  const mp = getMultiplayerManager();
  if (mp.isEnabled()) {
    try {
      await mp.join('dystopia', 'alex');
      console.log('Multiplayer active!');
    } catch (error) {
      console.log('Multiplayer unavailable, single-player mode');
    }
  } else {
    console.log('Multiplayer disabled in configuration');
  }
}
```

### 4. Add Multiplayer Status to HUD

```typescript
// In HUDManager or SettingsUI
private updateMultiplayerStatus(): void {
  const mp = getMultiplayerManager();
  if (mp.isEnabled() && mp.isMultiplayerActive()) {
    const role = mp.isSynchronizer() ? 'Synchronizer' : 'Client';
    this.statusElement.textContent = `🔗 Multiplayer (${role})`;
  } else if (mp.isEnabled()) {
    this.statusElement.textContent = '⚠️ Multiplayer unavailable';
  }
}
```

### 5. Test with Multiple Clients

```bash
# Terminal 1: Backend
cd src/server/multiplayer && go run *.go

# Terminal 2: Dev server (port 3000)
npm run dev

# Terminal 3: Dev server (port 3001)
PORT=3001 npm run dev

# Open both in browser and verify sync!
```

---

## Usage Examples

### Joining Multiplayer

```typescript
const mp = getMultiplayerManager();

// Join current environment and character
await mp.join(currentEnvironment, currentCharacter);

if (mp.isMultiplayerActive()) {
  console.log('Connected!');
  console.log('Synchronizer?', mp.isSynchronizer());
  console.log('Client ID:', mp.getClientID());
}
```

### Leaving Multiplayer

```typescript
await mp.leave();
console.log('Disconnected from multiplayer');
```

### Broadcasting Character Movement (if synchronizer)

```typescript
// In CharacterController update loop
const characterSync = this.characterSync;
const state = characterSync.sampleState(Date.now());

if (state && mp.isSynchronizer()) {
  const update = characterSync.createStateUpdate(Date.now(), [state]);
  await mp.updateCharacterState(update);
}
```

### Receiving Remote Character Updates

```typescript
mp.on('character-state-update', (update: CharacterStateUpdate) => {
  for (const state of update.updates) {
    if (state.clientId !== mp.getClientID()) {
      // Get or create remote character mesh
      const remoteMesh = getRemoteCharacterMesh(state.clientId);
      if (remoteMesh) {
        CharacterSync.applyRemoteCharacterState(remoteMesh, state);
      }
    }
  }
});
```

### Receiving Item Updates

See the Receiver cheat-sheet below for the four hard rules every conforming client MUST implement. The minimal shape:

```typescript
mp.on('item-state-update', (update: ItemStateUpdate) => {
  for (const ev of update.collections ?? []) {
    handleRemoteItemCollection(ev);
  }

  for (const row of update.updates) {
    if (authorityTracker.isOwnedBySelf(row.instanceId)) continue;
    applyKinematicTarget(row);
  }
});
```

### Receiver cheat-sheet (mandatory four rules)

| # | Rule | Why |
|---|------|-----|
| 1 | **Self-owner drop.** If `authorityTracker.isOwnedBySelf(row.instanceId)` returns true, skip the row. | Defense-in-depth for the server's owner-pin invariant. Under a conforming server you should never receive these, but reconnect races can deliver them. Applying them corrupts your own simulation ("cake hovering / oscillating"). |
| 2 | **Non-owner kinematic apply (matrix decompose).** For rows you do NOT own, keep the body in `PhysicsMotionType.ANIMATED`. The wire carries exactly one transform field per row: `matrix` — a 16-float row-major 4x4 world matrix (Invariant M). Decompose it locally into `(scale, quaternion, position)`, discard the scale, and call `body.setTargetTransform(position, quaternion)`. Never call `setLinearVelocity`, `applyImpulse`, or `addForce` on a non-owned body. Never read or write `mesh.rotation.x/y/z` (Euler) on this path (Invariant E). | The resolved owner's physics engine is the only authoritative simulator for the item. Any force on a non-owner is a duplicate, divergent simulation. Matrix is the single source of truth for rotation on the wire so owner and non-owner can never disagree about which rotation channel is authoritative. |
| 3 | **Collection hide, always — with feedback parity.** Process every `collections[]` entry by hiding / despawning the item locally, independent of `updates[]`. When the local representation is still present at the moment the entry arrives, play the same particle burst and spatialized collection sound as the local-collect path (anchored at the mesh's last world position before disable). **Never** credit currency, mutate inventory, or emit scoring side-effects for a remote collection — those are the collector's. Idempotent: repeated collections on the same `instanceId` MUST NOT error. | Fixes "P2 does not see collectibles disappear" and "observer hears and sees nothing when a peer collects." The server delivers collection events regardless of freshness state. |
| 4 | **Unseeded-env hold (ANIMATED-default-then-promote).** On env entry, hold every item in that env `ANIMATED` (kinematic) and WAIT for both the bootstrap `item-state-update` and the authority snapshot (SSE-open) to arrive and be applied. Only then resume the local physics loop. Promote an item to `DYNAMIC` **only** when an explicit authority signal names self as resolved owner — `item-authority-changed`, `env-item-authority-changed`, or the SSE-open authority snapshot. Treat "no confirmed authority yet" as "I am a non-owner." | Fixes "items whizzing in a blur on P2" *and* "cake runs DYNAMIC on both clients, no transforms propagate." Two clients both optimistically claiming the same item drive each other's receivers into self-echo drops; one simulation silently wins, both bodies diverge. |

### Server-side freshness matrix (at a glance)

The Go server maintains a per-client freshness matrix `freshness[env][instanceId][clientId] → fresh | stale` so that every client receives exactly the item-state rows they are missing — no more, no less. Under this design the **resolved owner of an item never receives rows for that item** (owner-pin invariant), which is the protocol-level fix for self-echo loops and the reason the cheat-sheet rule 1 is defense-in-depth rather than the primary guard. On environment entry, the matrix seeds all cells for the arriving client to `stale` so one natural broadcast window rehydrates the full env; on environment leave it evicts the column; on ownership change it re-pins the new owner's cell and marks the previous owner's cell stale. Full normative definition: [MULTIPLAYER_SYNCH.md §5.2.2](MULTIPLAYER_SYNCH.md#522-per-client-freshness-matrix).

### Tracking Synchronizer Changes

```typescript
mp.on('synchronizer-changed', (msg: SynchronizerChangedMessage) => {
  console.log(`New synchronizer: ${msg.newSynchronizerId}`);
  console.log(`Reason: ${msg.reason}`);
  
  if (msg.newSynchronizerId === mp.getClientID()) {
    console.log('This client is now the synchronizer!');
    // Start broadcasting state
  } else {
    console.log('This client is now a regular member');
    // Stop broadcasting, only listen for updates
  }
});
```

---

## File Locations

**Client-side:**
```
src/client/
├── datastar/datastar_client.ts          # SSE wrapper
├── managers/multiplayer_manager.ts      # Main orchestrator
├── sync/
│   ├── character_sync.ts
│   ├── item_sync.ts
│   ├── effects_sync.ts
│   ├── lights_sync.ts
│   └── sky_sync.ts
├── types/multiplayer.ts                 # Interfaces
└── utils/multiplayer_serialization.ts   # Utils
```

**Server-side:**
```
src/server/multiplayer/
├── main.go                              # Entry point
├── handlers.go                          # HTTP endpoints
├── utils.go                             # Helpers
└── go.mod                               # Go module
```

**Documentation:**
```
MULTIPLAYER_PLAN.md           # Architecture overview
MULTIPLAYER_INTEGRATION.md    # Integration guide
MULTIPLAYER_QUICK_START.md    # This file!
```

---

## Key Concepts

### Authority Model (three tiers)

The three item-related tiers are independent of each other, independent of the base-synchronizer role, and are reported via three different SSE signals.

| Tier | Scope | Signal | Spec |
|------|-------|--------|------|
| Base synchronizer | Global (one per server) | `synchronizer-changed` | [§4.6](MULTIPLAYER_SYNCH.md#46-base-synchronizer-changes) |
| Environment item authority | Per environment (one per env) | `env-item-authority-changed` | [§4.8](MULTIPLAYER_SYNCH.md#48-environment-item-authority-lifecycle) |
| Explicit item owner | Per `instanceId` | `item-authority-changed` | [§4.7](MULTIPLAYER_SYNCH.md#47-item-authority-lifecycle) |

The **resolved owner** of any item row is: explicit owner if present, else env-authority of the item's environment, else none.

### Base Synchronizer Role (Tier 1)
- **First connected client** automatically becomes base synchronizer.
- **Responsibilities**: Detect changes in lights / sky / env particles, throttle, broadcast.
- **Scope**: Global world state only; base synchronizer has **no** special item write privilege.
- **Authority**: Server enforces `X-Client-ID == baseSynchronizerId` for global-world-state routes ([§7.2](MULTIPLAYER_SYNCH.md#72-global-world-state-authorization)).
- **Elected**: On base-synchronizer disconnect, next client promoted automatically via `synchronizer-changed`.

### Environment Item Authority Role (Tier 2)
- **First client into an environment** automatically becomes env-authority for that environment.
- **Responsibilities**: Run dynamic physics locally for every item in that env (gravity, contacts, etc.) that nobody has explicitly claimed; sample and publish `ItemInstanceState` rows for those items.
- **Handoff**: When the current env-authority leaves / disconnects / env-switches, the server promotes the next remaining arrival in arrival order and emits `env-item-authority-changed`.
- **Re-entry**: Returning to an env you previously held authority over does NOT reclaim the role — you re-enter at the back of the arrival order.
- **Why it exists**: without this tier, an item like a newly-spawned cake would free-fall with every client treating it as kinematic — it would never settle and peers would see it bouncing or teleporting. Tier 2 guarantees exactly one client is running real physics at all times.

### Explicit Item Owner Role (Tier 3)
- **Any client** can become the explicit owner of a specific dynamic item by entering its proximity bubble.
- **Claim**: `PATCH /api/multiplayer/item-authority-claim` fires before collision so the body is already `DYNAMIC` at contact ([§5.6](MULTIPLAYER_SYNCH.md#56-item-authority-claim)).
- **While owning**: the client overrides env-authority for that one `instanceId` and publishes rows for it. Other clients run the body as kinematic regardless of who holds env-authority for its env.
- **Release**: after `claimGraceMs` of non-proximity-at-rest, on env switch, or on disconnect ([§5.7](MULTIPLAYER_SYNCH.md#57-item-authority-release)). After release, the item falls back to the env-authority default.
- **Failover**: explicit item ownership does **not** follow the base-synchronizer role, does **not** follow env-authority changes, and is not transferred on disconnect — it simply lapses back to Tier 2.

### Throttling (Performance)
- **Character**: 50ms (20 updates/sec max)
- **Items**: 100ms (10 updates/sec max)
- **Effects**: 100ms (10 updates/sec max)
- **Lights**: 100ms (10 updates/sec max)
- **Sky**: 100ms (10 updates/sec max)

### Update Detection
Only significant changes broadcast:
- **Position**: >0.1 units moved
- **Rotation**: >0.05 radians (~3°) rotated
- **Animation**: Changed to different state
- **Jump/Boost**: Toggle on/off

### Security
- **Global world state is base-synchronizer-only** (lights / sky / env particles); other senders get `403 Forbidden`.
- **Item state is row-filtered by resolved owner** — explicit `itemOwners` entry takes precedence; otherwise env-authority for the item's env; otherwise the row is dropped silently ([§7.5](MULTIPLAYER_SYNCH.md#75-item-authority-authorization)).
- **Dirty filter**: accepted rows are compared to a server-side `itemTransformCache`; unchanged repeats are dropped from the broadcast to save bandwidth. Late-joiners receive the cache on SSE open ([§5.2](MULTIPLAYER_SYNCH.md#52-item-state)).
- **Timestamp Check**: Reject updates >30 seconds old.
- **Position Bounds**: Validate positions within ±10000 units.
- **Animation Validation**: Only accept known animation states.

---

## Troubleshooting

### SSE Fails to Connect
```
Error: PATCH /api/multiplayer/character-state failed: 404
```
**Fix**: Make sure Go backend is running on port 5000:
```bash
cd src/server/multiplayer && go run *.go
```

### Characters Don't Move on Other Clients
**Checklist**:
- [ ] First client shows "isSynchronizer: true" in console
- [ ] First client is moving character
- [ ] Network tab shows PATCH requests being sent
- [ ] Other clients subscribed with `mp.on('character-state-update', ...)`
- [ ] `CharacterSync.applyRemoteCharacterState()` being called

### Only First Client Updates Display
**Possible Causes**:
- Server thinks only first client is synchronizer (correct behavior!)
- Integration not complete in CharacterController
- Update throttle too aggressive

**Solution**: Ensure sync updates are being sent:
```typescript
if (mp.isSynchronizer()) {
  mp.updateCharacterState(update); // Must call this!
}
```

### High Latency/Jitter
**Optimize by**:
- Reducing throttle times (faster broadcasts)
- Increasing significance thresholds (fewer updates)
- Implementing client-side prediction

---

## Next Steps

1. ✅ Architecture designed
2. ✅ TypeScript types created
3. ✅ Go backend implemented
4. ✅ Datastar client wrapper created
5. ⏳ **Integrate with SceneManager** (see Step 2 above)
6. ⏳ **Connect sync modules to managers** (add state tracking)
7. ⏳ **Test with 2+ clients**
8. ⏳ **Implement client-side prediction** (smoother movement)
9. ⏳ **Add UI indicators** (connection status, player list)
10. ⏳ **Deploy to production** (follow DEPLOYMENT.md)

---

## Performance Tips

### Bandwidth Optimization
- Use bulk updates (all state in single PATCH)
- Throttle aggressively (50-100ms)
- Only update on significant change

### Update Significance Thresholds
```typescript
// Adjust in serialization utils
hasSignificantVector3Change(oldPos, newPos, threshold)
hasSignificantAngleChange(oldRot, newRot, threshold)

// Lower = more updates sent
// Higher = less responsive but less bandwidth
```

### Interest Management (Future)
Only sync nearby entities:
```typescript
// TODO: Implement distance culling
const distToClient = distance(remoteState.position, myMesh.position);
if (distToClient > VISIBILITY_RANGE) {
  ignore update
}
```

### SSE compression (Brotli)

The multiplayer SSE stream is Brotli-compressed by default. You do not need to do anything on the client side — `EventSource` and `fetch` streaming transparently decode `Content-Encoding: br`. Verify it's active in devtools: `GET /api/multiplayer/stream` should show `Content-Encoding: br` in the response headers. On item-heavy scenes the per-client fan-out compresses 70–85%; the compression middleware flushes on every event so frame-to-frame latency is unchanged.

If a reverse proxy sits between the server and the browser, it MUST pass `Content-Encoding` through unchanged and MUST NOT buffer chunks. If events arrive in bursts rather than continuously, disable compression on the server with `MULTIPLAYER_SSE_COMPRESSION=off` (also accepts `gzip`) and investigate the proxy. See [MULTIPLAYER_SYNCH.md §9.1](MULTIPLAYER_SYNCH.md#91-sse-transport-compression-non-normative) for the full invariants.

---

## References

- [Architecture Plan](MULTIPLAYER_PLAN.md)
- [Integration Guide](MULTIPLAYER_INTEGRATION.md)
- [Datastar Go SDK](https://github.com/starfederation/datastar-go)
- [Babylon.js v9 API](https://doc.babylonjs.com/)
- [Havok Physics](https://www.babylonjs-playground.com/?version=9#NBVTQG)

---

**Status**: ✅ Foundation Complete, Ready for Integration

Estimated time to full multiplayer:
- Integration with managers: **2-3 hours**
- Testing with multiple clients: **1 hour**
- Optimization & smoothing: **2-4 hours**
- Deployment: **1-2 hours**

**Total**: ~6-10 hours to production-ready multiplayer!
