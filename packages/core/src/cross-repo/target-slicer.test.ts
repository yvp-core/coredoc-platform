import { describe, it, expect, vi } from 'vitest';
import { sliceParsedRepoByTarget, type ParsedRepoDataForLinking } from './target-slicer.js';
import { linkWorkspace } from './linker.js';
import type { Entrypoint, ExternalCallEdge, FileNode, FunctionNode } from '../types/output.js';
import type { ServiceEntry } from './mapper-schema.js';

// =============================================================================
// Phase 3 — target-slicer units + slice→linkWorkspace integration.
// Spec: docs/superpowers/specs/2026-07-16-intra-repo-linking-mapper-v2.md §4.4/§4.5.
// =============================================================================

function file(id: string, path: string, target?: string): FileNode {
  return {
    id,
    versionedId: `${id}@1`,
    path,
    extension: '.ts',
    packageId: 'pkg',
    language: 'typescript',
    contentHash: 'h',
    ...(target !== undefined ? { target } : {}),
  };
}

function fn(id: string, fileId: string, filePath: string): FunctionNode {
  return {
    id,
    versionedId: `${id}@1`,
    name: id,
    location: { filePath, startLine: 1, endLine: 2 },
    kind: 'function',
    fileId,
    isAsync: false,
    isGenerator: false,
    parameters: [],
  };
}

function httpEntrypoint(id: string, handlerId: string, filePath: string, method: string, fullPath: string): Entrypoint {
  return {
    id,
    versionedId: `${id}@1`,
    type: 'http',
    handlerId,
    location: { filePath, startLine: 1, endLine: 2 },
    details: { type: 'http', method: method as never, path: fullPath, fullPath },
  } as Entrypoint;
}

function httpCall(
  id: string,
  callerId: string,
  filePath: string,
  method: string,
  pathTemplate: string,
): ExternalCallEdge {
  return {
    id,
    versionedId: `${id}@1`,
    callerId,
    serviceName: 'svc',
    method: 'm',
    targetDescriptor: { protocol: 'http', http: { method: method as never, pathTemplate } },
    location: { filePath, startLine: 1, endLine: 1 },
  } as ExternalCallEdge;
}

function baseRepo(over: Partial<ParsedRepoDataForLinking>): ParsedRepoDataForLinking {
  return {
    id: 'r1',
    name: 'mono',
    type: 'monorepo',
    entrypoints: [],
    externalCalls: [],
    functions: [],
    files: [],
    ...over,
  };
}

// -----------------------------------------------------------------------------
// Single-target passthrough (byte-compatible).
// -----------------------------------------------------------------------------
describe('sliceParsedRepoByTarget: single-target passthrough', () => {
  it('returns ONE slice with the original repo name + node arrays when no file carries a target', () => {
    const eps = [httpEntrypoint('ep', 'ep-h', 'a.ts', 'GET', '/x')];
    const ecs = [httpCall('c', 'c-fn', 'b.ts', 'GET', '/y')];
    const fns = [fn('f', 'file-a', 'a.ts')];
    const repo = baseRepo({
      name: 'svc-a',
      entrypoints: eps,
      externalCalls: ecs,
      functions: fns,
      files: [file('file-a', 'a.ts'), file('file-b', 'b.ts')],
    });

    const slices = sliceParsedRepoByTarget(repo, [], '/api');

    expect(slices).toHaveLength(1);
    expect(slices[0]!.target).toBeUndefined();
    expect(slices[0]!.repoLike.name).toBe('svc-a');
    // Same node arrays flow through unchanged.
    expect(slices[0]!.repoLike.entrypoints).toBe(eps);
    expect(slices[0]!.repoLike.externalCalls).toBe(ecs);
    expect(slices[0]!.repoLike.functions).toBe(fns);
    expect(slices[0]!.repoLike.httpPrefix).toBe('/api');
  });

  it('applies a repo-level (target-absent) service httpPrefix over the fallback prefix (§4.3 precedence)', () => {
    const repo = baseRepo({ name: 'svc-a', files: [file('f', 'a.ts')] });
    const entries: ServiceEntry[] = [{ name: 'svc-a', repo: 'svc-a', aliases: [], httpPrefix: '/gw' }];

    const slices = sliceParsedRepoByTarget(repo, entries, '/api');

    expect(slices).toHaveLength(1);
    expect(slices[0]!.repoLike.httpPrefix).toBe('/gw');
  });
});

