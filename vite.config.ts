import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  root: resolve(__dirname, 'src'),
  server: {
    port: 3000,
    open: false,
    host: '0.0.0.0',
    strictPort: false
  },
  build: {
    target: 'ES2020',
    outDir: resolve(__dirname, 'dist'),
    sourcemap: true,
    emptyOutDir: true
  }
})
