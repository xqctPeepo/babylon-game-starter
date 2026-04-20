// ============================================================================
// DATASTAR CLIENT SDK WRAPPER - SSE (Server-Sent Events)
// ============================================================================

/**
 * Lightweight Datastar client wrapper for browser-based multiplayer sync.
 * 
 * This module provides:
 * - SSE (Server-Sent Events) connection management via EventSource
 * - Signal subscription/unsubscription
 * - PATCH request handling
 * - Automatic reconnection with exponential backoff
 * - Configurable server endpoints (production or local)
 * 
 * The Datastar way: server-sent `datastar-patch-signals` events (JSON from the Go SDK
 * `MarshalAndPatchSignals` patch-signals wire format). This client uses `EventSource` and dispatches by signal name.
 */

export interface DatastarSignalListener<T = unknown> {
  (data: T): void;
}

export interface DatastarEventMap {
  'connected': undefined;
  'disconnected': undefined;
  'error': Error;
}

export class DatastarClient {
  private eventSource: EventSource | null = null;
  private sseUrl: string;
  private signalListeners: Map<string, Set<DatastarSignalListener>> = new Map();
  private eventListeners: Map<keyof DatastarEventMap, Set<Function>> = new Map();
  private messageIndex = 0;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelayMs = 1000;
  private isIntentionallyClosed = false;
  private sessionID: string = '';

  constructor(sseUrl: string) {
    this.sseUrl = sseUrl;
  }

  /**
   * Updates the SSE URL (for lazy endpoint detection)
   */
  public setUrl(sseUrl: string): void {
    this.sseUrl = sseUrl;
  }

  /**
   * Sets the session ID for SSE authentication
   */
  public setSessionID(sessionID: string): void {
    this.sessionID = sessionID;
  }

  /**
   * Connects to the Datastar server via SSE with timeout
   */
  public async connect(timeoutMs?: number): Promise<void> {
    const { CONFIG } = await import('../config/game_config');
    const effectiveMs = timeoutMs ?? CONFIG.MULTIPLAYER.CONNECTION_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      let connectionTimeout: ReturnType<typeof setTimeout> | null = null;
      let settled = false;

      const finish = (action: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }
        action();
      };

      try {
        // Build SSE URL with session and client ID headers
        const url = new URL(this.sseUrl, window.location.origin);
        if (this.sessionID) {
          url.searchParams.set('sid', this.sessionID);
        }

        // Create EventSource for SSE connection
        this.eventSource = new EventSource(url.toString());

        // Set connection timeout (CONNECTING without onopen — e.g. proxy stalled)
        connectionTimeout = setTimeout(() => {
          if (this.eventSource && this.eventSource.readyState === EventSource.CONNECTING) {
            this.eventSource.close();
            finish(() =>
              reject(new Error(`Connection timeout after ${effectiveMs}ms`))
            );
          }
        }, effectiveMs);

        this.eventSource.onopen = () => {
          finish(() => {
            this.reconnectAttempts = 0;
            this.reconnectDelayMs = 1000;
            this.emit('connected');
            resolve();
          });
        };

        // Official datastar-go wire format: event type datastar-patch-signals (see EventTypePatchSignals).
        this.eventSource.addEventListener('datastar-patch-signals', (event: MessageEvent<string>) => {
          this.handlePatchSignalsEvent(event.data);
        });

        // Legacy/default SSE messages (optional fallback)
        this.eventSource.addEventListener('message', (event) => {
          this.handleMessage(event.data);
        });

        this.eventSource.onerror = () => {
          // While CONNECTING, some browsers fire transient errors; only act on a closed stream.
          if (this.eventSource?.readyState !== EventSource.CLOSED) {
            return;
          }
          const error = new Error('SSE connection closed');
          this.emit('error', error);
          if (!this.isIntentionallyClosed) {
            this.attemptReconnect();
          }
          // Reject is a no-op if onopen already called finish (settled).
          finish(() => reject(error));
        };
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }

