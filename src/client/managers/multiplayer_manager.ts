// ============================================================================
// MULTIPLAYER MANAGER - Client-side orchestration
// ============================================================================

import {
  getDatastarClient,
  getMultiplayerHttpOrigin,
  type DatastarClient
} from '../datastar/datastar_client';
import { CONFIG } from '../config/game_config';
import type {
  MultiplayerClientState,
  JoinResponse,
  ItemStateUpdate,
  EffectStateUpdate,
  LightStateUpdate,
  SkyEffectStateUpdate,
  CharacterStateUpdate,
  SynchronizerChangedMessage,
  ClientConnectionEvent
} from '../types/multiplayer';

export interface MultiplayerManagerConfig {
  autoJoinOnInit?: boolean;
  updateThrottleMs?: number;
}

/**
 * Manages client-side multiplayer synchronization
 * 
 * Responsibilities:
 * - Join/leave multiplayer session
 * - Manage SSE connection via Datastar
 * - Orchestrate state sync across managers
 * - Handle synchronizer role and client leadership
 */
export class MultiplayerManager {
  private static instance: MultiplayerManager | null = null;
  
  private clientState: MultiplayerClientState | null = null;
  /** Base `https://host:port` for REST calls (may differ from page origin when using VITE_MULTIPLAYER_HOST). */
  private mpHttpOrigin: string | null = null;
  private datastarClient: DatastarClient;
  private isConnected = false;
  private listeners: Map<string, Set<Function>> = new Map();

  // Signal unsubscribers
  private unsubscribers: Array<() => void> = [];

  constructor(_config?: MultiplayerManagerConfig) {
    this.datastarClient = getDatastarClient();
    this.setupEventListeners();
  }

  /**
   * Gets or creates the singleton instance
   */
  public static getInstance(config?: MultiplayerManagerConfig): MultiplayerManager {
    if (!MultiplayerManager.instance) {
      MultiplayerManager.instance = new MultiplayerManager(config);
    }
    return MultiplayerManager.instance;
  }

