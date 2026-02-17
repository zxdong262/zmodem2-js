/**
 * Vite configuration for CommonJS build
 * Output: dist/cjs/
 */

import { defineConfig } from 'vite'
import { resolve } from 'path'
import dts from 'vite-plugin-dts'

export default defineConfig({
  plugins: [
    dts({
      include: ['src/lib/**/*'],
      outDir: 'dist/cjs',
      entryRoot: 'src/lib',
      rollupTypes: false,
      tsconfigPath: './tsconfig.json'
    })
  ],
  build: {
    lib: {
      entry: resolve(__dirname, '../src/lib/index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.cjs'
    },
    outDir: resolve(__dirname, '../dist/cjs'),
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    rollupOptions: {
      output: {
        format: 'cjs',
        preserveModules: true,
        preserveModulesRoot: 'src/lib',
        exports: 'named'
      }
    }
  }
})
