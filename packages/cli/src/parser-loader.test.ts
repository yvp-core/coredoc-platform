import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadParser } from './parser-loader.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('loadParser canonical profile ownership', () => {
  it('loads the compiled ESM profile independently of the workspace package type', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coredoc-parser-loader-'));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}');
    const storage = join(root, 'coredoc-parsers');
    const source = join(storage, 'project-a', 'repo-a');
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, 'profile.ts'),
      "export default { parserId: 'csharp', substrate: { language: 'csharp', include: ['**/*.cs'], analysis: { mode: 'basic' } } };",
    );
    expect(await loadParser(storage, 'project-a', 'repo-a', { repoRoot: root, repoName: 'repo-a' })).not.toBeNull();
  });
  it('ignores an orphaned compiled profile when profile.ts is absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coredoc-parser-loader-'));
    roots.push(root);
    const parserStorage = join(root, 'coredoc-parsers');
    const compiledDir = join(root, 'dist', 'coredoc-parsers', 'project-a', 'repo-a');
    mkdirSync(compiledDir, { recursive: true });
    writeFileSync(
      join(compiledDir, 'profile.mjs'),
      "export default { parserId: 'orphan', substrate: { language: 'csharp', include: ['**/*.cs'], analysis: { mode: 'basic' } } };",
    );

    await expect(
      loadParser(parserStorage, 'project-a', 'repo-a', {
        repoRoot: root,
        repoName: 'repo-a',
      }),
    ).resolves.toBeNull();
  });
});
