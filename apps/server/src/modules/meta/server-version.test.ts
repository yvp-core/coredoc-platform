import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPackageVersion } from './server-version.js';

describe('readPackageVersion', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'coredoc-meta-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads the nearest ancestor package.json version', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', version: '2.3.4' }));
    const nested = join(root, 'dist', 'modules');
    mkdirSync(nested, { recursive: true });

    expect(readPackageVersion(nested)).toBe('2.3.4');
  });

  it('walks past a package.json without a version', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'outer', version: '9.9.9' }));
    const inner = join(root, 'inner');
    mkdirSync(inner);
    writeFileSync(join(inner, 'package.json'), JSON.stringify({ name: 'inner' }));

    expect(readPackageVersion(inner)).toBe('9.9.9');
  });

  it('throws when no versioned package.json exists above the start directory', () => {
    // Walking up from a temp dir eventually hits the filesystem root, and only
    // a stray /package.json could satisfy the search — assert on the root path
    // itself, which cannot have an ancestor.
    expect(() => readPackageVersion('/')).toThrow(/No package.json with a "version"/);
  });
});
