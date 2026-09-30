import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['harness/**/*.test.ts', 'cases/**/*.test.ts', 'cases-intent/**/*.test.ts', 'cases-planning/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    // Ladybug's native runtime must not share one process across worker threads.
    pool: 'forks',
    testTimeout: 30_000,
  },
});