// -----------------------------------------------------------------------------
// Multi-target slicing + naming + prefix precedence.
// -----------------------------------------------------------------------------
describe('sliceParsedRepoByTarget: multi-target', () => {
  const repo = baseRepo({
    name: 'mono',
    files: [file('file-ui', 'ui/app.ts', 'ui'), file('file-api', 'api/handler.ts', 'api')],
    functions: [fn('fn-ui', 'file-ui', 'ui/app.ts'), fn('fn-api', 'file-api', 'api/handler.ts')],
    entrypoints: [httpEntrypoint('ep-api', 'fn-api', 'api/handler.ts', 'GET', '/api/users')],
    externalCalls: [httpCall('c-ui', 'fn-ui', 'ui/app.ts', 'GET', '/api/users')],
  });

  it('splits into one slice per target, attributing entrypoints/externalCalls/functions by fileId', () => {
    const slices = sliceParsedRepoByTarget(repo, [], undefined);

    expect(slices.map((s) => s.target).sort()).toEqual(['api', 'ui']);
    const api = slices.find((s) => s.target === 'api')!;
    const ui = slices.find((s) => s.target === 'ui')!;

    expect(api.repoLike.entrypoints.map((e) => e.id)).toEqual(['ep-api']);
    expect(api.repoLike.externalCalls).toHaveLength(0);
    expect((api.repoLike.functions ?? []).map((f) => f.id)).toEqual(['fn-api']);

    expect(ui.repoLike.externalCalls.map((c) => c.id)).toEqual(['c-ui']);
    expect(ui.repoLike.entrypoints).toHaveLength(0);
    expect((ui.repoLike.functions ?? []).map((f) => f.id)).toEqual(['fn-ui']);
  });

  it('keeps package-import facts with their owning target slice', () => {
    const importEdge = {
      id: 'import-ui',
      sourceFileId: 'file-ui',
      moduleSpecifier: '@acme/types',
      isTypeOnly: true,
      importKind: 'named' as const,
      importedNames: [{ name: 'Status' }],
    };
    const exportedEnum = {
      id: 'enum-api',
      versionedId: 'enum-api@1',
      name: 'Status',
      kind: 'enum' as const,
      fileId: 'file-api',
      isExported: true,
      isConst: false,
      members: [],
      location: { filePath: 'api/handler.ts', startLine: 1, endLine: 2 },
    };
    const repoWithPackageFacts = {
      ...repo,
      packages: [{ id: 'pkg', name: '@acme/mono', path: '.' }],
      imports: [importEdge],
      classes: [],
      interfaces: [],
      typeAliases: [],
      enums: [exportedEnum],
      variables: [],
    } as unknown as ParsedRepoDataForLinking;

    const slices = sliceParsedRepoByTarget(repoWithPackageFacts, [], undefined);
    const api = slices.find((slice) => slice.target === 'api')!.repoLike as unknown as {
      imports?: Array<{ id: string }>;
      enums?: Array<{ id: string }>;
    };
    const ui = slices.find((slice) => slice.target === 'ui')!.repoLike as unknown as {
      imports?: Array<{ id: string }>;
      enums?: Array<{ id: string }>;
    };

    expect(ui.imports?.map((edge) => edge.id)).toEqual(['import-ui']);
    expect(ui.enums).toEqual([]);
    expect(api.imports).toEqual([]);
    expect(api.enums?.map((node) => node.id)).toEqual(['enum-api']);
  });

  it('DEFAULT names slices "<repo>#<target>" with no mapper row and shares the merged repo id', () => {
    const slices = sliceParsedRepoByTarget(repo, [], undefined);
    const names = slices.map((s) => s.repoLike.name).sort();
    expect(names).toEqual(['mono#api', 'mono#ui']);
    expect(slices.every((s) => s.repoLike.id === 'r1')).toBe(true);
  });

  it('OVERRIDES the default name from the mapper (repo,target) row', () => {
    const entries: ServiceEntry[] = [
      { name: 'billing-api', repo: 'mono', aliases: [], target: 'api' },
      { name: 'web-ui', repo: 'mono', aliases: [], target: 'ui', httpPrefix: '/app' },
    ];
    const slices = sliceParsedRepoByTarget(repo, entries, '/api');

    const api = slices.find((s) => s.target === 'api')!;
    const ui = slices.find((s) => s.target === 'ui')!;
    expect(api.repoLike.name).toBe('billing-api');
    expect(ui.repoLike.name).toBe('web-ui');
    // Prefix precedence: ui has its own httpPrefix; api falls back to RepoConfig prefix.
    expect(ui.repoLike.httpPrefix).toBe('/app');
    expect(api.repoLike.httpPrefix).toBe('/api');
  });

  it('attributes a synthetic entrypoint (no matching FunctionNode) via the location.filePath fallback (spec §8 — Ruby synthetic handlers risk)', () => {
    // Ruby-style entrypoint: handlerId has no FunctionNode counterpart, so
    // targetOf() in target-slicer.ts must fall back to targetByPath instead of
    // the (empty) fileIdByFunctionId lookup.
    const rubyRepo = baseRepo({
      name: 'mono',
      files: [file('file-ui', 'ui/app.ts', 'ui'), file('file-api', 'api/handler.rb', 'api')],
      functions: [fn('fn-ui', 'file-ui', 'ui/app.ts')], // no FunctionNode for the api handler
      entrypoints: [httpEntrypoint('ep-api', 'ruby-synthetic-handler', 'api/handler.rb', 'GET', '/api/users')],
    });

    const slices = sliceParsedRepoByTarget(rubyRepo, [], undefined);

    const api = slices.find((s) => s.target === 'api');
    expect(api).toBeDefined();
    expect(api!.repoLike.entrypoints.map((e) => e.id)).toEqual(['ep-api']);

    // Discriminates the fallback: if location.filePath attribution broke, this
    // entrypoint would fall through to the synthetic unattributed "<repo>" slice
    // instead — assert that slice doesn't even get created here.
    expect(slices.find((s) => s.target === undefined)).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// Unattributed bucket policy (fail fast, but never throw / never drop).
// -----------------------------------------------------------------------------
describe('sliceParsedRepoByTarget: unattributed bucket', () => {
  it('assigns nodes whose file has no target to a synthetic "<repo>" slice, counts + warns, never drops', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A multi-target repo (file-ui carries a target) but file-orphan carries none.
    const repo = baseRepo({
      name: 'mono',
      files: [file('file-ui', 'ui/app.ts', 'ui'), file('file-orphan', 'orphan.ts' /* no target */)],
      functions: [fn('fn-ui', 'file-ui', 'ui/app.ts'), fn('fn-orphan', 'file-orphan', 'orphan.ts')],
      externalCalls: [
        httpCall('c-ui', 'fn-ui', 'ui/app.ts', 'GET', '/x'),
        httpCall('c-orphan', 'fn-orphan', 'orphan.ts', 'GET', '/y'),
      ],
    });

    const slices = sliceParsedRepoByTarget(repo, [], undefined);

    // Synthetic slice named after the bare repo, holding the orphaned nodes.
    const synthetic = slices.find((s) => s.target === undefined && s.repoLike.name === 'mono');
    expect(synthetic).toBeDefined();
    expect(synthetic!.repoLike.externalCalls.map((c) => c.id)).toContain('c-orphan');
    expect((synthetic!.repoLike.functions ?? []).map((f) => f.id)).toContain('fn-orphan');
    // Nothing dropped: the orphan external call still exists somewhere.
    const allCalls = slices.flatMap((s) => s.repoLike.externalCalls.map((c) => c.id));
    expect(allCalls).toContain('c-orphan');
    expect(allCalls).toContain('c-ui');
    // Warned about the unattributed count.
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toMatch(/unattributed/);
    warn.mockRestore();
  });
});

// -----------------------------------------------------------------------------
// Integration: slice a merged ParsedRepo, then link → one intra-repo edge.
// -----------------------------------------------------------------------------
describe('slice → linkWorkspace integration (§4.4 + §4.5)', () => {
  it('resolves an intra-repo ui→api http edge between two slices of one merged repo', () => {
    // ts "ui" target fetches /api/users; py-style "api" target serves GET /api/users.
    const merged = baseRepo({
      name: 'shop',
      files: [file('file-ui', 'web/app.ts', 'ui'), file('file-api', 'server/users.py', 'api')],
      functions: [fn('fn-ui', 'file-ui', 'web/app.ts'), fn('fn-api', 'file-api', 'server/users.py')],
      entrypoints: [httpEntrypoint('ep-users', 'fn-api', 'server/users.py', 'GET', '/api/users')],
      externalCalls: [httpCall('c-fetch', 'fn-ui', 'web/app.ts', 'GET', '/api/users')],
    });

    const slices = sliceParsedRepoByTarget(merged, [], undefined);
    const result = linkWorkspace(slices.map((s) => s.repoLike));

    // Exactly one RESOLVES_TO, ui slice → api slice, carrying slice service names.
    expect(result.edges).toHaveLength(1);
    const edge = result.edges[0]!;
    expect(edge.sourceId).toBe('c-fetch');
    expect(edge.targetId).toBe('ep-users');
    expect(edge.properties.sourceRepoName).toBe('shop#ui');
    expect(edge.properties.targetRepoName).toBe('shop#api');
    expect(edge.properties.via).toBe('http');
  });

  it('provenance: mapper-named slices carry their service names on the edge', () => {
    const merged = baseRepo({
      name: 'shop',
      files: [file('file-ui', 'web/app.ts', 'ui'), file('file-api', 'server/users.py', 'api')],
      functions: [fn('fn-ui', 'file-ui', 'web/app.ts'), fn('fn-api', 'file-api', 'server/users.py')],
      entrypoints: [httpEntrypoint('ep-users', 'fn-api', 'server/users.py', 'GET', '/api/users')],
      externalCalls: [httpCall('c-fetch', 'fn-ui', 'web/app.ts', 'GET', '/api/users')],
    });
    const entries: ServiceEntry[] = [
      { name: 'shop-web', repo: 'shop', aliases: [], target: 'ui' },
      { name: 'shop-backend', repo: 'shop', aliases: [], target: 'api' },
    ];

    const slices = sliceParsedRepoByTarget(merged, entries, undefined);
    const result = linkWorkspace(slices.map((s) => s.repoLike));

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]!.properties.sourceRepoName).toBe('shop-web');
    expect(result.edges[0]!.properties.targetRepoName).toBe('shop-backend');
  });
});
