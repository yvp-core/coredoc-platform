import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // A full-workspace `pnpm test` runs every package in parallel, and a forked
    // file's first test pays its whole transform/import cost — the 5s default
    // flaked on loaded machines (remote.test/diff-engine/project-db-wiring,
    // 2026-08-30; profile-parser and evals already carried 30s for the same
    // reason). Machine-load headroom, not permission for slow tests.
    testTimeout: 30_000,
    include: ['src/**/*.test.ts'],
    // Real-backend suites load the Ladybug native binding, which is not safe
    // under the worker_threads pool (see packages/db/vitest.config.ts).
    poolMatchGlobs: [['**/*.backends.test.ts', 'forks']],
  },
});
