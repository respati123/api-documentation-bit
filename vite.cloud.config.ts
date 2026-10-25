import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'src/cloud',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    proxy: {
      '/api/': 'http://localhost:3001',
      '/health': 'http://localhost:3001'
    }
  },
  build: {
    outDir: resolve('dist-cloud'),
    emptyOutDir: true
  }
})
