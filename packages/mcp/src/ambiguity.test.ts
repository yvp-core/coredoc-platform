import { describe, it, expect } from 'vitest';
import type { IGraphRepository } from '@coredoc/db';
import { detectAmbiguity, toNodeTypes } from './ambiguity.js';
import type { ScopeContext } from './types.js';

const scope: ScopeContext = {
  currentPath: '/tmp',
  resolvedRepos: ['api-server'],
  repoHashes: ['d01e5188b617'],
  project: 'Acme',
  projectId: 'acme',
  crossRepoEnabled: false,
};

type Match = { id: string; name: string; type: string; filePath: string; startLine: number };

/** Minimal fake: only `findCode` is exercised by detectAmbiguity. */
function fakeRepo(findCode: (pattern: string) => Match[] | Promise<Match[]>): IGraphRepository {
  return {
    findCode: async ({ pattern }: { pattern: string }) => findCode(pattern),
  } as unknown as IGraphRepository;
}

const fn = (id: string, filePath: string, startLine: number, name = 'createCompany'): Match => ({
  id,
  name,
  type: 'function',
  filePath,
  startLine,
});

describe('toNodeTypes', () => {
  it('keeps valid graph types and drops unknowns', () => {
    expect(toNodeTypes('function', 'class', 'not-a-type')).toEqual(['function', 'class']);
  });
});

