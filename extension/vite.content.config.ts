import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const root = import.meta.dirname;

/**
 * Content scripts are injected as classic scripts, so they cannot be ES modules
 * and cannot share chunks with the rest of the build. This second pass emits a
 * single self-contained IIFE into the same dist folder.
 */
export default defineConfig({
  root,
  publicDir: false,
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: false,
    target: 'chrome116',
    sourcemap: true,
    minify: false,
    lib: {
      entry: resolve(root, 'src/content/index.ts'),
      name: 'InternshipAgentContent',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
  },
});
