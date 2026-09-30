import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const smokeScript = fileURLToPath(new URL('../../scripts/smoke-packaged-runtime.mjs', import.meta.url));
const desktopPackageJson = fileURLToPath(new URL('../../package.json', import.meta.url));
const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'coredoc-packaged-smoke-'));
  tempRoots.push(root);
  return root;
}

function createPackagedFixture(
  layout: string[],
  distElectron = join(createTempRoot(), 'dist-electron'),
): { distElectron: string; resources: string } {
  const resources = join(distElectron, ...layout, 'Coredoc.app', 'Contents', 'Resources');
  const runtime = join(resources, 'app.asar.unpacked', 'dist', 'runtime');

  mkdirSync(join(runtime, 'packages', 'cli', 'dist'), { recursive: true });
  mkdirSync(join(runtime, 'packages', 'mcp', 'dist'), { recursive: true });
  mkdirSync(join(runtime, 'node_modules', '@coredoc', 'profile-parser', 'dist'), {
    recursive: true,
  });
  mkdirSync(join(runtime, 'node_modules', 'typescript', 'lib'), { recursive: true });

  writeFileSync(join(resources, 'app.asar'), '');
  writeFileSync(join(runtime, 'packages', 'cli', 'dist', 'index.js'), '');
  writeFileSync(join(runtime, 'packages', 'mcp', 'dist', 'index.js'), '');
  writeFileSync(join(runtime, 'node_modules', '@coredoc', 'profile-parser', 'dist', 'index.d.ts'), '');
  writeFileSync(join(runtime, 'node_modules', 'typescript', 'lib', 'lib.es2022.d.ts'), '');

  return { distElectron, resources };
}

function runPostSmoke(distElectron: string) {
  return spawnSync(process.execPath, [smokeScript, '--post'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      COREDOC_SMOKE_DIST_ELECTRON: distElectron,
      COREDOC_SMOKE_PLATFORM: 'darwin',
    },
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('packaged desktop smoke test', () => {
  it('rebuilds and smoke-checks the local macOS package instead of reusing stale dist output', () => {
    const manifest = JSON.parse(readFileSync(desktopPackageJson, 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(manifest.scripts?.['build:mac']).toBe(
      'pnpm run build && pnpm run smoke && electron-builder --mac --config.directories.output=dist-electron/mac && COREDOC_SMOKE_DIST_ELECTRON=dist-electron/mac pnpm run smoke:post',
    );
  });

  it('inspects the scoped fresh macOS output instead of a valid stale sibling', () => {
    const distElectron = join(createTempRoot(), 'dist-electron');
    const { resources: staleResources } = createPackagedFixture(['macOS-arm64', 'mac-arm64'], distElectron);
    const freshResources = join(distElectron, 'mac', 'mac-arm64', 'Coredoc.app', 'Contents', 'Resources');
    mkdirSync(freshResources, { recursive: true });

    const unscoped = runPostSmoke(distElectron);
    expect(unscoped.status, `${unscoped.stdout}\n${unscoped.stderr}`).toBe(0);
    expect(unscoped.stdout).toContain(`Resources dir: ${staleResources}`);

    const scoped = runPostSmoke(join(distElectron, 'mac'));
    expect(scoped.status).toBe(1);
    expect(scoped.stdout).toContain(`Resources dir: ${freshResources}`);
    expect(scoped.stdout).toContain('app.asar exists');
    expect(scoped.stdout).not.toContain(`Resources dir: ${staleResources}`);
  });

  it.each([
    ['arm64', ['macOS-arm64', 'mac-arm64']],
    ['x64', ['macOS-x64', 'mac']],
  ])('finds the production macOS %s layout', (_architecture, layout) => {
    const { distElectron, resources } = createPackagedFixture(layout);

    const result = runPostSmoke(distElectron);

    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`Resources dir: ${resources}`);
    expect(result.stdout).toContain('10 passed, 0 failed');
  });

  it('fails when the packaged output directory is missing', () => {
    const missingOutput = join(createTempRoot(), 'dist-electron');

    const result = runPostSmoke(missingOutput);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('packaged output directory exists');
    expect(result.stdout).toContain('0 passed, 1 failed');
    expect(result.stdout).not.toContain('[skip]');
  });

  it('fails when no packaged resources directory can be found', () => {
    const distElectron = join(createTempRoot(), 'dist-electron');
    mkdirSync(distElectron, { recursive: true });

    const result = runPostSmoke(distElectron);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('packaged resources directory found');
    expect(result.stdout).toContain('0 passed, 1 failed');
    expect(result.stdout).not.toContain('[skip]');
  });
});
