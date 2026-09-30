import { accessSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { isolationPrerequisite, systemToolPath } from './system-tools.js';

vi.mock('node:fs', () => ({ accessSync: vi.fn(), constants: { X_OK: 1 } }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it('uses the same system bwrap for preflight and launch, independent of PATH', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  vi.mocked(accessSync).mockImplementation((path) => {
    if (path !== '/bin/bwrap') throw new Error('absent');
  });
  expect(isolationPrerequisite()).toBeNull();
  expect(systemToolPath('bwrap')).toBe('/bin/bwrap');
  vi.mocked(accessSync).mockImplementation(() => {
    throw new Error('absent');
  });
  expect(isolationPrerequisite()).toContain('bubblewrap (bwrap) is required in /usr/bin or /bin');
});

it('supports tar in /bin without consulting a repository PATH', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  vi.mocked(accessSync).mockImplementation((path) => {
    if (path !== '/bin/tar') throw new Error('absent');
  });
  expect(systemToolPath('tar')).toBe('/bin/tar');
});
