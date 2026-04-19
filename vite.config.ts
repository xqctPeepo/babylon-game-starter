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

const serviceProxy = Object.fromEntries(
  deploymentSettings.services
    .filter((service: EndpointService) => typeof service.localPort === 'number')
    .map((service: EndpointService) => [
      service.routePrefix,
      {
        target: `http://localhost:${service.localPort}`,
        changeOrigin: true
      }
    ])
);

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
