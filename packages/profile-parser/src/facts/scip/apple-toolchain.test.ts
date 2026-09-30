import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { appleToolchain } from './apple-toolchain.js';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(['xcode', 'clt'])('uses the selected %s compiler and SDK without invoking a shim', (kind) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  const root = mkdtempSync(join(tmpdir(), 'apple-toolchain-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const developer = join(root, 'developer');
  const bin = join(developer, kind === 'xcode' ? 'Toolchains/XcodeDefault.xctoolchain/usr/bin' : 'usr/bin');
  const sdk = join(
    developer,
    kind === 'xcode' ? 'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk' : 'SDKs/MacOSX.sdk',
  );
  mkdirSync(repo);
  mkdirSync(bin, { recursive: true });
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(bin, 'clang'), 'compiler');
  let version = 'Apple clang version 17.0.0 (clang-1700.0.13.3)';
  writeFileSync(join(sdk, 'SDKSettings.json'), '{"Version":"15.0","ProductBuildVersion":"24A1"}');
  vi.mocked(execFileSync).mockImplementation((command) => (command === '/usr/bin/xcode-select' ? developer : version));
  const result = appleToolchain(repo);
  expect(result.env.CC).toBe(join(result.bin!, 'clang'));
  expect(result.env.SDKROOT).toMatch(/MacOSX.sdk$/);
  expect(appleToolchain(repo).cacheIdentity).toBe(result.cacheIdentity);
  version = 'Apple clang version 17.0.0 (clang-1700.0.13.5)';
  const compilerUpdate = appleToolchain(repo);
  expect(compilerUpdate.env).toEqual(result.env);
  expect(compilerUpdate.cacheIdentity).not.toBe(result.cacheIdentity);
  writeFileSync(join(sdk, 'SDKSettings.json'), '{"Version":"15.0","ProductBuildVersion":"24A2"}');
  const sdkUpdate = appleToolchain(repo);
  expect(sdkUpdate.env).toEqual(result.env);
  expect(sdkUpdate.cacheIdentity).not.toBe(compilerUpdate.cacheIdentity);
  rmSync(sdk, { recursive: true });
  expect(() => appleToolchain(repo)).toThrow('no usable clang or macOS SDK');
});

it('returns actionable setup guidance when no developer tools are selected', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  vi.mocked(execFileSync).mockImplementation(() => {
    throw new Error('not installed');
  });
  expect(() => appleToolchain('/unused')).toThrow('xcode-select --install');
});