  /**
   * Joins a multiplayer session
   */
  public async join(environmentName: string, characterName: string): Promise<void> {
    if (!CONFIG.MULTIPLAYER.ENABLED) {
      throw new Error('Multiplayer is disabled in configuration');
    }

    try {
      console.log('[MultiplayerManager] Joining multiplayer session...');

      this.mpHttpOrigin = await getMultiplayerHttpOrigin();
      // Ensure EventSource URL is set before connect (same promise as getDatastarClient, but avoid a race with its .then microtask).
      this.datastarClient.setUrl(`${this.mpHttpOrigin}/api/multiplayer/stream`);

      // Call join endpoint
      const response = await fetch(`${this.mpHttpOrigin}/api/multiplayer/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          environment_name: environmentName,
          character_name: characterName
        })
      });

      if (!response.ok) {
        throw new Error(`Join failed: ${response.status} ${response.statusText}`);
      }

      const joinResponse: JoinResponse = await response.json();

      // Store client state
      this.clientState = {
        clientId: joinResponse.client_id,
        isSynchronizer: joinResponse.is_synchronizer,
        sessionStarted: new Date().toISOString(),
        environment: environmentName,
        character: characterName
      };

      console.log(
        `[MultiplayerManager] Joined successfully`,
        {
          clientId: this.clientState.clientId,
          isSynchronizer: this.clientState.isSynchronizer,
          existingClients: joinResponse.existing_clients
        }
      );

      // Connect to SSE endpoint
      await this.connectSSE(joinResponse.session_id);

      this.isConnected = true;
      this.emit('connected', this.clientState);
    } catch (error) {
      this.mpHttpOrigin = null;
      console.error('[MultiplayerManager] Join failed:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Leaves the multiplayer session
   */
  public async leave(): Promise<void> {
    try {
      if (!this.clientState) {
        return;
      }

      console.log('[MultiplayerManager] Leaving multiplayer session...');

      // Unsubscribe from all signals
      for (const unsub of this.unsubscribers) {
        unsub();
      }
      this.unsubscribers = [];

      // Call leave endpoint
      const origin = this.mpHttpOrigin ?? (await getMultiplayerHttpOrigin());
      await fetch(`${origin}/api/multiplayer/leave`, {
        method: 'POST',
        headers: {
          'X-Client-ID': this.clientState.clientId
        }
      });

      // Disconnect SSE
      this.datastarClient.disconnect();

      this.isConnected = false;
      this.clientState = null;
      this.mpHttpOrigin = null;
      this.emit('disconnected');
    } catch (error) {
      console.error('[MultiplayerManager] Leave failed:', error);
    }
  }

  /**
   * Checks if multiplayer is enabled in configuration
   */
  public isEnabled(): boolean {
    return CONFIG.MULTIPLAYER.ENABLED;
  }

  /**
   * Checks if client is connected to multiplayer
   */
  public isMultiplayerActive(): boolean {
    return this.isConnected && this.clientState !== null;
  }

  /**
   * Checks if this client is the synchronizer
   */
  public isSynchronizer(): boolean {
    return this.clientState?.isSynchronizer ?? false;
  }

  /**
   * Gets current client state
   */
  public getClientState(): MultiplayerClientState | null {
    return this.clientState;
  }

  /**
   * Gets current client ID
   */
  public getClientID(): string | null {
    return this.clientState?.clientId ?? null;
  }

  /**
   * Sends this client's character pose. Every connected client may send their own avatar;
   * the server rejects updates whose `clientId` does not match `X-Client-ID`.
   * (World/item/effects sync remains synchronizer-only — see other update* methods.)
   */
  public async updateCharacterState(update: CharacterStateUpdate): Promise<void> {
    const st = this.clientState;
    if (!st) {
      return;
    }

    const origin = this.mpHttpOrigin ?? (await getMultiplayerHttpOrigin());
    try {
      await this.datastarClient.patch(
        `${origin}/api/multiplayer/character-state`,
        { updates: update.updates, timestamp: update.timestamp },
        { headers: { 'X-Client-ID': st.clientId } }
      );
    } catch (error) {
      console.error('[MultiplayerManager] Failed to update character state:', error);
    }
  }

  /**
   * Sends item state update (synchronizer only)
   */
  public async updateItemState(update: ItemStateUpdate): Promise<void> {
    if (!this.isSynchronizer()) {
      console.warn('[MultiplayerManager] Only synchronizer can update item state');
      return;
    }

    const st = this.clientState;
    if (!st) {
      return;
    }

    const origin = this.mpHttpOrigin ?? (await getMultiplayerHttpOrigin());
    try {
      await this.datastarClient.patch(
        `${origin}/api/multiplayer/item-state`,
        {
          updates: update.updates,
          collections: update.collections,
          timestamp: update.timestamp
        },
        { headers: { 'X-Client-ID': st.clientId } }
      );
    } catch (error) {
      console.error('[MultiplayerManager] Failed to update item state:', error);
    }
  }

  /**
   * Sends effects state update (synchronizer only)
   */
  public async updateEffectsState(update: EffectStateUpdate): Promise<void> {
    if (!this.isSynchronizer()) {
      console.warn('[MultiplayerManager] Only synchronizer can update effects state');
      return;
    }

    const st = this.clientState;
    if (!st) {
      return;
    }

    const origin = this.mpHttpOrigin ?? (await getMultiplayerHttpOrigin());
    try {
      await this.datastarClient.patch(
        `${origin}/api/multiplayer/effects-state`,
        {
          particle_effects: update.particleEffects,
          environment_particles: update.environmentParticles,
          timestamp: update.timestamp
        },
        { headers: { 'X-Client-ID': st.clientId } }
      );
    } catch (error) {
      console.error('[MultiplayerManager] Failed to update effects state:', error);
    }
  }

  /**
   * Sends lights state update (synchronizer only)
   */
  public async updateLightsState(update: LightStateUpdate): Promise<void> {
    if (!this.isSynchronizer()) {
      console.warn('[MultiplayerManager] Only synchronizer can update lights state');
      return;
    }

    const st = this.clientState;
    if (!st) {
      return;
    }

    const origin = this.mpHttpOrigin ?? (await getMultiplayerHttpOrigin());
    try {
      await this.datastarClient.patch(
        `${origin}/api/multiplayer/lights-state`,
        { updates: update.updates, timestamp: update.timestamp },
        { headers: { 'X-Client-ID': st.clientId } }
      );
    } catch (error) {
      console.error('[MultiplayerManager] Failed to update lights state:', error);
    }
  }

  /**
   * Sends sky effects update (synchronizer only)
   */
  public async updateSkyEffects(update: SkyEffectStateUpdate): Promise<void> {
    if (!this.isSynchronizer()) {
      console.warn('[MultiplayerManager] Only synchronizer can update sky effects');
      return;
    }

    const st = this.clientState;
    if (!st) {
      return;
    }

    const origin = this.mpHttpOrigin ?? (await getMultiplayerHttpOrigin());
    try {
      await this.datastarClient.patch(
        `${origin}/api/multiplayer/sky-effects-state`,
        { updates: update.updates, timestamp: update.timestamp },
        { headers: { 'X-Client-ID': st.clientId } }
      );
    } catch (error) {
      console.error('[MultiplayerManager] Failed to update sky effects:', error);
    }
  }

  /**
   * Subscribes to state updates
   */
  public on(
    eventName:
      | 'connected'
      | 'disconnected'
      | 'error'
      | 'character-state-update'
      | 'item-state-update'
      | 'effects-state-update'
      | 'lights-state-update'
      | 'sky-effects-state-update'
      | 'synchronizer-changed'
      | 'client-joined'
      | 'client-left',
    listener: Function
  ): () => void {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, new Set());
    }
    this.listeners.get(eventName)!.add(listener);

    // Return unsubscriber
    return () => {
      this.listeners.get(eventName)?.delete(listener);
    };
  }

  // ========================================================================
  // Private methods
  // ========================================================================

  private setupEventListeners(): void {
    // Listen for Datastar connection events
    this.datastarClient.addEventListener('connected', () => {
      console.log('[MultiplayerManager] SSE connection established');
    });

    this.datastarClient.addEventListener('disconnected', () => {
      console.log('[MultiplayerManager] SSE disconnected');
      if (this.isConnected) {
        this.emit('disconnected');
        this.isConnected = false;
      }
    });

    this.datastarClient.addEventListener('error', (error) => {
      console.error('[MultiplayerManager] SSE error:', error);
      this.emit('error', error);
    });
  }

  private async connectSSE(sessionID: string): Promise<void> {
    // Set session ID for SSE authentication
    this.datastarClient.setSessionID(sessionID);

    // Subscribe to state update signals
    const unsub1 = this.datastarClient.onSignal<CharacterStateUpdate>(
      'character-state-update',
      (data) => this.emit('character-state-update', data)
    );

    const unsub2 = this.datastarClient.onSignal<ItemStateUpdate>(
      'item-state-update',
      (data) => this.emit('item-state-update', data)
    );

    const unsub3 = this.datastarClient.onSignal<EffectStateUpdate>(
      'effects-state-update',
      (data) => this.emit('effects-state-update', data)
    );

    const unsub4 = this.datastarClient.onSignal<LightStateUpdate>(
      'lights-state-update',
      (data) => this.emit('lights-state-update', data)
    );

    const unsub5 = this.datastarClient.onSignal<SkyEffectStateUpdate>(
      'sky-effects-state-update',
      (data) => this.emit('sky-effects-state-update', data)
    );

    const unsub6 = this.datastarClient.onSignal<SynchronizerChangedMessage>(
      'synchronizer-changed',
      (data) => this.handleSynchronizerChanged(data)
    );

    const unsub7 = this.datastarClient.onSignal<ClientConnectionEvent>(
      'client-joined',
      (data) => this.emit('client-joined', data)
    );

    const unsub8 = this.datastarClient.onSignal<ClientConnectionEvent>(
      'client-left',
      (data) => this.emit('client-left', data)
    );

    this.unsubscribers.push(unsub1, unsub2, unsub3, unsub4, unsub5, unsub6, unsub7, unsub8);

    // Connect to SSE
    await this.datastarClient.connect();
  }

  private handleSynchronizerChanged(message: SynchronizerChangedMessage): void {
    if (this.clientState && message.newSynchronizerId === this.clientState.clientId) {
      this.clientState.isSynchronizer = true;
      console.log('[MultiplayerManager] This client became synchronizer');
    } else if (this.clientState) {
      this.clientState.isSynchronizer = false;
    }

    this.emit('synchronizer-changed', message);
  }

  private emit(eventName: string, data?: unknown): void {
    const listeners = this.listeners.get(eventName);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(data);
        } catch (error) {
          console.error(`[MultiplayerManager] Error in listener for ${eventName}:`, error);
        }
      }
    }
  }
}

/**
 * Convenience export for singleton access
 */
export function getMultiplayerManager(config?: MultiplayerManagerConfig): MultiplayerManager {
  return MultiplayerManager.getInstance(config);
}
