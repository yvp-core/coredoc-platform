import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installedTool, installTool, type PinnedTool, toolContentsHash } from './tool-install.js';

let home: string;
const bytes = Buffer.from('verified-tool');
const tool: PinnedTool = {
  name: 'fixture-indexer',
  version: '1',
  url: 'https://example.invalid/tool',
  sha256: createHash('sha256').update(bytes).digest('hex'),
  entry: 'indexer',
};
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'coredoc-tools-'));
  vi.stubEnv('COREDOC_HOME', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

it('installs explicitly, reuses only verified bytes and repairs a damaged binary', async () => {
  const fetcher = vi.fn(async () => new Response(bytes));
  vi.stubGlobal('fetch', fetcher);
  const entry = await installTool(tool);
  expect(readFileSync(entry)).toEqual(bytes);
  expect(await installTool(tool)).toBe(entry);
  expect(fetcher).toHaveBeenCalledTimes(1);
  writeFileSync(entry, 'damaged');
  expect(installedTool(tool)).toBeUndefined();
  await installTool(tool);
  expect(readFileSync(entry)).toEqual(bytes);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('rejects a checksum mismatch without installing anything', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('wrong bytes')),
  );
  await expect(installTool(tool)).rejects.toThrow(/checksum/);
  expect(installedTool(tool)).toBeUndefined();
  expect(existsSync(join(home, 'tools', tool.name, tool.version))).toBe(false);
});

it('verifies and repairs all extracted Python-style package contents on reuse', async () => {
  const source = join(home, 'fixture');
  const packageDir = join(source, 'package');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'index.js'), 'import "./dependency.js";');
  writeFileSync(join(packageDir, 'dependency.js'), 'export const value = 1;');
  const archivePath = join(home, 'fixture.tgz');
  execFileSync('tar', ['-czf', archivePath, '-C', source, 'package']);
  const archive = readFileSync(archivePath);
  const marker = join(home, 'untrusted-gzip-ran');
  if (process.platform === 'linux') {
    const bin = join(home, 'repo-bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gzip'), `#!/bin/sh\necho executed > '${marker}'\nexec /usr/bin/gzip "$@"\n`);
    chmodSync(join(bin, 'gzip'), 0o755);
    vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);
  }
  const pinned = {
    ...tool,
    entry: 'index.js',
    sha256: createHash('sha256').update(archive).digest('hex'),
    archive: { prefix: 'package', contentsSha256: toolContentsHash(packageDir) },
  };
  const fetcher = vi.fn(async () => new Response(archive));
  vi.stubGlobal('fetch', fetcher);
  const entry = await installTool(pinned);
  expect(existsSync(marker)).toBe(false);
  expect(installedTool(pinned)).toBe(entry);
  const dependency = join(home, 'tools', tool.name, tool.version, 'dependency.js');
  writeFileSync(dependency, 'tampered dependency');
  expect(installedTool(pinned)).toBeUndefined();
  await installTool(pinned);
  expect(readFileSync(dependency, 'utf8')).toBe('export const value = 1;');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('does not fetch on an aborted install or when storage overlaps the source repository', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(installTool(tool, undefined, { signal: AbortSignal.abort() })).rejects.toMatchObject({
    name: 'AbortError',
  });
  await expect(installTool(tool, home)).rejects.toThrow(/outside/);
  expect(fetcher).not.toHaveBeenCalled();
});

it('identifies a failed download and leaves an actionable retry/basic choice', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    }),
  );
  await expect(installTool(tool)).rejects.toThrow('Cannot download fixture-indexer from example.invalid: ENOTFOUND');
  expect(installedTool(tool)).toBeUndefined();
});
