import { StableIdGenerator } from '@coredoc/core';
import type { FunctionNode, ParsedRepo } from '@coredoc/core/types';
import { describe, expect, it } from 'vitest';
import {
  type AnchorRecord,
  parsedRepoSnapshot,
  resolveAnchorEnvelope,
} from './index.js';

const SHA = 'a'.repeat(40);

function parsedRepo(): ParsedRepo {
  const ids = new StableIdGenerator('/fixtures/api', 'api');
  const filePath = 'src/orders.ts';
  const fileId = ids.fileId(filePath);
  const fn = (name: string, version: string): FunctionNode => {
    const id = ids.functionId(filePath, name);
    return {
      id,
      versionedId: `${id}@${version}`,
      kind: 'function',
      name,
      fileId,
      isAsync: false,
      isGenerator: false,
      parameters: [],
      isExported: true,
      location: { filePath, startLine: 2, endLine: 4 },
    };
  };
  return {
    id: `${ids.getRepoHash()}:repository:api`,
    name: 'api',
    path: '/fixtures/api',
    parsedAt: '2026-09-13T00:00:00.000Z',
    parserVersion: 'fixture',
    parserId: 'fixture',
    git: { commitHash: SHA, commitShortHash: SHA.slice(0, 7), branch: 'main', isDirty: false },
    packages: [],
    files: [
      {
        id: fileId,
        versionedId: `${fileId}@file-v2`,
        path: filePath,
        extension: '.ts',
        packageId: '',
        language: 'typescript',
        contentHash: 'file-v2',
      },
    ],
    functions: [fn('place', 'fn-v2')],
    classes: [],
    interfaces: [],
    typeAliases: [],
    enums: [],
    variables: [],
    entrypoints: [],
    entities: [],
    dbOperations: [],
    calls: [],
    imports: [],
    externalCalls: [],
    stats: {
      totalFiles: 1,
      parsedFiles: 1,
      skippedFiles: 0,
      totalFunctions: 1,
      totalClasses: 0,
      totalEntrypoints: 0,
      totalEntities: 0,
      totalCalls: 0,
      totalImports: 0,
      totalExternalCalls: 0,
      parseTimeMs: 1,
    },
  };
}

