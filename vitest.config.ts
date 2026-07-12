import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/color/**/*.ts', 'src/viz/**/*.ts'],
      exclude: ['src/viz/**/*-viz.ts', 'src/viz/viz-base.ts'],
    },
  },
});