  /**
   * Disconnects from the server
   */
  public disconnect(): void {
    this.isIntentionallyClosed = true;
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  /**
   * Subscribes to a server signal
   */
  public onSignal<T = unknown>(
    signalName: string,
    listener: DatastarSignalListener<T>
  ): () => void {
    if (!this.signalListeners.has(signalName)) {
      this.signalListeners.set(signalName, new Set());
    }
    this.signalListeners.get(signalName)!.add(listener as DatastarSignalListener);

    // Return unsubscribe function
    return () => {
      const listeners = this.signalListeners.get(signalName);
      if (listeners) {
        listeners.delete(listener as DatastarSignalListener);
      }
    };
  }

  /**
   * Sends a PATCH request to the server
   */
  public async patch(
    path: string,
    data: Record<string, unknown>,
    options?: { headers?: Record<string, string> }
  ): Promise<Response> {
    const headers = {
      'Content-Type': 'application/json',
      ...options?.headers
    };

    const response = await fetch(path, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(data)
    });

    if (!response.ok) {
      throw new Error(`PATCH ${path} failed: ${response.status} ${response.statusText}`);
    }

    return response;
  }

  /**
   * Sends a POST request to the server
   */
  public async post(
    path: string,
    data: Record<string, unknown>,
    options?: { headers?: Record<string, string> }
  ): Promise<Response> {
    const headers = {
      'Content-Type': 'application/json',
      ...options?.headers
    };

    const response = await fetch(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(data)
    });

    if (!response.ok) {
      throw new Error(`POST ${path} failed: ${response.status} ${response.statusText}`);
    }

    return response;
  }

  /**
   * Checks if connected to server
   */
  public isConnected(): boolean {
    return this.eventSource?.readyState === EventSource.OPEN;
  }

  /**
   * Gets current message index (for deduplication)
   */
  public getMessageIndex(): number {
    return this.messageIndex;
  }

  /**
   * Subscribes to connection events
   */
  public addEventListener<K extends keyof DatastarEventMap>(
    event: K,
    listener: (data: DatastarEventMap[K]) => void
  ): () => void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(listener);

    // Return unsubscribe function
    return () => {
      const listeners = this.eventListeners.get(event);
      if (listeners) {
        listeners.delete(listener);
      }
    };
  }

  // ========================================================================
  // Private methods
  // ========================================================================

  private handleMessage(rawData: string): void {
    try {
      const data = JSON.parse(rawData);

      // Datastar SIGNAL message format
      if (data.type === 'signal' && data.name) {
        const listeners = this.signalListeners.get(data.name);
        if (listeners) {
          for (const listener of listeners) {
            listener(data.payload ?? data.data);
          }
        }
      }

      this.messageIndex++;
    } catch (error) {
      console.warn('Failed to parse SSE message:', error);
    }
  }

  /**
   * Parses SSE payload from datastar-go PatchSignals / MarshalAndPatchSignals:
   * one or more lines `signals <json fragment>` (fragments join on newlines to recreate JSON).
   */
  private handlePatchSignalsEvent(rawData: string): void {
    try {
      const lines = rawData.split('\n');
      const fragments: string[] = [];
      for (const line of lines) {
        const trimmed = line.replace(/\r$/, '');
        if (trimmed.startsWith('signals ')) {
          fragments.push(trimmed.slice('signals '.length));
        }
      }
      if (fragments.length === 0) {
        return;
      }
      const merged = fragments.join('\n');
      const patch = JSON.parse(merged) as { mp?: { name?: string; payload?: unknown } };
      const name = patch.mp?.name;
      if (!name) {
        return;
      }
      const listeners = this.signalListeners.get(name);
      if (listeners) {
        for (const listener of listeners) {
          listener(patch.mp!.payload as never);
        }
      }
      this.messageIndex++;
    } catch (error) {
      console.warn('Failed to parse datastar-patch-signals message:', error);
    }
  }

  private emit<K extends keyof DatastarEventMap>(
    event: K,
    data?: DatastarEventMap[K]
  ): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        (listener as Function)(data);
      }
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1);

    console.log(
      `Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${delay}ms...`
    );

    setTimeout(() => {
      this.connect().catch(() => {
        // Retry will be handled by next attemptReconnect
      });
    }, delay);
  }
}

/**
 * Global Datastar client instance
 */
let globalDatastarClient: DatastarClient | null = null;

/** Single flight: health probe + chosen stream URL (absolute). */
let resolvedStreamUrlPromise: Promise<string> | null = null;

function ensureMultiplayerStreamUrlResolved(): Promise<string> {
  if (!resolvedStreamUrlPromise) {
    resolvedStreamUrlPromise = determineMultiplayerUrl();
  }
  return resolvedStreamUrlPromise;
}

/**
 * Origin of the Go multiplayer service (`https://host[:port]`), after the same discovery
 * as the SSE client. Use for `join` / `leave` / `PATCH` when the game SPA is not same-origin
 * with the API (e.g. fork deploys static site + separate Render service).
 */