describe('locator resolution against real transformer output', () => {
  it('returns graph-owned ids and version baselines for file and exact-name symbol locators', () => {
    const parsed = parsedRepo();
    const snapshot = parsedRepoSnapshot(parsed, 'api', 'graph-v2');
    const resolution = resolveAnchorEnvelope(
      {
        schemaVersion: 1,
        headSha: SHA,
        bindings: [
          { itemId: 'br-orders', files: ['src/orders.ts'], symbols: ['src/orders.ts#place'], replaceNodeIds: [] },
        ],
      },
      snapshot,
      [],
    );

    expect(resolution.mappings).toEqual([
      {
        itemId: 'br-orders',
        kind: 'mapped',
        replaceNodeIds: [],
        targets: [
          {
            nodeId: parsed.files[0]?.id,
            nodeType: 'file',
            capturedVersionedId: parsed.files[0]?.versionedId,
            filePath: 'src/orders.ts',
          },
          {
            nodeId: parsed.functions[0]?.id,
            nodeType: 'function',
            capturedVersionedId: parsed.functions[0]?.versionedId,
            filePath: 'src/orders.ts',
          },
        ],
      },
    ]);
  });

  it('resolves new symbols only after they enter the graph', () => {
    const postChange = parsedRepo();
    const preChange: ParsedRepo = { ...postChange, functions: [], stats: { ...postChange.stats, totalFunctions: 0 } };
    const envelope = {
      schemaVersion: 1 as const,
      headSha: SHA,
      bindings: [
        {
          itemId: 'br-orders',
          files: [],
          symbols: ['src/orders.ts#place'],
          replaceNodeIds: [],
        },
      ],
    };
    expect(resolveAnchorEnvelope(envelope, parsedRepoSnapshot(preChange, 'api', 'graph-v1'), []).mappings).toEqual([
      { itemId: 'br-orders', kind: 'unresolved', reason: 'target_unresolved' },
    ]);

    const resolved = resolveAnchorEnvelope(envelope, parsedRepoSnapshot(postChange, 'api', 'graph-v2'), []);
    expect(resolved.mappings).toEqual([expect.objectContaining({
      itemId: 'br-orders', kind: 'mapped', targets: [expect.objectContaining({
        nodeId: postChange.functions[0]?.id, capturedVersionedId: postChange.functions[0]?.versionedId,
      })],
    })]);

  });

  it('verifies replacement ids from current CI anchors even when the old node is absent', () => {
    const parsed = parsedRepo();
    const old: AnchorRecord = {
      itemId: 'br-orders',
      repoKey: 'api',
      nodeId: 'historical-node-id',
      nodeType: 'function',
      capturedVersionedId: 'historical-node-id@v1',
      filePath: 'src/old-orders.ts',
      source: 'ci',
    };
    const resolution = resolveAnchorEnvelope(
      {
        schemaVersion: 1,
        headSha: SHA,
        bindings: [
          {
            itemId: 'br-orders',
            files: [],
            symbols: ['src/orders.ts#place'],
            replaceNodeIds: ['historical-node-id'],
          },
        ],
      },
      parsedRepoSnapshot(parsed, 'api', 'graph-v2'),
      [old],
    );

    expect(resolution.mappings[0]).toMatchObject({ kind: 'mapped', replaceNodeIds: ['historical-node-id'] });
    expect(resolution.protectedPaths).toEqual(['src/old-orders.ts', 'src/orders.ts']);
  });

  it('marks zero and multiple exact-name matches unresolved without a file fallback', () => {
    const parsed = parsedRepo();
    const duplicate = {
      ...parsed.functions[0],
      id: `${parsed.functions[0]?.id}-duplicate-kind`,
      kind: 'method' as const,
    };
    parsed.functions.push(duplicate);
    const snapshot = parsedRepoSnapshot(parsed, 'api', 'graph-v2');
    const result = resolveAnchorEnvelope(
      {
        schemaVersion: 1,
        headSha: SHA,
        bindings: [
          { itemId: 'ambiguous', files: [], symbols: ['src/orders.ts#place'], replaceNodeIds: [] },
          { itemId: 'missing', files: [], symbols: ['src/orders.ts#missing'], replaceNodeIds: [] },
        ],
      },
      snapshot,
      [],
    );

    expect(result.mappings).toEqual([
      { itemId: 'ambiguous', kind: 'unresolved', reason: 'target_ambiguous' },
      { itemId: 'missing', kind: 'unresolved', reason: 'target_unresolved' },
    ]);


  });
});

describe('source naming at the PR mapping boundary', () => {
  const resolveNames = (nodes: ReturnType<typeof parsedRepoSnapshot>['nodes'], name: string) =>
    resolveAnchorEnvelope(
      {
        schemaVersion: 1,
        headSha: SHA,
        bindings: [{ itemId: 'br-orders', files: [], symbols: [`src/orders.ts#${name}`], replaceNodeIds: [] }],
      },
      { ...parsedRepoSnapshot(parsedRepo(), 'api', 'v1'), nodes },
      [],
    ).mappings[0];

  it('accepts class-qualified methods only when graph ownership proves the qualifier', () => {
    const fn = parsedRepoSnapshot(parsedRepo(), 'api', 'v1').nodes.find((n) => n.name === 'place')!;
    const owner = { ...fn, id: 'owner', name: 'Orders', type: 'class' as typeof fn.type };
    const method = { ...fn, properties: { ...fn.properties, kind: 'method', classId: owner.id } };
    expect(resolveNames([owner, method], 'Orders.place')?.kind).toBe('mapped');
    expect(resolveNames([owner, method], 'Wrong.place')?.kind).toBe('unresolved');
    expect(resolveNames([fn], 'Orders.place')?.kind).toBe('unresolved');
  });

  it('canonicalizes only duplicate React functional declarations at the same source position', () => {
    const fn = parsedRepoSnapshot(parsedRepo(), 'api', 'v1').nodes.find((n) => n.name === 'place')!;
    const component = {
      ...fn,
      id: 'component',
      type: 'component' as typeof fn.type,
      properties: { ...fn.properties, framework: 'react', componentType: 'functional' },
    };
    const result = resolveNames([component, fn], 'place');
    expect(result).toMatchObject({ kind: 'mapped', targets: [{ nodeId: fn.id }] });
    expect(resolveNames([component, { ...fn, startLine: 30 }], 'place')).toMatchObject({
      kind: 'unresolved',
      reason: 'target_ambiguous',
    });
    expect(resolveNames([component, fn, { ...fn, id: 'another-function' }], 'place')).toMatchObject({
      kind: 'unresolved',
      reason: 'target_ambiguous',
    });
  });
});
