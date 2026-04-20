# Babylon Game Starter - Multiplayer Implementation Guide

## Overview

This guide walks through the multiplayer architecture implementation for babylon-game-starter using **Datastar** for real-time state synchronization.

## Architecture Summary

### Client-Side (TypeScript + Babylon.js)
- **MultiplayerManager**: Orchestrates SSE connection and state broadcasts
- **Sync Modules**: Track entity state changes (CharacterSync, ItemSync, EffectsSync, LightsSync, SkySync)
- **Datastar Client**: SSE wrapper for Datastar protocol
- **Serialization Utils**: Convert Babylon.js types to JSON-friendly formats

### Server-Side (Go + Datastar SDK)
- **HTTP Handlers**: Join/leave endpoints, health check
- **State Update Handlers**: Receive and broadcast state updates
- **Client Registry**: Ordered map for synchronizer role management
- **SSE Broker**: Datastar-managed real-time messaging

---

## File Structure

```
src/client/
  datastar/
    datastar_client.ts         # SSE wrapper for Datastar
  managers/
    multiplayer_manager.ts     # Main orchestration
  sync/
    character_sync.ts          # Character state tracking
    item_sync.ts               # Item state tracking
    effects_sync.ts            # Particle effects tracking
    lights_sync.ts             # Lights state tracking
    sky_sync.ts                # Sky effects tracking
  types/
    multiplayer.ts             # Synchronized state interfaces
  utils/
    multiplayer_serialization.ts # Serialization & utilities

src/server/multiplayer/
  main.go                       # Entry point & server setup
  handlers.go                   # HTTP endpoint handlers
  utils.go                      # Helper functions
  go.mod                        # Go module definition
```

---

## Configuration

Multiplayer settings are configured in `src/client/config/game_config.ts`:

```typescript
MULTIPLAYER: {
  ENABLED: true,                           // Enable/disable multiplayer entirely
  PRODUCTION_SERVER: 'bgs-mp.onrender.com', // Production server hostname
  LOCAL_SERVER: 'localhost:5000',          // Local development server
  CONNECTION_TIMEOUT_MS: 15000,            // 15 seconds (Render cold start tolerance)
  PRODUCTION_FIRST: true                   // Try production before local fallback
}
```

### Custom Server Configuration

To use your own multiplayer server:

```typescript
// src/client/config/game_config.ts
MULTIPLAYER: {
  ENABLED: true,
  PRODUCTION_SERVER: 'my-multiplayer-server.example.com', // Your server
  LOCAL_SERVER: 'localhost:5000',
  CONNECTION_TIMEOUT_MS: 15000,
  PRODUCTION_FIRST: true
}
```

### Disabling Multiplayer

To run in single-player mode only:

```typescript
MULTIPLAYER: {
  ENABLED: false,
  // ... other settings ignored when disabled
}
```

The client automatically detects if multiplayer is disabled:

```typescript
const mp = getMultiplayerManager();
if (!mp.isEnabled()) {
  console.log('Multiplayer is disabled');
  // Run single-player only
}
```

---

## Integration Checklist

### Phase 1: Setup Go Backend

- [ ] Install Go 1.21+
- [ ] Run `cd src/server/multiplayer && go mod download`
- [ ] Test with `go run main.go handlers.go utils.go`
- [ ] Backend should listen on `http://localhost:5000`

### Phase 2: Register Multiplayer Routes

Add to deployment settings if not already configured:

```typescript
// src/deployment/settings/settings.mjs
export default {
  services: [
    // ... existing services
    {
      name: 'multiplayer',
      type: 'go',
      localPort: 5000,
      routePrefix: '/api/multiplayer'
    }
  ]
};
```

### Phase 3: Integrate into SceneManager

Update `src/client/managers/scene_manager.ts`:

```typescript
import { getMultiplayerManager } from './multiplayer_manager';

export class SceneManager {
  private multiplayerManager: MultiplayerManager;

  constructor(engine: BABYLON.Engine, canvas: HTMLCanvasElement) {
    // ... existing setup
    this.multiplayerManager = getMultiplayerManager();
    this.setupMultiplayerSync();
  }

  private setupMultiplayerSync(): void {
    // Listen for character state updates
    this.multiplayerManager.on('character-state-update', (update) => {
      // Update remote character meshes
      for (const state of update.updates) {
        this.applyRemoteCharacterState(state);
      }
    });

    // Listen for item updates
    this.multiplayerManager.on('item-state-update', (update) => {
      // Update item positions and collection state
      for (const itemState of update.updates) {
        this.applyRemoteItemState(itemState);
      }
      // Handle collections
      for (const collection of update.collections ?? []) {
        this.handleRemoteItemCollection(collection);
      }
    });

    // Similar setup for effects, lights, sky effects...
  }
}
```

