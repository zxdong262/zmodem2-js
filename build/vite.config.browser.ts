/**
 * Vite configuration for Browser build (IIFE format)
 * Output: dist/browser/
 */

import { defineConfig } from 'vite'
import { resolve } from 'path'
import dts from 'vite-plugin-dts'

export default defineConfig({
  plugins: [
    dts({
      include: ['src/lib/**/*'],
      outDir: 'dist/browser',
      entryRoot: 'src/lib',
      rollupTypes: false,
      tsconfigPath: './tsconfig.json'
    })
  ],
  build: {
    lib: {
      entry: resolve(__dirname, '../src/lib/index.ts'),
      name: 'Zmodem2',
      formats: ['iife'],
      fileName: () => 'zmodem2.js'
    },
    outDir: resolve(__dirname, '../dist/browser'),
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    rollupOptions: {
      output: {
        format: 'iife',
        name: 'Zmodem2',
        exports: 'named'
      }
    }
  }
})
