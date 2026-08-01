import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Multi-page build — the landing page and each demo are separate entries.
export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        estate: resolve(__dirname, 'demos/estate/index.html'),
        treemap: resolve(__dirname, 'demos/treemap/index.html'),
        hexgrid: resolve(__dirname, 'demos/hexgrid/index.html'),
        workloadMap: resolve(__dirname, 'demos/workload-map/index.html'),
      },
    },
  },
});
