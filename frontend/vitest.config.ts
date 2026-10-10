import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // Gate the logic layer (formatting, geometry, motion, store helpers and selectors). Rendering
      // code (React components, the Three.js scene) is covered by the Playwright e2e suite instead.
      include: ['src/lib/**/*.ts', 'src/store/**/*.ts'],
      exclude: ['src/lib/earthScene.ts', 'src/lib/earth/**', 'src/lib/satelliteModels.ts', 'src/store/slices/**',
                'src/store/types.ts', 'src/**/*.d.ts'],
      reporter: ['text-summary', 'lcov'],
      // Ratchet these up as coverage grows; CI fails below them (npm run test:coverage).
      thresholds: { lines: 78, statements: 78, branches: 85, functions: 45 },
    },
  },
});
