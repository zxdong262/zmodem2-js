/**
 * Vite configuration for ESM build (tree-shakeable)
 * Output: dist/esm/
 */

import { defineConfig } from 'vite'
import { resolve } from 'path'
import dts from 'vite-plugin-dts'

export default defineConfig({
  plugins: [
    dts({
      include: ['src/lib/**/*'],
      outDir: 'dist/esm',
      entryRoot: 'src/lib',
      rollupTypes: false,
      tsconfigPath: './tsconfig.json'
    })
  ],
  build: {
    lib: {
      entry: resolve(__dirname, '../src/lib/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js'
    },
    outDir: resolve(__dirname, '../dist/esm'),
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    rollupOptions: {
      output: {
        format: 'es',
        preserveModules: true,
        preserveModulesRoot: 'src/lib',
        exports: 'named'
      }
    }
  }
})
