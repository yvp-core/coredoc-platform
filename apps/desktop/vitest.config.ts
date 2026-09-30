import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Unit tests for the desktop app's pure logic (permission policy, agent-run adapter/reducer).
// Electron and the renderer DOM are out of scope — component tests must mock window.electronAPI.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
    // Under a full-workspace `pnpm test` every package runs in parallel and the
    // first test importing a heavy module graph (command-runner) pays its whole
    // transform cost — the 5s default flaked exactly there (project-db-wiring,
    // 2026-08-30). 30s is machine-load headroom, not permission for slow tests.
    testTimeout: 30_000,
    // Anything resolving the coredoc home (desktop-settings.json, and through
    // it the server-URL chain) would otherwise read the *installed* app's real
    // ~/.coredoc on a developer machine, so results depend on which server the
    // dev last logged into. Pin it to a throwaway dir.
    env: { COREDOC_HOME: join(tmpdir(), 'coredoc-desktop-tests') },
  },
});
