import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StableIdGenerator } from '@coredoc/core';
import { afterEach, describe, expect, it } from 'vitest';
import { detectWorkspacePackages, ownerPackagePath, type WorkspacePackage } from './workspace.js';

// --- temp-repo scaffolding -------------------------------------------------
const tmpRoots: string[] = [];
afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Create a throwaway repo dir whose files are `{ relPath: contents }`. Not a git repo, so
 * detection falls through enumerateRepoFiles' filesystem-walk path. */
function scaffold(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ws-detect-'));
  tmpRoots.push(root);
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, contents);
  }
  return root;
}

const pkgJson = (name: string) => JSON.stringify({ name });

describe('ownerPackagePath (longest-prefix assignment)', () => {
  const pkgs: WorkspacePackage[] = [
    { path: '.', name: 'root' },
    { path: 'apps', name: 'apps-umbrella' },
    { path: 'apps/server', name: '@x/server' },
    { path: 'packages/core', name: '@x/core' },
  ];

  it('maps a file to the deepest package that prefixes it', () => {
    expect(ownerPackagePath('apps/server/src/x.ts', pkgs)).toBe('apps/server');
    expect(ownerPackagePath('packages/core/index.ts', pkgs)).toBe('packages/core');
  });

  it('prefers the longer prefix when packages nest (apps/server beats apps)', () => {
    expect(ownerPackagePath('apps/server/main.ts', pkgs)).toBe('apps/server');
    // a file under apps but outside apps/server falls to the shorter 'apps' package
    expect(ownerPackagePath('apps/other/main.ts', pkgs)).toBe('apps');
  });

  it('matches a file that IS the package path exactly', () => {
    expect(ownerPackagePath('apps/server', pkgs)).toBe('apps/server');
  });

  it('falls back to the repo root for files under no package', () => {
    expect(ownerPackagePath('README.md', pkgs)).toBe('.');
    expect(ownerPackagePath('scripts/build.ts', pkgs)).toBe('.');
    // a sibling that only shares a partial segment name must NOT match packages/core
    expect(ownerPackagePath('packages/core-utils/x.ts', pkgs)).toBe('.');
  });
});

describe('detectWorkspacePackages', () => {
  it('detects packages from pnpm-workspace.yaml globs', () => {
    const root = scaffold({
      'package.json': pkgJson('monorepo-root'),
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - 'apps/*'\n",
      'packages/core/package.json': pkgJson('@x/core'),
      'packages/cli/package.json': pkgJson('@x/cli'),
      'apps/server/package.json': pkgJson('@x/server'),
      // has no package.json → not a member, even though it is under apps/*
      'apps/notes.md': '# not a package',
    });
    const pkgs = detectWorkspacePackages(root, 'monorepo-root');
    const byPath = new Map(pkgs.map((p) => [p.path, p.name]));

    expect(byPath.get('.')).toBe('monorepo-root'); // root fallback, named for the repo
    expect(byPath.get('packages/core')).toBe('@x/core');
    expect(byPath.get('packages/cli')).toBe('@x/cli');
    expect(byPath.get('apps/server')).toBe('@x/server');
    expect(pkgs).toHaveLength(4);
  });

  it('detects packages from a root package.json "workspaces" array', () => {
    const root = scaffold({
      'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
      'packages/a/package.json': pkgJson('@x/a'),
      'packages/b/package.json': pkgJson('@x/b'),
    });
    const paths = detectWorkspacePackages(root, 'root')
      .map((p) => p.path)
      .sort();
    expect(paths).toEqual(['.', 'packages/a', 'packages/b']);
  });

  it('detects packages from the { workspaces: { packages: [] } } (Yarn/Lerna) shape', () => {
    const root = scaffold({
      'package.json': JSON.stringify({ name: 'root', workspaces: { packages: ['modules/*'] } }),
      'modules/one/package.json': pkgJson('@x/one'),
    });
    const paths = detectWorkspacePackages(root, 'root')
      .map((p) => p.path)
      .sort();
    expect(paths).toEqual(['.', 'modules/one']);
  });

  it('honors a pnpm "!" exclusion glob', () => {
    const root = scaffold({
      'package.json': pkgJson('root'),
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - '!packages/internal'\n",
      'packages/keep/package.json': pkgJson('@x/keep'),
      'packages/internal/package.json': pkgJson('@x/internal'),
    });
    const paths = detectWorkspacePackages(root, 'root')
      .map((p) => p.path)
      .sort();
    expect(paths).toEqual(['.', 'packages/keep']);
  });

  it('falls back to a single root package when there is no workspace config (single-repo)', () => {
    const root = scaffold({
      'package.json': pkgJson('solo'),
      'src/index.ts': 'export const x = 1;',
    });
    const pkgs = detectWorkspacePackages(root, 'solo-repo');
    expect(pkgs).toEqual([{ path: '.', name: 'solo-repo' }]);
  });

  it('falls back to every package.json directory when no workspace config is declared', () => {
    const root = scaffold({
      'package.json': pkgJson('root'),
      'services/api/package.json': pkgJson('@x/api'),
      'services/web/package.json': pkgJson('@x/web'),
    });
    const paths = detectWorkspacePackages(root, 'root')
      .map((p) => p.path)
      .sort();
    expect(paths).toEqual(['.', 'services/api', 'services/web']);
  });

  it('names a package by its directory when package.json has no name field', () => {
    const root = scaffold({
      'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
      'packages/unnamed/package.json': '{}',
    });
    const pkg = detectWorkspacePackages(root, 'root').find((p) => p.path === 'packages/unnamed');
    expect(pkg?.name).toBe('packages/unnamed');
  });
});

describe('workspace assignment ties into the canonical package id scheme', () => {
  it('threads the owning package path through idGen.packageId', () => {
    const root = scaffold({
      'package.json': pkgJson('root'),
      'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
      'apps/server/package.json': pkgJson('@x/server'),
      'packages/core/package.json': pkgJson('@x/core'),
    });
    const pkgs = detectWorkspacePackages(root, 'root');
    const idGen = new StableIdGenerator(root, 'root');

    // a server file resolves to the apps/server package id, not the root package id
    const serverFilePkgId = idGen.packageId(ownerPackagePath('apps/server/src/main.ts', pkgs));
    expect(serverFilePkgId).toBe(idGen.packageId('apps/server'));
    expect(serverFilePkgId).not.toBe(idGen.packageId('.'));

    // a root-level file resolves to the root package id
    expect(idGen.packageId(ownerPackagePath('turbo.json', pkgs))).toBe(idGen.packageId('.'));
  });
});
