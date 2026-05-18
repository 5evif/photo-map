import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  // Treat src/renderer/ as the project root so index.html and renderer.js
  // are resolved relative to that directory, matching the file layout that
  // Electron and electron-builder already expect.
  root: 'src/renderer',

  // Use relative asset paths so the bundle works when loaded from a
  // file:// URL by Electron (absolute paths break on Windows).
  base: './',

  build: {
    // Write the production bundle to dist-renderer/ at the repo root.
    // main.js loads dist-renderer/index.html; electron-builder packages it.
    outDir: resolve(__dirname, 'dist-renderer'),
    emptyOutDir: true,

    rollupOptions: {
      output: {
        // Stable, hash-free filenames so Electron's loadFile path never
        // needs updating between rebuilds during development.
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      }
    }
  }
});
