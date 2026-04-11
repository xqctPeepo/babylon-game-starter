import { defineConfig } from 'vite'
import deploymentSettings from './src/deployment/settings/settings'
import type { EndpointService } from './src/deployment/types/settings'

const projectRoot = new URL('.', import.meta.url)
const clientRoot = new URL('./src/client/', projectRoot).pathname
const distOutDir = new URL('./dist/', projectRoot).pathname

const isStaticGithub =
  deploymentSettings.host === 'github.io' && deploymentSettings.type === 'static'

const base = isStaticGithub
  ? deploymentSettings.static?.basePath ?? '/'
  : '/'

const serviceProxy = Object.fromEntries(
  (deploymentSettings.services ?? [])
    .filter((service: EndpointService) => typeof service.localPort === 'number')
    .map((service: EndpointService) => [
      service.routePrefix,
      {
        target: `http://localhost:${service.localPort}`,
        changeOrigin: true
      }
    ])
)

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
})
