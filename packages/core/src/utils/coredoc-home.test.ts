import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { resolveCoredocHome } from './coredoc-home.js';

describe('resolveCoredocHome', () => {
  it('defaults to ~/.coredoc from HOME when no override is set', () => {
    const fakeHome = join(sep, 'tmp', 'coredoc-home-test');
    expect(resolveCoredocHome({ HOME: fakeHome })).toBe(join(fakeHome, '.coredoc'));
  });

  it('falls back to os.homedir() when HOME is unset', () => {
    expect(resolveCoredocHome({})).toBe(join(homedir(), '.coredoc'));
  });

  it('honors an absolute COREDOC_HOME override', () => {
    const override = join(sep, 'tmp', 'coredoc-dev-home');
    expect(resolveCoredocHome({ COREDOC_HOME: override, HOME: '/elsewhere' })).toBe(override);
  });

  it('trims surrounding whitespace in COREDOC_HOME', () => {
    const override = join(sep, 'tmp', 'coredoc-dev-home');
    expect(resolveCoredocHome({ COREDOC_HOME: `  ${override}  ` })).toBe(override);
  });

  it('treats an empty or whitespace-only COREDOC_HOME as unset', () => {
    const fakeHome = join(sep, 'tmp', 'coredoc-home-test');
    expect(resolveCoredocHome({ COREDOC_HOME: '   ', HOME: fakeHome })).toBe(join(fakeHome, '.coredoc'));
  });

  it('throws on a relative COREDOC_HOME', () => {
    expect(() => resolveCoredocHome({ COREDOC_HOME: 'relative/dir' })).toThrow(/absolute path/);
  });

  it('normalizes the override path', () => {
    const messy = join(sep, 'tmp', 'coredoc-dev-home', '..', 'coredoc-dev-home');
    expect(resolveCoredocHome({ COREDOC_HOME: messy })).toBe(join(sep, 'tmp', 'coredoc-dev-home'));
  });
});
