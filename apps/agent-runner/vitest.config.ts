import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Machine-load headroom for a full-workspace `pnpm test`, as in the other packages.
    testTimeout: 30_000,
    include: ['src/**/*.test.ts'],
  },
});
