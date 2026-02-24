/**
 * Vite configuration for CommonJS full bundle (all dependencies bundled)
 * Output: dist/cjs-full/
 */

import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  plugins: [],
  build: {
    lib: {
      entry: resolve(__dirname, '../src/lib/index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.cjs'
    },
    outDir: resolve(__dirname, '../dist/cjs-full'),
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    rollupOptions: {
      output: {
        format: 'cjs',
        exports: 'named'
      }
    }
  }
})
