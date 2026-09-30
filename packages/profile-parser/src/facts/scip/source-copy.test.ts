import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { copyIndexSource } from './source-copy.js';

const temp = mkdtempSync(join(tmpdir(), 'index-source-'));
afterEach(() => rmSync(temp, { recursive: true, force: true }));

it('excludes credential config case-insensitively, preserves source, and hashes copied inputs only', () => {
  const repo = join(temp, 'repo');
  const files = ['lib/code.rb', '.ENV', '.NPMRC', 'config/.NETRC', '.git/config'];
  for (const file of files) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), file);
  }
  const copy = copyIndexSource(repo, join(temp, 'work'), files);
  expect(readFileSync(join(copy.root, files[0]), 'utf8')).toBe(files[0]);
  for (const secret of files.slice(1)) expect(existsSync(join(copy.root, secret))).toBe(false);
  writeFileSync(join(repo, '.ENV'), 'changed secret');
  expect(copyIndexSource(repo, join(temp, 'second'), files).hash).toBe(copy.hash);
  expect(readFileSync(join(repo, files[0]), 'utf8')).toBe(files[0]);
});

it('rejects overlapping output, traversal and symlink components', () => {
  const repo = join(temp, 'repo');
  mkdirSync(repo, { recursive: true });
  symlinkSync(tmpdir(), join(repo, 'linked'));
  expect(() => copyIndexSource(repo, join(repo, 'work'), [])).toThrow('outside');
  expect(() => copyIndexSource(repo, join(temp, 'work'), ['../other'])).toThrow('repository-relative');
  expect(() => copyIndexSource(repo, join(temp, 'work'), ['linked/file.rb'])).toThrow('symbolic links');
});
