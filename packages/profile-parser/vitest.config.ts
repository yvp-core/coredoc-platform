import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Substrate tests are integration runs: each worker cold-loads tree-sitter WASM and
    // spawns the SCIP indexer subprocess. Locally that's <1s, but on a contended CI box
    // the first test in a worker can absorb multi-second init and blow the 5s default.
    testTimeout: 30_000,
  },
});
