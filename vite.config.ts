import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

import deploymentSettings from './src/deployment/settings/settings';

import type { EndpointService } from './src/deployment/types/settings';

// Use fileURLToPath so spaces in the repo path (e.g. "SIGMA PRODUCTIONS") are
// decoded. URL.pathname keeps "%20", which points at a different directory than
// the real workspace and breaks the HTML entry / dev server.
const clientRoot = fileURLToPath(new URL('./src/client/', import.meta.url));
const distOutDir = fileURLToPath(new URL('./dist/', import.meta.url));

const isStaticGithub =
  deploymentSettings.host === 'github.io' && deploymentSettings.type === 'static';

const base = isStaticGithub ? (deploymentSettings.static?.basePath ?? '/') : '/';

// Longer prefixes must win: `/api` matches `/api/multiplayer/*` if registered first,
// sending multiplayer traffic to the wrong backend (Node :8787 vs Go :5000).
const proxiedServices = deploymentSettings.services
  .filter((service: EndpointService) => typeof service.localPort === 'number')
  .slice()
  .sort((a, b) => b.routePrefix.length - a.routePrefix.length);

const serviceProxy = Object.fromEntries(
  proxiedServices.map((service: EndpointService) => [
    service.routePrefix,
    {
      target: `http://127.0.0.1:${service.localPort}`,
      changeOrigin: true
    }
  ])
) as Record<
  string,
  { target: string; changeOrigin: boolean; timeout?: number; proxyTimeout?: number }
>;

// Long-lived SSE streams must not inherit http-proxy default timeouts (can drop ~10s in dev).
const multiplayerPrefix = proxiedServices.find((s) => s.name === 'multiplayer')?.routePrefix;
if (multiplayerPrefix && serviceProxy[multiplayerPrefix]) {
  serviceProxy[multiplayerPrefix] = {
    ...serviceProxy[multiplayerPrefix],
    timeout: 0,
    proxyTimeout: 0
  };
}

export default defineConfig({
  root: clientRoot,
  base,
  server: {
    port: 3000,
    open: false,
    host: '0.0.0.0',
    strictPort: false,
    proxy: serviceProxy
  },
  build: {
    target: 'ES2020',
    outDir: distOutDir,
    sourcemap: true,
    emptyOutDir: true
  }
});
