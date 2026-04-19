/**
 * Logs only in Vite dev; no-op in production builds.
 */
export function devLog(...args: unknown[]): void {
  if (import.meta.env.DEV) {
    console.log(...args);
  }
}
