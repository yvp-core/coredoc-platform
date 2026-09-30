import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installCSharpTool, installedCSharpTool } from './scip-install.js';

const release = vi.hoisted(() => ({
  version: 'test-release',
  url: 'https://example.invalid/tool.tar.gz',
  sha256: '',
  contentsSha256: '',
}));
vi.mock('./scip-release.js', () => ({ SCIP_DOTNET_RELEASE: release }));
const installTest = it.runIf(
  process.platform === 'darwin' || (process.platform === 'linux' && !existsSync('/etc/alpine-release')),
);
const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), 'coredoc-tool-install-'));
  roots.push(root);
  return root;
};
let root: string;
let home: string;
let archive: Buffer;
beforeEach(() => {
  root = temp();
  home = temp();
  vi.stubEnv('COREDOC_HOME', home);
  const payload = temp();
  writeFileSync(join(payload, 'scip-dotnet.dll'), 'managed assembly test fixture');
  writeFileSync(join(payload, 'scip-dotnet.runtimeconfig.json'), '{}');
  writeFileSync(
    join(payload, 'coredoc-tool.json'),
    JSON.stringify({ version: release.version, runtime: 'net10.0', receiverTypes: 1, defines: true }),
  );
  const hash = createHash('sha256');
  for (const file of readdirSync(payload).sort())
    hash
      .update(file)
      .update('\0')
      .update(readFileSync(join(payload, file)))
      .update('\0');
  release.contentsSha256 = hash.digest('hex');
  const path = join(temp(), 'tool.tar.gz');
  execFileSync('/usr/bin/tar', ['-czf', path, '-C', payload, '.']);
  archive = readFileSync(path);
  release.sha256 = createHash('sha256').update(archive).digest('hex');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

installTest('installs a verified release outside source and reuses it without another download', async () => {
  const download = vi.fn(async () => new Response(archive));
  vi.stubGlobal('fetch', download);
  const path = await installCSharpTool(root);
  expect(path.startsWith(realpathSync(home))).toBe(true);
  expect(readFileSync(path, 'utf8')).toBe('managed assembly test fixture');
  expect(installedCSharpTool(root)).toBe(path);
  expect(await installCSharpTool(root)).toBe(path);
  expect(download).toHaveBeenCalledOnce();
  expect(readdirSync(root)).toEqual([]);
  expect(readdirSync(dirname(dirname(path)))).toEqual([release.version]);
});

installTest('never extracts or publishes an archive with the wrong checksum', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('incorrect archive')),
  );
  await expect(installCSharpTool(root)).rejects.toThrow('checksum');
  expect(installedCSharpTool(root)).toBeUndefined();
  expect(readdirSync(join(home, 'tools', 'scip-dotnet'))).toEqual([]);
  expect(readdirSync(root)).toEqual([]);
});

installTest('cleans up a cancelled download and lets a later attempt succeed', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new DOMException('Cancelled', 'AbortError');
    }),
  );
  await expect(installCSharpTool(root)).rejects.toMatchObject({ name: 'AbortError' });
  expect(readdirSync(join(home, 'tools', 'scip-dotnet'))).toEqual([]);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(archive)),
  );
  expect(await installCSharpTool(root)).toBe(installedCSharpTool(root));
});

installTest('refuses a tool home inside source before downloading or writing anything', async () => {
  vi.stubEnv('COREDOC_HOME', join(root, '.tools'));
  const download = vi.fn();
  vi.stubGlobal('fetch', download);
  await expect(installCSharpTool(root)).rejects.toThrow();
  expect(download).not.toHaveBeenCalled();
  expect(readdirSync(root)).toEqual([]);
});

installTest('global install has no repository boundary and reports downloaded bytes', async () => {
  const download = vi.fn(async () => new Response(archive, { headers: { 'content-length': String(archive.length) } }));
  vi.stubGlobal('fetch', download);
  const onProgress = vi.fn();
  // COREDOC_HOME may legitimately be beneath the command's working directory ($HOME or /).
  const installed = await installCSharpTool(undefined, { onProgress });
  expect(installed).toBe(installedCSharpTool());
  expect(onProgress).toHaveBeenLastCalledWith(archive.length, archive.length);
});
installTest(
  'refuses changed executable bytes despite the old checksum marker and repairs on explicit install',
  async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(archive)),
    );
    const installed = await installCSharpTool(root);
    writeFileSync(join(dirname(installed), 'archive.sha256'), release.sha256);
    writeFileSync(installed, 'modified executable');
    expect(installedCSharpTool(root)).toBeUndefined();
    expect(await installCSharpTool(root)).toBe(installed);
    expect(readFileSync(installed, 'utf8')).toBe('managed assembly test fixture');
  },
);
