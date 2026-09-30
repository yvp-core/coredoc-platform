import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MANAGED_CONFIG_NONE,
  defaultManagedConfigPath,
  getManagedConfig,
  initManagedConfig,
  readManagedConfig,
  resetManagedConfigForTests,
  resolveManagedConfigPath,
} from './managed-config.js';

let dir: string;

function fixture(contents: string): string {
  const path = join(dir, 'managed-config.json');
  writeFileSync(path, contents);
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coredoc-managed-'));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  resetManagedConfigForTests();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('defaultManagedConfigPath', () => {
  it('uses the fixed per-OS location', () => {
    expect(defaultManagedConfigPath('darwin', {}, true)).toBe(
      '/Library/Application Support/Coredoc/managed-config.json',
    );
    expect(defaultManagedConfigPath('linux', {}, true)).toBe('/etc/coredoc/managed-config.json');
  });

  it('ignores %ProgramData% in a packaged Windows build', () => {
    // Env is attacker-controllable; a packaged build must not take the fleet
    // pin's location from it.
    const path = defaultManagedConfigPath('win32', { ProgramData: 'D:\\Attacker' }, true);
    expect(path.startsWith('C:\\ProgramData')).toBe(true);
    expect(path).toContain('Coredoc');
    expect(path).not.toContain('Attacker');
  });

  it('honors %ProgramData% only in an unpackaged Windows build', () => {
    expect(defaultManagedConfigPath('win32', { ProgramData: 'D:\\PD' }, false)).toContain('D:\\PD');
    expect(defaultManagedConfigPath('win32', {}, false)).toContain('C:\\ProgramData');
  });
});

describe('resolveManagedConfigPath', () => {
  it('honors COREDOC_MANAGED_CONFIG_PATH in unpackaged builds', () => {
    const env = { COREDOC_MANAGED_CONFIG_PATH: '/tmp/custom.json' };
    expect(resolveManagedConfigPath('darwin', env, false)).toBe('/tmp/custom.json');
  });

  it('ignores COREDOC_MANAGED_CONFIG_PATH in a packaged build', () => {
    const env = { COREDOC_MANAGED_CONFIG_PATH: '/tmp/custom.json' };
    expect(resolveManagedConfigPath('darwin', env, true)).toBe(
      '/Library/Application Support/Coredoc/managed-config.json',
    );
  });
});

describe('readManagedConfig', () => {
  it('returns no config when the file is absent', () => {
    expect(readManagedConfig(join(dir, 'missing.json'))).toEqual(MANAGED_CONFIG_NONE);
  });

  it('reads and normalizes both pinned URLs', () => {
    const path = fixture(
      JSON.stringify({ serverUrl: 'https://coredoc.corp.example/', updateFeedUrl: 'https://mirror.corp.example/feed' }),
    );
    expect(readManagedConfig(path)).toEqual({
      serverUrl: 'https://coredoc.corp.example',
      updateFeedUrl: 'https://mirror.corp.example/feed',
    });
  });

  it('allows pinning only the server URL', () => {
    const path = fixture(JSON.stringify({ serverUrl: 'https://coredoc.corp.example' }));
    expect(readManagedConfig(path)).toEqual({ serverUrl: 'https://coredoc.corp.example', updateFeedUrl: null });
  });

  it('warns and ignores malformed JSON', () => {
    const path = fixture('{ not json');
    expect(readManagedConfig(path)).toEqual(MANAGED_CONFIG_NONE);
    expect(console.warn).toHaveBeenCalled();
  });

  it('warns and ignores a non-object top level', () => {
    expect(readManagedConfig(fixture('["https://corp.example"]'))).toEqual(MANAGED_CONFIG_NONE);
    expect(console.warn).toHaveBeenCalled();
  });

  it('warns and ignores the whole file when a URL is not http(s)', () => {
    const path = fixture(
      JSON.stringify({ serverUrl: 'ftp://corp.example', updateFeedUrl: 'https://mirror.corp.example' }),
    );
    expect(readManagedConfig(path)).toEqual(MANAGED_CONFIG_NONE);
    expect(console.warn).toHaveBeenCalled();
  });

  it('warns and ignores a non-string value', () => {
    expect(readManagedConfig(fixture(JSON.stringify({ serverUrl: 42 })))).toEqual(MANAGED_CONFIG_NONE);
    expect(console.warn).toHaveBeenCalled();
  });
});

// The ownership gate is POSIX-only, and it can only refuse a file when the
// suite is not itself running as root.
const posixNonRoot = process.platform !== 'win32' && (process.getuid?.() ?? 0) !== 0;

describe.runIf(posixNonRoot)('readManagedConfig — ownership gate', () => {
  const managed = JSON.stringify({ serverUrl: 'https://attacker.example' });

  it('refuses a file that is not owned by root', () => {
    const path = fixture(managed);
    chmodSync(path, 0o644);

    expect(readManagedConfig(path, { requireRootOwnership: true })).toEqual(MANAGED_CONFIG_NONE);
    expect(console.warn).toHaveBeenCalled();
  });

  it('refuses a group- or other-writable file', () => {
    const path = fixture(managed);
    chmodSync(path, 0o666);

    expect(readManagedConfig(path, { requireRootOwnership: true })).toEqual(MANAGED_CONFIG_NONE);
    expect(console.warn).toHaveBeenCalled();
  });

  it('stays silent about an absent file even with the gate on', () => {
    expect(readManagedConfig(join(dir, 'missing.json'), { requireRootOwnership: true })).toEqual(MANAGED_CONFIG_NONE);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('reads the same file when the gate is off (dev override / Windows)', () => {
    const path = fixture(managed);

    expect(readManagedConfig(path).serverUrl).toBe('https://attacker.example');
  });
});

describe('initManagedConfig / getManagedConfig', () => {
  it('reports no managed config before init', () => {
    expect(getManagedConfig()).toEqual(MANAGED_CONFIG_NONE);
  });

  it('caches the config read at startup', () => {
    const path = fixture(JSON.stringify({ serverUrl: 'https://pinned.example' }));
    initManagedConfig({ platform: 'darwin', env: { COREDOC_MANAGED_CONFIG_PATH: path }, isPackaged: false });
    expect(getManagedConfig().serverUrl).toBe('https://pinned.example');

    rmSync(path);
    expect(getManagedConfig().serverUrl).toBe('https://pinned.example');
  });

  it('a packaged build does not read the env-supplied path', () => {
    const path = fixture(JSON.stringify({ serverUrl: 'https://attacker.example' }));
    initManagedConfig({ platform: 'darwin', env: { COREDOC_MANAGED_CONFIG_PATH: path }, isPackaged: true });
    expect(getManagedConfig().serverUrl).toBeNull();
  });
});
