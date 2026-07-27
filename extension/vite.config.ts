import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const root = import.meta.dirname;

/** Copies manifest.json into dist so the built folder is directly loadable. */
function copyManifest(): Plugin {
  return {
    name: 'copy-manifest',
    apply: 'build',
    closeBundle() {
      const outDir = resolve(root, 'dist');
      mkdirSync(outDir, { recursive: true });
      copyFileSync(resolve(root, 'manifest.json'), resolve(outDir, 'manifest.json'));
    },
  };
}

export default defineConfig({
  root,
  publicDir: resolve(root, 'public'),
  plugins: [react(), copyManifest()],
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    target: 'chrome116',
    sourcemap: true,
    minify: false,
    rollupOptions: {
      input: {
        popup: resolve(root, 'popup.html'),
        options: resolve(root, 'options.html'),
        review: resolve(root, 'review.html'),
        fillPlan: resolve(root, 'fill-plan.html'),
        background: resolve(root, 'src/background/index.ts'),
      },
      output: {
        format: 'es',
        // The service worker path is fixed by manifest.json, so entry names must
        // be stable rather than hashed.
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
