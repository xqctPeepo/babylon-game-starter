/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Host[:port] for the Go multiplayer service; overrides CONFIG.MULTIPLAYER discovery. */
  readonly VITE_MULTIPLAYER_HOST?: string;
}