### Phase 4: Add Player Join/Leave UI

Update HUD to show multiplayer status:

```typescript
// In HUDManager or SettingsUI
private renderMultiplayerStatus(): void {
  const mp = getMultiplayerManager();
  if (mp.isMultiplayerActive()) {
    const isSyncLabel = mp.isSynchronizer() ? '(Sync)' : '(Client)';
    this.statusElement.textContent = `Multiplayer ${isSyncLabel}`;
  }
}
```

### Phase 5: Integrate Sync Modules with Managers

#### Character Sync Integration

```typescript
// In CharacterController after state changes
private updateCharacterState(): void {
  // ... existing logic
  
  const characterSync = this.getCharacterSync();
  const state = characterSync.sampleState(Date.now());
  if (state && mp.isSynchronizer()) {
    const update = characterSync.createStateUpdate(Date.now(), [state]);
    mp.updateCharacterState(update);
  }
}
```

#### Item Sync Integration

```typescript
// In CollectiblesManager when item collected
public async collectItem(item: ItemInstance): Promise<void> {
  // ... existing logic
  
  const itemSync = this.getItemSync();
  itemSync.recordCollection({
    instanceId: item.id,
    itemName: item.name,
    collectedByClientId: mp.getClientID()!,
    creditsEarned: item.creditValue,
    timestamp: Date.now()
  });
  
  if (mp.isSynchronizer()) {
    const update = itemSync.createStateUpdate(Date.now());
    if (update) mp.updateItemState(update);
  }
}
```

#### Effects Sync Integration

```typescript
// In VisualEffectsManager when particle effect created
public createParticleEffect(particleSystem: BABYLON.IParticleSystem): void {
  // ... existing logic
  
  const effectsSync = this.getEffectsSync();
  effectsSync.updateParticleEffect({
    effectId: particleSystem.name,
    snippetName: snippetName,
    position: serializeVector3(particleSystem.emitter.position),
    isActive: true,
    timestamp: Date.now()
  });
  
  if (mp.isSynchronizer()) {
    const update = effectsSync.createStateUpdate(Date.now());
    if (update) mp.updateEffectsState(update);
  }
}
```

#### Lights Sync Integration

```typescript
// In SceneManager when creating lights
private createLight(config: LightConfig): void {
  // ... existing logic
  
  const lightsSync = this.getLightsSync();
  lightsSync.updateLight({
    lightId: light.name,
    lightType: config.lightType as LightType,
    position: config.position ? serializeVector3(config.position) : undefined,
    direction: config.direction ? serializeVector3(config.direction) : undefined,
    diffuseColor: serializeColor3(light.diffuse),
    intensity: light.intensity,
    isEnabled: light.isEnabled(),
    timestamp: Date.now()
  });
}
```

#### Sky Sync Integration

```typescript
// In SkyManager when applying effects
public effectHeatLightning(strength: number, frequency: number, duration: number): void {
  // ... existing logic
  
  const skySync = this.getSkySync();
  skySync.updateEffect({
    effectType: 'heatLightning',
    isActive: true,
    visibility: 1 - strength,
    intensity: frequency,
    durationMs: duration,
    elapsedMs: 0,
    timestamp: Date.now()
  });
  
  if (mp.isSynchronizer()) {
    const update = skySync.createStateUpdate(Date.now());
    if (update) mp.updateSkyEffects(update);
  }
}
```

---

## Usage Examples

### Joining Multiplayer Session

```typescript
const mp = getMultiplayerManager();
await mp.join('dystopia', 'alex');
console.log('Connected:', mp.isMultiplayerActive());
console.log('Synchronizer:', mp.isSynchronizer());
```

### Leaving Multiplayer

```typescript
await mp.leave();
console.log('Disconnected');
```

### Listening to State Updates

```typescript
mp.on('character-state-update', (update: CharacterStateUpdate) => {
  for (const state of update.updates) {
    if (state.clientId !== mp.getClientID()) {
      // Apply remote character state to mesh
      CharacterSync.applyRemoteCharacterState(remoteMesh, state);
    }
  }
});
```

---

## Synchronizer Role

### Responsibilities
1. **Detects changes**: Samples entity state each frame
2. **Throttles updates**: Only sends on significant changes (~20-50Hz)
3. **Broadcasts**: Sends PATCH to server with bulk updates
4. **Authoritative**: Server validates updates come from synchronizer only

### Role Assignment
- **First connected client** becomes synchronizer
- **On disconnect**: Next client in order becomes synchronizer
- **Server broadcasts**: `synchronizer-changed` signal to all clients

### State Update Throttling

Each sync module uses `ThrottledFunction` to limit update frequency:

