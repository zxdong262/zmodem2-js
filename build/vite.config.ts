import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  server: {
    port: 3001,
    proxy: {
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true
      },
      '/terminal': {
        target: 'ws://localhost:8081',
        ws: true
      }
    }
  },
  resolve: {
    alias: {
      'zmodem2-js': resolve(__dirname, '../src/lib/index.ts')
    }
  },
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true
  }
})