export async function getMultiplayerHttpOrigin(): Promise<string> {
  const streamUrl = await ensureMultiplayerStreamUrlResolved();
  return new URL(streamUrl).origin;
}

function normalizeMultiplayerHostInput(raw: string): string {
  let s = raw.trim();
  if (!s) {
    return '';
  }
  if (s.startsWith('https://')) {
    s = s.slice('https://'.length);
  } else if (s.startsWith('http://')) {
    s = s.slice('http://'.length);
  }
  s = s.split('/')[0] ?? '';
  return s.trim();
}

async function determineMultiplayerUrl(): Promise<string> {
  // Late import to avoid circular dependency issues
  const { CONFIG } = await import('../config/game_config');

  if (!CONFIG.MULTIPLAYER.ENABLED) {
    throw new Error('Multiplayer is disabled in configuration');
  }

  const timeoutMs = CONFIG.MULTIPLAYER.CONNECTION_TIMEOUT_MS;
  const envRaw = import.meta.env.VITE_MULTIPLAYER_HOST;
  const envHost =
    typeof envRaw === 'string' && envRaw.trim().length > 0
      ? normalizeMultiplayerHostInput(envRaw)
      : '';

  if (envHost) {
    const only = await attemptServerConnection(envHost, timeoutMs);
    if (only) {
      return only;
    }
    throw new Error(
      `VITE_MULTIPLAYER_HOST is set to "${envHost}" but health check failed. Fix the host or unset the variable to use CONFIG.MULTIPLAYER defaults.`
    );
  }

  // `npm run dev`: same-origin requests hit the Vite proxy → Go on :5000 (no remote probe, no CORS).
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    return `${window.location.origin}/api/multiplayer/stream`;
  }

  const productionServer = CONFIG.MULTIPLAYER.PRODUCTION_SERVER;
  const localServer = CONFIG.MULTIPLAYER.LOCAL_SERVER;
  const tryProductionFirst = CONFIG.MULTIPLAYER.PRODUCTION_FIRST;

  const primaryServer = tryProductionFirst ? productionServer : localServer;
  const fallbackServer = tryProductionFirst ? localServer : productionServer;

  const primaryUrl = await attemptServerConnection(primaryServer, timeoutMs);
  if (primaryUrl) {
    return primaryUrl;
  }

  const fallbackUrl = await attemptServerConnection(fallbackServer, timeoutMs);
  if (fallbackUrl) {
    return fallbackUrl;
  }

  throw new Error(
    `Failed to connect to multiplayer servers: ${primaryServer} and ${fallbackServer}`
  );
}

/**
 * Attempts to connect to a server and returns the SSE URL if successful
 */
async function attemptServerConnection(server: string, timeoutMs: number): Promise<string | null> {
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';

  try {
    console.log(`[Datastar] Checking server at ${server}...`);

    // Health check with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${protocol}//${server}/api/multiplayer/health`, {
      signal: controller.signal,
      mode: 'cors'
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const sseUrl = `${protocol}//${server}/api/multiplayer/stream`;
      console.log(`[Datastar] ✓ Server available at ${server}`);
      return sseUrl;
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.log(`[Datastar] Server at ${server} unavailable (${errorMsg})`);
  }

  return null;
}

/**
 * Gets or creates the global Datastar client
 * Automatically detects and selects appropriate multiplayer server
 */
export function getDatastarClient(): DatastarClient {
  if (!globalDatastarClient) {
    const initialStream =
      import.meta.env.DEV && typeof window !== 'undefined'
        ? `${window.location.origin}/api/multiplayer/stream`
        : 'http://127.0.0.1:5000/api/multiplayer/stream';
    globalDatastarClient = new DatastarClient(initialStream);

    ensureMultiplayerStreamUrlResolved()
      .then((url) => {
        if (globalDatastarClient) {
          globalDatastarClient.setUrl(url);
          console.log('[Datastar] SSE endpoint configured successfully');
        }
      })
      .catch((error) => {
        console.warn('[Datastar] Failed to determine multiplayer server:', error);
        console.warn('[Datastar] Multiplayer will not be available');
      });
  }
  return globalDatastarClient;
}

/**
 * Sets a custom global Datastar client (for testing)
 */
export function setDatastarClient(client: DatastarClient | null): void {
  globalDatastarClient = client;
  if (client === null) {
    resolvedStreamUrlPromise = null;
  }
}