```typescript
// Character: 50ms throttle (~20 Hz)
new CharacterSync(clientId, 50);

// Items: 100ms throttle (~10 Hz)
new ItemSync(100);

// Effects: 100ms throttle (~10 Hz)
new EffectsSync(100);

// Lights: 100ms throttle (~10 Hz)
new LightsSync(100);

// Sky: 100ms throttle (~10 Hz)
new SkySync(100);
```

---

## Update Flow Example: Character Movement

```
┌─ Timer every frame ─┐
│ Synchronizer Client │
│ CharacterController │
└──────────┬──────────┘
           │
      ┌────▼──────┐
      │ Character │
      │ moves     │
      └────┬──────┘
           │
      ┌────▼──────────────┐
      │ CharacterSync     │
      │ .sampleState()    │ (throttled every 50ms)
      └────┬──────────────┘
           │ Has significant change?
           ├─────→ YES ─┐
           │            │
           │        ┌───▼────────────┐
           │        │ MultiplayerMgr │
           │        │ .updateCharacter
           │        │ State()        │
           │        └───┬────────────┘
           │            │
           │        ┌───▼────────────┐
           │        │ Datastar.patch │
           │        │ /api/.../      │
           │        │ character-state│
           │        └───┬────────────┘
           │            │
           │        ┌───▼────────────┐
           │        │ Broadcaster: character-
           │        │ state-update  │
           │        │ signal → all  │
           │        └───┬────────────┘
           │            │
           │        ┌───▼──────────────┐
           │        │ All connected    │
           │        │ clients receive  │
           │        │ update & apply   │
           │        └──────────────────┘
           │
           └─────→ NO ─→ Skip this frame
```

---

## Security Considerations

1. **Synchronizer-Only Updates**: Server rejects updates from non-synchronizer clients
2. **Timestamp Validation**: Rejects updates older than 30 seconds
3. **Position Bounds**: Validates positions within ±10000 units
4. **Animation State**: Only accepts valid animation states
5. **Session Tokens**: SSE requires valid session ID

---

## Performance Optimization

### Update Throttling
- Character: 50ms (20 Hz max)
- Items: 100ms (10 Hz max)
- Effects: 100ms (10 Hz max)
- Lights: 100ms (10 Hz max)
- Sky: 100ms (10 Hz max)

### Significance Thresholds
- Position: 0.1 units
- Rotation: 0.05 radians (~2.9°)
- Animation Frame: 0.01 (1% change)

### Bulk Updates
All state updates batched into single SIGNAL message per type, reducing network overhead.

---

## Testing Multiplayer

### Local Testing (Two Clients)

```bash
# Terminal 1: Start backend
cd src/server/multiplayer
go run *.go

# Terminal 2: Start client dev server
npm run dev

# Terminal 3: Start client dev server on different port
PORT=3001 npm run dev
```

Open both clients in separate browser tabs and verify:
- [ ] Both show "Connected to multiplayer"
- [ ] First client shows "(Sync)", second shows "(Client)"
- [ ] Character movement from sync client appears on other clients
- [ ] Items collected sync to other clients
- [ ] Disconnect first client → second client becomes synchronizer

### Production Testing

Use `npm run build` and deploy backend following [DEPLOYMENT.md](src/deployment/DEPLOYMENT.md).

---

## Troubleshooting

### SSE Connection Fails
- Check backend is running: `curl http://localhost:5000/api/multiplayer/health`
- Verify CORS headers if cross-origin
- Check browser console for detailed errors

### Synchronizer Not Broadcasting
- Verify client has `isSynchronizer: true` from join response
- Check `MultiplayerManager.on('character-state-update'...)` listeners are registered
- Monitor network tab for PATCH requests

### Remote Characters Not Updating
- Verify synchronizer is moving and generating updates
- Check if client is subscribed to `character-state-update` signal
- Ensure `CharacterSync.applyRemoteCharacterState()` is called

### High Latency or Jitter
- Reduce throttle times (faster updates)
- Increase significance thresholds
- Consider client-side prediction/interpolation

---

## Future Enhancements

1. **Client-Side Prediction**: Interpolate remote character movement between updates
2. **Lag Compensation**: Account for network latency in physics
3. **Interest Management**: Only sync nearby entities
4. **Persistence**: Save multiplayer session state to database
5. **Matchmaking**: Auto-group players into sessions
6. **Rollback**: Handle out-of-order state updates
7. **Replication**: Replicate custom entity types (NPCs, projectiles, etc.)

---

## References

- [Datastar Go SDK](https://github.com/starfederation/datastar-go)
- [Babylon.js v9 Documentation](https://doc.babylonjs.com/)
- [Havok Physics Integration](https://www.babylonjs-playground.com/?version=9#NBVTQG)
