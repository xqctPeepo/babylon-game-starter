/**
 * Minimal `import.meta` shape under Vite. The playground bundle has no `vite/client` types.
 */
interface ImportMetaViteEnv {
  readonly env?: {
    readonly DEV?: boolean;
  };
}

/**
 * True when running under Vite in development; false in production and in the official playground.
 */
export function isViteDev(): boolean {
  const im = import.meta as unknown as ImportMetaViteEnv;
  return im.env?.DEV === true;
}

/**
 * Logs only in Vite dev; no-op in production builds and in the official playground.
 */
export function devLog(...args: unknown[]): void {
  if (isViteDev()) {
    console.log(...args);
  }
}
