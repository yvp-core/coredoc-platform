import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: ['reflect-metadata'],
    // The Ladybug native binding is not safe under the worker_threads pool: on
    // Linux the suite intermittently aborts with glibc heap corruption at
    // teardown ("free(): invalid next size"). Child processes isolate it.
    pool: 'forks',
    // A full-workspace `pnpm test` runs every package in parallel, and the first
    // test in a forked file pays that file's whole transform/import cost — under
    // that load an in-memory test flaked at the 5s default (diff-engine, 2026-08-30).
    // 30s is machine-load headroom, not permission for slow tests.
    testTimeout: 30_000,
  },
  plugins: [
    swc.vite({
      module: { type: 'es6' },
    }),
  ],
});
