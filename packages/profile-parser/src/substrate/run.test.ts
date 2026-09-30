import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StableIdGenerator } from '@coredoc/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const MINIMAL: ExtractionProfile = {
  parserId: 'test-minimal',
  substrate: { language: 'ts', include: ['**/*.ts'], exclude: ['**/node_modules/**'] },
};

describe('runProfile — two-ID stability', () => {
  // Regression for the repoKey-drop bug: the repoHash (first segment of the repo id and every
  // node id) must hash off `repoKey ?? repoName`, matching the legacy parser path. A repo whose
  // `key` differs from its `name` must NOT get a name-derived hash on the profile path.
  it('derives the repoHash from repoKey (not repoName) when they differ', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-key-'));
    writeFileSync(join(dir, 'a.ts'), 'export function foo() { return 1; }\n');

    const { repo } = await runProfile(MINIMAL, dir, 'name-X', 'key-Y');

    const hashFromKey = new StableIdGenerator(dir, 'key-Y').fileId('.').split(':')[0];
    const hashFromName = new StableIdGenerator(dir, 'name-X').fileId('.').split(':')[0];
    expect(hashFromKey).not.toBe(hashFromName); // sanity: key vs name change the hash
    expect(repo.id).toBe(hashFromKey);
    expect(repo.functions.length).toBeGreaterThan(0);
    expect(repo.functions.every((f) => f.id.split(':')[0] === hashFromKey)).toBe(true);
  });
});
