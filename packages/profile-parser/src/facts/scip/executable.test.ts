import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { executableOnPath } from './executable.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('ignores relative PATH entries and repository executables including external symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'tool-path-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const outside = join(root, 'tools');
  mkdirSync(repo);
  mkdirSync(outside);
  writeFileSync(join(repo, 'go'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(repo, 'go'), 0o755);
  symlinkSync(join(repo, 'go'), join(outside, 'go'));
  vi.stubEnv('PATH', relative(process.cwd(), repo));
  expect(executableOnPath('go', repo)).toBeUndefined();
  vi.stubEnv('PATH', `${repo}:${outside}`);
  expect(executableOnPath('go', repo)).toBeUndefined();
  writeFileSync(join(outside, 'rustc'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(outside, 'rustc'), 0o755);
  expect(executableOnPath('rustc', repo)).toBe(realpathSync(join(outside, 'rustc')));
});
