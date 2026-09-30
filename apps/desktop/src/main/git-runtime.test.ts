import { beforeEach, expect, it, vi } from 'vitest';
import { resolveMacGit } from './git-runtime.js';

const { paths, execFileSync } = vi.hoisted(() => ({ paths: new Map<string, string>(), execFileSync: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync }));
vi.mock('node:fs', () => ({
  constants: { X_OK: 1 },
  accessSync: (path: string) => {
    if (!paths.has(path)) throw new Error('missing');
  },
  realpathSync: (path: string) => paths.get(path) ?? path,
  statSync: () => ({ isFile: () => true }),
  existsSync: (path: string) => paths.has(path),
}));

beforeEach(() => {
  paths.clear();
  execFileSync.mockReset();
  execFileSync.mockImplementation((command: string, args: string[]) => {
    if (command === '/usr/bin/xcode-select') throw new Error('No developer tools');
    if (args[0] === '--exec-path') return '/custom/git/libexec/git-core\n';
    throw new Error(`Unexpected command ${command}`);
  });
});

it('uses installed Git after the Apple launcher in PATH without invoking Xcode', () => {
  paths.set('/usr/bin/git', '/usr/bin/git');
  paths.set('/custom/bin/git', '/custom/git/bin/git');
  paths.set('/custom/git/libexec/git-core', '/custom/git/libexec/git-core');
  paths.set('/custom/git/lib', '/custom/git/lib');
  const resolved = resolveMacGit({ PATH: '/usr/bin:/custom/bin' }, '/checkout');
  expect(resolved.directory).toBe('/custom/git/bin');
  expect(resolved.readPaths).toContain('/custom/git/lib');
  expect(execFileSync).toHaveBeenCalledTimes(1);
  expect(execFileSync.mock.calls[0][0]).toBe('/custom/git/bin/git');
  expect(execFileSync.mock.calls[0][2].cwd).toBe('/');
});

it('finds Homebrew Git when Finder supplies only system PATH entries', () => {
  paths.set('/opt/homebrew/bin/git', '/opt/homebrew/Cellar/git/2.50/bin/git');
  expect(resolveMacGit({ PATH: '/usr/bin:/bin' }).directory).toBe('/opt/homebrew/Cellar/git/2.50/bin');
  expect(execFileSync.mock.calls.some(([command]) => command === '/usr/bin/xcode-select')).toBe(false);
});

it('ignores relative PATH entries and symlinks to the Apple launcher', () => {
  paths.set('repo/bin/git', 'repo/bin/git');
  paths.set('/alias/git', '/usr/bin/git');
  expect(() => resolveMacGit({ PATH: 'repo/bin:/alias:/usr/bin' })).toThrow('Install Git');
  expect(execFileSync.mock.calls.map(([command]) => command)).toEqual(['/usr/bin/xcode-select']);
});

it('uses an already installed Apple Git directly when no separate installation exists', () => {
  paths.set(
    '/Applications/Xcode.app/Contents/Developer/usr/bin/git',
    '/Applications/Xcode.app/Contents/Developer/usr/bin/git',
  );
  execFileSync.mockImplementation((command: string) =>
    command === '/usr/bin/xcode-select'
      ? '/Applications/Xcode.app/Contents/Developer\n'
      : '/Applications/Xcode.app/Contents/Developer/usr/libexec/git-core\n',
  );
  expect(resolveMacGit({ PATH: '/usr/bin' }).directory).toBe('/Applications/Xcode.app/Contents/Developer/usr/bin');
  expect(execFileSync.mock.calls.some(([command]) => command === '/usr/bin/git' || command === '/usr/bin/xcrun')).toBe(
    false,
  );
});

it('never probes repository executables or external symlinks into a checkout', () => {
  paths.set('/checkout/bin/git', '/checkout/bin/git');
  paths.set('/alias/git', '/checkout/bin/git');
  expect(() => resolveMacGit({ PATH: '/checkout/bin:/alias' }, '/checkout')).toThrow('Install Git');
  expect(execFileSync.mock.calls.map(([command]) => command)).toEqual(['/usr/bin/xcode-select']);
});

it('startup does not probe arbitrary login PATH entries or installation aliases into them', () => {
  paths.set('/untrusted/bin/git', '/untrusted/bin/git');
  paths.set('/opt/homebrew/bin/git', '/untrusted/bin/git');
  expect(() => resolveMacGit({ PATH: '/untrusted/bin' })).toThrow('Install Git');
  expect(execFileSync.mock.calls.map(([command]) => command)).toEqual(['/usr/bin/xcode-select']);
});
