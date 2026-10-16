import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  repoRefKey,
  parserDir,
  workspaceOutputDir,
  parsedRepoFile,
  summariesFile,
  embeddingsFile,
  docsDir,
  findRepoByRef,
  findProjectsContainingRepo,
  resolveRepoRef,
  projectDbDir,
  projectDbPath,
  projectDbUrl,
} from './repo-ref.js';
import type { CoredocConfig } from '../types/config.js';

const fakeConfig: CoredocConfig = {
  version: '2.0',
  projects: [
    {
      id: 'alpha',
      name: 'Alpha',
      repos: [{ name: 'svc-a', path: '/tmp/svc-a' }],
    },
    {
      id: 'beta',
      name: 'Beta',
      repos: [
        { name: 'svc-a', path: '/tmp/beta/svc-a' },
        { name: 'svc-b', path: '/tmp/beta/svc-b' },
      ],
    },
  ],
  output: { dir: './out', format: 'json' },
  parserStorage: './parsers',
};

describe('path helpers', () => {
  it('repoRefKey composes projectId/repoName', () => {
    expect(repoRefKey('alpha', 'svc-a')).toBe('alpha/svc-a');
  });

  it('parserDir nests under projectId', () => {
    expect(parserDir('/abs/parsers', 'alpha', 'svc-a')).toBe('/abs/parsers/alpha/svc-a');
  });

  it('workspaceOutputDir nests under projectId', () => {
    expect(workspaceOutputDir('/abs/out', 'alpha')).toBe('/abs/out/alpha');
  });

  it('parsedRepoFile points at {projectId}/{repoName}.json', () => {
    expect(parsedRepoFile('/abs/out', 'alpha', 'svc-a')).toBe('/abs/out/alpha/svc-a.json');
  });

  it('summariesFile uses -summaries.json suffix', () => {
    expect(summariesFile('/abs/out', 'alpha', 'svc-a')).toBe('/abs/out/alpha/svc-a-summaries.json');
  });

  it('embeddingsFile uses -embeddings.json suffix', () => {
    expect(embeddingsFile('/abs/out', 'alpha', 'svc-a')).toBe('/abs/out/alpha/svc-a-embeddings.json');
  });

  it('docsDir uses -docs suffix', () => {
    expect(docsDir('/abs/out', 'alpha', 'svc-a')).toBe('/abs/out/alpha/svc-a-docs');
  });

  it('projectDbPath gives each project its own database file', () => {
    expect(projectDbDir('/ws')).toBe('/ws/coredoc.db.d');
    expect(projectDbPath('/ws', 'alpha')).toBe('/ws/coredoc.db.d/alpha.db');
    expect(projectDbPath('/ws', 'beta')).not.toBe(projectDbPath('/ws', 'alpha'));
  });

  it('projectDbUrl prefixes the libsql file scheme', () => {
    expect(projectDbUrl('/ws', 'alpha')).toBe('file:/ws/coredoc.db.d/alpha.db');
  });

  it('projectDbPath rejects ids that would escape the database directory', () => {
    // Project ids are slugs by construction, but this builds a filesystem path
    // from one, so it verifies rather than trusts.
    expect(() => projectDbPath('/ws', '../../etc')).toThrow(/Invalid project id/);
    expect(() => projectDbPath('/ws', 'has/slash')).toThrow(/Invalid project id/);
    expect(() => projectDbPath('/ws', 'Upper')).toThrow(/Invalid project id/);
  });

  it('rejects a symlinked project database directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'coredoc-db-path-'));
    const outside = mkdtempSync(join(tmpdir(), 'coredoc-db-outside-'));
    try {
      mkdirSync(root, { recursive: true });
      symlinkSync(outside, join(root, 'coredoc.db.d'), 'dir');
      expect(() => projectDbPath(root, 'alpha')).toThrow(/symbolic link/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects a dangling project database directory symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'coredoc-db-path-'));
    try {
      symlinkSync(join(root, 'missing-target'), join(root, 'coredoc.db.d'), 'dir');
      expect(() => projectDbPath(root, 'alpha')).toThrow(/symbolic link/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked project database file', () => {
    const root = mkdtempSync(join(tmpdir(), 'coredoc-db-path-'));
    const outside = join(mkdtempSync(join(tmpdir(), 'coredoc-db-outside-')), 'outside.db');
    try {
      mkdirSync(join(root, 'coredoc.db.d'), { recursive: true });
      writeFileSync(outside, 'not a project database');
      symlinkSync(outside, join(root, 'coredoc.db.d', 'alpha.db'), 'file');
      expect(() => projectDbPath(root, 'alpha')).toThrow(/symbolic link/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(join(outside, '..'), { recursive: true, force: true });
    }
  });
});

describe('findRepoByRef', () => {
  it('returns the repo when projectId+repoName match', () => {
    const repo = findRepoByRef(fakeConfig, 'beta', 'svc-a');
    expect(repo?.path).toBe('/tmp/beta/svc-a');
  });

  it('returns undefined when not found', () => {
    expect(findRepoByRef(fakeConfig, 'alpha', 'svc-b')).toBeUndefined();
  });
});

describe('findProjectsContainingRepo', () => {
  it('returns all projects whose repos[] contains the given name', () => {
    const projects = findProjectsContainingRepo(fakeConfig, 'svc-a');
    expect(projects.map((p) => p.id)).toEqual(['alpha', 'beta']);
  });

  it('returns empty when no project contains the repo', () => {
    expect(findProjectsContainingRepo(fakeConfig, 'nope')).toEqual([]);
  });
});

describe('resolveRepoRef', () => {
  it('returns the explicit ref when both projectId and repoName given', () => {
    expect(resolveRepoRef(fakeConfig, 'svc-a', 'beta')).toEqual({ projectId: 'beta', repoName: 'svc-a' });
  });

  it('throws when explicit projectId/repoName combo does not exist', () => {
    expect(() => resolveRepoRef(fakeConfig, 'svc-b', 'alpha')).toThrow(/not found/);
  });

  it('resolves directly when repoName is unique across projects', () => {
    expect(resolveRepoRef(fakeConfig, 'svc-b')).toEqual({ projectId: 'beta', repoName: 'svc-b' });
  });

  it('throws an ambiguous-name error when repoName matches multiple projects', () => {
    expect(() => resolveRepoRef(fakeConfig, 'svc-a')).toThrow(/ambiguous/i);
  });

  it('throws when repoName is not in any project', () => {
    expect(() => resolveRepoRef(fakeConfig, 'nope')).toThrow(/not found/);
  });

  it('throws a project-not-found error when the projectId does not exist', () => {
    expect(() => resolveRepoRef(fakeConfig, 'svc-a', 'unknown-project')).toThrow(/Project "unknown-project" not found/);
  });

  it('throws a repos-in-project list when the project exists but the repo does not', () => {
    expect(() => resolveRepoRef(fakeConfig, 'unknown-repo', 'alpha')).toThrow(
      /Repo "unknown-repo" not found in project "alpha". Repos in this project: svc-a/,
    );
  });

  it('handles the empty-config case with a distinct error message', () => {
    const emptyConfig: CoredocConfig = {
      version: '2.0',
      projects: [],
      output: { dir: './out', format: 'json' },
      parserStorage: './parsers',
    };
    expect(() => resolveRepoRef(emptyConfig, 'svc-a')).toThrow(/No repos are configured/);
  });
});
