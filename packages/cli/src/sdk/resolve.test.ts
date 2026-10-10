import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const { trackSpy } = vi.hoisted(() => ({ trackSpy: vi.fn() }));

// Keep the real event vocabulary; only intercept the emit sink so no config
// read / PostHog transport runs and the ResolveCompleted props are assertable.
vi.mock('@coredoc/core/telemetry', async (importActual) => {
  const actual = await importActual<typeof import('@coredoc/core/telemetry')>();
  return { ...actual, track: trackSpy };
});

import { runResolveCore } from './resolve.js';
import { loadConfig } from '@coredoc/core/utils';
import { EventName } from '@coredoc/core/telemetry';
import { linkWorkspace, type ParsedRepoLike } from '@coredoc/core';
import type { Entrypoint, ExternalCallEdge } from '@coredoc/core/types';
import type { LinkResult } from '@coredoc/core';

let tmp: string;

beforeEach(() => {
  trackSpy.mockClear();
  tmp = mkdtempSync(join(tmpdir(), 'sdk-resolve-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeParsedRepo(id: string, name: string) {
  return {
    id,
    name,
    type: 'backend',
    rootPath: '/x',
    files: [],
    functions: [],
    classes: [],
    interfaces: [],
    entrypoints: [],
    entities: [],
    externalCalls: [],
    components: [],
    routes: [],
    stateStores: [],
    typeAliases: [],
    enums: [],
    variables: [],
    parsedAt: new Date().toISOString(),
  };
}

describe('runResolveCore', () => {
  it('walks {outputDir}/{projectId}/{repoName}.json and writes resolved-graph.json', () => {
    const configPath = join(tmp, 'coredoc.config.json');
    mkdirSync(join(tmp, 'svc-a'), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        version: '2.0',
        projects: [
          {
            id: 'alpha',
            name: 'Alpha',
            repos: [{ name: 'svc-a', path: './svc-a', type: 'backend' }],
          },
        ],
        output: { dir: './out', format: 'json' },
        parserStorage: './parsers',
        agentMode: 'interactive',
      }),
      'utf-8',
    );

    mkdirSync(join(tmp, 'out', 'alpha'), { recursive: true });
    writeFileSync(
      join(tmp, 'out', 'alpha', 'svc-a.json'),
      JSON.stringify(makeParsedRepo('repo:svc-a', 'svc-a')),
      'utf-8',
    );

    const config = loadConfig(configPath);
    const result = runResolveCore({ config, verbose: false });

    expect(result.stats.totalRepos).toBe(1);
    expect(result.outputPath).toBe(resolve(tmp, 'resolved-graph.json'));
  });

  it('serializes package-import edges without changing protocol resolution stats', () => {
    const configPath = join(tmp, 'coredoc.config.json');
    for (const name of ['consumer', 'acme-packages']) mkdirSync(join(tmp, name), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        version: '2.0',
        projects: [
          {
            id: 'alpha',
            name: 'Alpha',
            repos: [
              { name: 'consumer', path: './consumer', type: 'backend' },
              { name: 'acme-packages', path: './acme-packages', type: 'backend' },
            ],
          },
        ],
        output: { dir: './out', format: 'json' },
        parserStorage: './parsers',
        agentMode: 'interactive',
      }),
      'utf-8',
    );
    mkdirSync(join(tmp, 'out', 'alpha'), { recursive: true });
    const consumer = {
      ...makeParsedRepo('consumer-id', 'consumer'),
      packages: [{ id: 'consumer-package', name: '@acme/consumer', path: '.' }],
      files: [
        {
          id: 'consumer-file',
          versionedId: 'consumer-file@v',
          path: 'src/use-booking.ts',
          extension: '.ts',
          packageId: 'consumer-package',
          language: 'typescript',
          contentHash: 'consumer-hash',
        },
      ],
      imports: [
        {
          id: 'consumer-import',
          sourceFileId: 'consumer-file',
          moduleSpecifier: '@acme/acme-api-client',
          isTypeOnly: true,
          importKind: 'named',
          importedNames: [{ name: 'BookingTypes' }],
        },
      ],
    };
    const provider = {
      ...makeParsedRepo('provider-id', 'acme-packages'),
      packages: [
        {
          id: 'provider-package',
          name: '@acme/acme-api-client',
          path: 'packages/acme-api-client',
        },
      ],
      files: [
        {
          id: 'provider-file',
          versionedId: 'provider-file@v',
          path: 'packages/acme-api-client/src/enums.ts',
          extension: '.ts',
          packageId: 'provider-package',
          language: 'typescript',
          contentHash: 'provider-hash',
        },
      ],
      enums: [
        {
          id: 'provider-enum',
          versionedId: 'provider-enum@v',
          name: 'BookingTypes',
          kind: 'enum',
          fileId: 'provider-file',
          isExported: true,
          isConst: false,
          members: [],
          location: { filePath: 'packages/acme-api-client/src/enums.ts', startLine: 1, endLine: 2 },
        },
      ],
    };
    writeFileSync(join(tmp, 'out', 'alpha', 'consumer.json'), JSON.stringify(consumer), 'utf-8');
    writeFileSync(join(tmp, 'out', 'alpha', 'acme-packages.json'), JSON.stringify(provider), 'utf-8');

    const config = loadConfig(configPath);
    const result = runResolveCore({ config, verbose: false });
    const output = JSON.parse(readFileSync(result.outputPath, 'utf-8')) as {
      crossRepoEdges: unknown[];
      packageImportEdges?: Array<{ sourceId: string; targetId: string }>;
    };

    expect(result.stats).toMatchObject({ totalExternalCalls: 0, resolvedEdges: 0, unresolvedCalls: 0 });
    expect(output.crossRepoEdges).toEqual([]);
    expect(output.packageImportEdges).toEqual([
      expect.objectContaining({ sourceId: 'consumer-file', targetId: 'provider-enum' }),
    ]);
  });

  it('throws when no parsed repos exist', () => {
    const configPath = join(tmp, 'coredoc.config.json');
    mkdirSync(join(tmp, 'svc-a'), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        version: '2.0',
        projects: [
          {
            id: 'alpha',
            name: 'Alpha',
            repos: [{ name: 'svc-a', path: './svc-a', type: 'backend' }],
          },
        ],
        output: { dir: './out', format: 'json' },
        parserStorage: './parsers',
        agentMode: 'interactive',
      }),
      'utf-8',
    );
    mkdirSync(join(tmp, 'out'), { recursive: true });

    const config = loadConfig(configPath);
    expect(() => runResolveCore({ config })).toThrow(/No parsed repo files found/);
  });
});

