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
    // Deliberately false, even though this is the first of the two passes.
    //
    // `content.js` is written by the second pass into this same folder. With
    // `emptyOutDir: true` this pass deleted it, which is invisible in a full
    // build (the second pass runs straight after) and fatal in `--watch`, where
    // the second pass never runs at all: every rebuild removed the content
    // script and left Chrome running whatever it had already loaded. That is
    // how the scanner and the worker ended up on different builds, and how a
    // field type the scanner had learned was rejected by a worker that had not.
    //
    // The build script empties `dist` explicitly first instead, so a full build
    // is still clean and a watch rebuild no longer destroys the other pass.
    emptyOutDir: false,
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