describe('detectAmbiguity', () => {
  it('returns a hint listing the other matches when >1 resolve', async () => {
    const repo = fakeRepo(() => [
      fn('d01e5188b617:method:src/companies.controller.ts:createCompany', 'src/companies.controller.ts', 45),
      fn('d01e5188b617:method:src/companies.service.ts:createCompany', 'src/companies.service.ts', 120),
    ]);
    const amb = await detectAmbiguity(repo, {
      name: 'createCompany',
      scope,
      nodeTypes: toNodeTypes('function'),
      resolvedId: 'd01e5188b617:method:src/companies.controller.ts:createCompany',
      resolvedFilePath: 'src/companies.controller.ts',
      supportsClassName: true,
    });
    expect(amb).toBeDefined();
    expect(amb!.totalMatches).toBe(2);
    expect(amb!.others).toHaveLength(1);
    expect(amb!.others[0]!.filePath).toBe('src/companies.service.ts');
    expect(amb!.hint).toContain('matched 2 symbols');
    expect(amb!.hint).toContain('src/companies.service.ts:120');
    expect(amb!.hint).toContain('className');
  });

  it('returns undefined when only one symbol matches', async () => {
    const repo = fakeRepo(() => [fn('a:1', 'src/only.ts', 10)]);
    const amb = await detectAmbiguity(repo, {
      name: 'createCompany',
      scope,
      nodeTypes: toNodeTypes('function'),
      resolvedId: 'a:1',
    });
    expect(amb).toBeUndefined();
  });

  it('narrows by fileHint before counting (collapses to unambiguous)', async () => {
    const repo = fakeRepo(() => [
      fn('a:ctrl', 'src/companies.controller.ts', 45),
      fn('a:svc', 'src/companies.service.ts', 120),
    ]);
    const amb = await detectAmbiguity(repo, {
      name: 'createCompany',
      scope,
      nodeTypes: toNodeTypes('function'),
      resolvedId: 'a:svc',
      fileHint: 'service',
    });
    expect(amb).toBeUndefined();
  });

  it('dedupes candidates by id', async () => {
    const repo = fakeRepo(() => [fn('dup', 'src/a.ts', 1), fn('dup', 'src/a.ts', 1)]);
    const amb = await detectAmbiguity(repo, {
      name: 'createCompany',
      scope,
      nodeTypes: toNodeTypes('function'),
      resolvedId: 'dup',
    });
    expect(amb).toBeUndefined();
  });

  it('ignores substring collisions (exact-name only)', async () => {
    const repo = fakeRepo(() => [
      fn('a:1', 'src/a.ts', 1, 'createCompany'),
      fn('a:2', 'src/b.ts', 2, 'createCompanyDto'),
    ]);
    const amb = await detectAmbiguity(repo, {
      name: 'createCompany',
      scope,
      nodeTypes: toNodeTypes('function'),
      resolvedId: 'a:1',
    });
    expect(amb).toBeUndefined();
  });

  it('omits className from the hint when the tool does not support it', async () => {
    const repo = fakeRepo(() => [fn('a:1', 'src/a.ts', 1), fn('a:2', 'src/b.ts', 2)]);
    const amb = await detectAmbiguity(repo, {
      name: 'createCompany',
      scope,
      nodeTypes: toNodeTypes('entity'),
      resolvedId: 'a:1',
    });
    expect(amb).toBeDefined();
    expect(amb!.hint).not.toContain('className');
    expect(amb!.hint).toContain('fileHint');
  });

  it('collapses overflow alternatives into "+N more"', async () => {
    const matches = Array.from({ length: 9 }, (_, i) => fn(`id:${i}`, `src/f${i}.ts`, i + 1));
    const repo = fakeRepo(() => matches);
    const amb = await detectAmbiguity(repo, {
      name: 'createCompany',
      scope,
      nodeTypes: toNodeTypes('function'),
      resolvedId: 'id:0',
    });
    expect(amb).toBeDefined();
    // 9 total, 8 others, 5 shown → "+3 more"
    expect(amb!.others).toHaveLength(5);
    expect(amb!.moreCount).toBe(3);
    expect(amb!.hint).toContain('+3 more');
  });

  it('suppresses the banner when a className qualifier disambiguates to one class', async () => {
    const repo = fakeRepo(() => [
      {
        id: 'd01:method:src/companies.controller.ts:CompaniesController.createCompany',
        name: 'createCompany',
        type: 'function',
        filePath: 'src/companies.controller.ts',
        startLine: 58,
      },
      {
        id: 'd01:method:src/companies.service.ts:CompaniesService.createCompany',
        name: 'createCompany',
        type: 'function',
        filePath: 'src/companies.service.ts',
        startLine: 166,
      },
    ]);
    const amb = await detectAmbiguity(repo, {
      name: 'createCompany',
      scope,
      nodeTypes: toNodeTypes('function'),
      resolvedId: 'd01:method:src/companies.service.ts:CompaniesService.createCompany',
      className: 'CompaniesService',
      supportsClassName: true,
    });
    expect(amb).toBeUndefined();
  });

  it('still warns when the same Class.method name collides across files', async () => {
    const repo = fakeRepo(() => [
      {
        id: 'd01:method:src/a/companies.service.ts:CompaniesService.createCompany',
        name: 'createCompany',
        type: 'function',
        filePath: 'src/a/companies.service.ts',
        startLine: 10,
      },
      {
        id: 'd01:method:src/b/companies.service.ts:CompaniesService.createCompany',
        name: 'createCompany',
        type: 'function',
        filePath: 'src/b/companies.service.ts',
        startLine: 20,
      },
    ]);
    const amb = await detectAmbiguity(repo, {
      name: 'createCompany',
      scope,
      nodeTypes: toNodeTypes('function'),
      resolvedId: 'd01:method:src/a/companies.service.ts:CompaniesService.createCompany',
      className: 'CompaniesService',
      supportsClassName: true,
    });
    expect(amb).toBeDefined();
    expect(amb!.others).toHaveLength(1);
  });

  it('attributes each alternative to its repository in a multi-repo scope', async () => {
    const multiRepoScope: ScopeContext = {
      ...scope,
      resolvedRepos: ['api-server', 'billing'],
      repoHashes: ['d01e5188b617', 'aa11bb22cc33'],
    };
    const repo = fakeRepo(() => [
      fn('d01e5188b617:method:src/companies.controller.ts:createCompany', 'src/companies.controller.ts', 45),
      fn('aa11bb22cc33:method:src/companies.service.ts:createCompany', 'src/companies.service.ts', 120),
    ]);
    const amb = await detectAmbiguity(repo, {
      name: 'createCompany',
      scope: multiRepoScope,
      nodeTypes: toNodeTypes('function'),
      resolvedId: 'd01e5188b617:method:src/companies.controller.ts:createCompany',
      resolvedFilePath: 'src/companies.controller.ts',
    });
    expect(amb).toBeDefined();
    expect(amb!.hint).toContain('src/companies.service.ts:120 [repo: billing]');
  });

  it('leaves the alternatives untagged in a single-repo scope', async () => {
    const repo = fakeRepo(() => [
      fn('d01e5188b617:method:src/a.ts:createCompany', 'src/a.ts', 1),
      fn('d01e5188b617:method:src/b.ts:createCompany', 'src/b.ts', 2),
    ]);
    const amb = await detectAmbiguity(repo, {
      name: 'createCompany',
      scope,
      nodeTypes: toNodeTypes('function'),
      resolvedId: 'd01e5188b617:method:src/a.ts:createCompany',
    });
    expect(amb).toBeDefined();
    expect(amb!.hint).not.toContain('[repo:');
  });

  it('never throws — a repo failure yields no hint', async () => {
    const repo = fakeRepo(() => {
      throw new Error('db down');
    });
    const amb = await detectAmbiguity(repo, {
      name: 'createCompany',
      scope,
      nodeTypes: toNodeTypes('function'),
      resolvedId: 'a:1',
    });
    expect(amb).toBeUndefined();
  });
});
