import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Library build: bundles the public API from src/index.ts as an ES module.
export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    target: 'es2022',
    sourcemap: true,
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'Monify',
      formats: ['es'],
      fileName: 'monify',
    },
    rollupOptions: {
      output: { inlineDynamicImports: false },
    },
  },
  server: {
    open: '/',
  },
});