// Guards the contract `sdk/resolve.ts` now depends on: linkWorkspace returns
// edges keyed by sourceId (external-call id) + targetId (entrypoint id), with
// sourceRepoName in properties — the exact fields the resolved-graph report
// serializes after the migration off resolveExternalCalls.
describe('sdk resolve report depends on linkWorkspace shape', () => {
  it('produces edges with sourceId/targetId/sourceRepoName for a direct HTTP call', () => {
    const web: ParsedRepoLike = {
      id: 'r-web',
      name: 'web',
      entrypoints: [],
      externalCalls: [
        {
          id: 'c1',
          versionedId: 'c1@1',
          callerId: 'fn',
          serviceName: 'svc',
          method: 'm',
          targetDescriptor: { protocol: 'http', http: { method: 'GET', pathTemplate: '/users/:id' } },
          location: { filePath: 'c.ts', startLine: 1, endLine: 1 },
        } as ExternalCallEdge,
      ],
    };
    const users: ParsedRepoLike = {
      id: 'r-users',
      name: 'users-svc',
      entrypoints: [
        {
          id: 'ep-users',
          versionedId: 'ep@1',
          type: 'http',
          handlerId: 'h',
          location: { filePath: 'f.ts', startLine: 1, endLine: 2 },
          details: { type: 'http', method: 'GET', path: '/users/:id', fullPath: '/users/:id' },
        } as Entrypoint,
      ],
      externalCalls: [],
    };

    const result: LinkResult = linkWorkspace([web, users]);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]!.sourceId).toBe('c1');
    expect(result.edges[0]!.targetId).toBe('ep-users');
    expect(result.edges[0]!.properties.sourceRepoName).toBe('web');
  });
});

// P1.T3: runResolveCore is synchronous and NOT trackOperation-wrapped, so the
// resolve_completed funnel event is attached directly inside it (timed with
// Date.now() deltas). edges_resolved maps to the real stats.resolvedEdges field.
describe('runResolveCore — resolve_completed telemetry (P1.T3)', () => {
  function writeSingleRepoConfig(): string {
    const configPath = join(tmp, 'coredoc.config.json');
    mkdirSync(join(tmp, 'svc-a'), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        version: '2.0',
        projects: [{ id: 'alpha', name: 'Alpha', repos: [{ name: 'svc-a', path: './svc-a', type: 'backend' }] }],
        output: { dir: './out', format: 'json' },
        parserStorage: './parsers',
        agentMode: 'interactive',
      }),
      'utf-8',
    );
    mkdirSync(join(tmp, 'out', 'alpha'), { recursive: true });
    writeFileSync(
      join(tmp, 'out', 'alpha', 'svc-a.json'),
      JSON.stringify(makeParsedRepo('repo:svc-a', 'svc-a')),
      'utf-8',
    );
    return configPath;
  }

  it('emits resolve_completed once with edges_resolved + duration_ms', () => {
    const config = loadConfig(writeSingleRepoConfig());

    const result = runResolveCore({ config, verbose: false });

    const completed = trackSpy.mock.calls.filter((c) => c[0] === EventName.ResolveCompleted);
    expect(completed).toHaveLength(1);
    const props = completed[0]?.[1] as { edges_resolved: number; duration_ms: number };
    expect(props.edges_resolved).toBe(result.stats.resolvedEdges);
    expect(typeof props.duration_ms).toBe('number');
    expect(props.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('does NOT emit resolve_completed when resolution throws (no parsed repos)', () => {
    const configPath = join(tmp, 'coredoc.config.json');
    mkdirSync(join(tmp, 'svc-a'), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        version: '2.0',
        projects: [{ id: 'alpha', name: 'Alpha', repos: [{ name: 'svc-a', path: './svc-a', type: 'backend' }] }],
        output: { dir: './out', format: 'json' },
        parserStorage: './parsers',
        agentMode: 'interactive',
      }),
      'utf-8',
    );
    mkdirSync(join(tmp, 'out'), { recursive: true });
    const config = loadConfig(configPath);

    expect(() => runResolveCore({ config })).toThrow(/No parsed repo files found/);
    expect(trackSpy.mock.calls.find((c) => c[0] === EventName.ResolveCompleted)).toBeUndefined();
  });
});
