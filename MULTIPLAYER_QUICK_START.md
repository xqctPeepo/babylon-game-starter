# Babylon Game Starter - Multiplayer Quick Start

## 30-Second Overview

babylon-game-starter now supports **multiplayer**. Here's how it works:

1. **First connected client** becomes the "synchronizer" (leader)
2. **Synchronizer** detects entity changes (character movement, item pickup, effects, lights, sky)
3. **Server broadcasts** updates to all clients every 50-100ms
4. **All clients** apply received state to render shared world
5. **On disconnect**: Next client automatically becomes synchronizer

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
   │(Sync)    │◄──WS──►│(Member)   │       │(Member)  │
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
✅ **Items**: Position, collection state, collection credits  
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

```typescript
mp.on('item-state-update', (update: ItemStateUpdate) => {
  // Update item positions
  for (const itemState of update.updates) {
    if (!itemState.isCollected) {
      updateItemPosition(itemState);
    }
  }
  
  // Handle collections
  for (const collection of update.collections ?? []) {
    handleRemoteItemCollection(collection);
  }
});
```

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

### Synchronizer Role
- **First connected client** automatically becomes synchronizer
- **Responsibilities**: Detect changes, throttle updates, broadcast
- **Authority**: Server validates all state updates come from synchronizer
- **Elected**: On synchronizer disconnect, next client promoted automatically

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
- **Synchronizer-Only**: Non-sync clients can't broadcast state
- **Timestamp Check**: Reject updates >30 seconds old
- **Position Bounds**: Validate positions within ±10000 units
- **Animation Validation**: Only accept known animation states

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
