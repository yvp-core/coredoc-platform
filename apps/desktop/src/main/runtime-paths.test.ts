import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const USER_DATA = join(tmpdir(), 'coredoc-runtime-paths-test');

// runtime-paths reads app.isPackaged / app.getPath at call time — mock before import.
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => USER_DATA, getAppPath: () => USER_DATA },
}));

let seededWorkspace: string;

beforeEach(() => {
  vi.resetModules();
  seededWorkspace = mkdtempSync(join(tmpdir(), 'coredoc-e2e-workspace-'));
});

describe('ensureTreeSitterWasmDir — development runtime', () => {
  it('copies the parser runtime and grammars into the worker directory', async () => {
    const { app } = await import('electron');
    const getPath = vi.spyOn(app, 'getPath').mockReturnValue(seededWorkspace);
    // pnpm exposes the whole virtual store through NODE_PATH in test scripts.
    // Electron has no such fallback; exercise its dependency resolution here.
    const nodeModule = createRequire(import.meta.url)('node:module');
    vi.stubEnv('NODE_PATH', '');
    nodeModule._initPaths();
    try {
      const { ensureTreeSitterWasmDir } = await import('./runtime-paths.js');
      const wasmDir = ensureTreeSitterWasmDir();

      expect(wasmDir).toBe(join(seededWorkspace, 'tree-sitter-wasm'));
      for (const name of ['web-tree-sitter.wasm', 'tree-sitter-typescript.wasm', 'tree-sitter-c_sharp.wasm']) {
        const bytes = readFileSync(join(wasmDir!, name));
        expect([...bytes.subarray(0, 4)]).toEqual([0, 97, 115, 109]);
      }
    } finally {
      vi.unstubAllEnvs();
      nodeModule._initPaths();
      getPath.mockRestore();
    }
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(seededWorkspace, { recursive: true, force: true });
});

describe('initProjectRoot — e2e workspace override', () => {
  it('resolves the seeded workspace dir in e2e mode', async () => {
    vi.stubEnv('COREDOC_DESKTOP_E2E', '1');
    vi.stubEnv('COREDOC_DESKTOP_E2E_WORKSPACE_DIR', seededWorkspace);

    const { initProjectRoot, getProjectRoot } = await import('./runtime-paths.js');
    await initProjectRoot();

    expect(getProjectRoot()).toBe(seededWorkspace);
  });

  it('ignores the variable outside e2e mode (a stray env var cannot redirect a dev run)', async () => {
    vi.stubEnv('COREDOC_DESKTOP_E2E_WORKSPACE_DIR', seededWorkspace);

    const { initProjectRoot, getProjectRoot } = await import('./runtime-paths.js');
    await initProjectRoot();

    expect(getProjectRoot()).not.toBe(seededWorkspace);
  });

  it('throws instead of falling back to the real monorepo when the dir is missing', async () => {
    vi.stubEnv('COREDOC_DESKTOP_E2E', '1');
    vi.stubEnv('COREDOC_DESKTOP_E2E_WORKSPACE_DIR', join(seededWorkspace, 'nope'));

    const { initProjectRoot } = await import('./runtime-paths.js');
    await expect(initProjectRoot()).rejects.toThrow(/not an existing directory/);
  });

  it('throws instead of falling back to the dev root when the var is unset under the flag', async () => {
    vi.stubEnv('COREDOC_DESKTOP_E2E', '1');

    const { initProjectRoot } = await import('./runtime-paths.js');
    await expect(initProjectRoot()).rejects.toThrow(/COREDOC_DESKTOP_E2E_WORKSPACE_DIR/);
  });
});
