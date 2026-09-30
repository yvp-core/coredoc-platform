import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSystemCodexEnvironment, resolveSystemCodexCliPath } from './codex-runtime';

const fixtures: string[] = [];

function fixtureBinary(parent: string, name = 'codex'): string {
  const executable = path.join(parent, name);
  mkdirSync(parent, { recursive: true });
  writeFileSync(executable, '#!/bin/sh\nexit 0\n');
  chmodSync(executable, 0o755);
  return executable;
}

function fixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'coredoc-system-codex-'));
  fixtures.push(root);
  return root;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

describe('resolveSystemCodexCliPath', () => {
  it('uses the first PATH executable whose CLI supports app-server', () => {
    const root = fixtureRoot();
    const oldCodex = fixtureBinary(path.join(root, 'old'));
    const compatibleCodex = fixtureBinary(path.join(root, 'compatible'));
    const probe = vi.fn((candidate: string) => candidate === compatibleCodex);

    expect(
      resolveSystemCodexCliPath({
        pathValue: [path.dirname(oldCodex), path.dirname(compatibleCodex)].join(path.delimiter),
        homeDir: path.join(root, 'home'),
        platform: 'darwin',
        probe,
      }),
    ).toBe(compatibleCodex);
    expect(probe.mock.calls).toEqual([[oldCodex], [compatibleCodex]]);
  });

  it('finds a standard user install when a GUI launch has a minimal PATH', () => {
    const root = fixtureRoot();
    const homeDir = path.join(root, 'home');
    const codex = fixtureBinary(path.join(homeDir, '.local', 'bin'));

    expect(
      resolveSystemCodexCliPath({
        pathValue: '/usr/bin:/bin',
        homeDir,
        platform: 'linux',
        probe: (candidate) => candidate === codex,
        systemBinDirs: [],
      }),
    ).toBe(codex);
  });

  it('returns null when Codex is missing or lacks app-server support', () => {
    const root = fixtureRoot();
    fixtureBinary(path.join(root, 'bin'));

    expect(
      resolveSystemCodexCliPath({
        pathValue: path.join(root, 'bin'),
        homeDir: path.join(root, 'home'),
        platform: 'darwin',
        probe: () => false,
        systemBinDirs: [],
      }),
    ).toBeNull();
  });

  it('prepends an npm/NVM install directory when probing and launching Codex from a GUI PATH', () => {
    const root = fixtureRoot();
    const homeDir = path.join(root, 'home');
    const binDir = path.join(homeDir, '.nvm', 'versions', 'node', 'v22.22.0', 'bin');
    const codex = path.join(binDir, 'codex');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      codex,
      '#!/usr/bin/env node\nprocess.exit(process.argv.slice(2).join(" ") === "app-server --help" ? 0 : 1);\n',
    );
    chmodSync(codex, 0o755);
    symlinkSync(process.execPath, path.join(binDir, 'node'));

    expect(
      resolveSystemCodexCliPath({
        pathValue: '/usr/bin:/bin',
        homeDir,
        platform: 'darwin',
        systemBinDirs: [],
      }),
    ).toBe(codex);
    expect(buildSystemCodexEnvironment({ PATH: '/usr/bin:/bin' }, codex).PATH).toBe(`${binDir}:/usr/bin:/bin`);
  });
});
