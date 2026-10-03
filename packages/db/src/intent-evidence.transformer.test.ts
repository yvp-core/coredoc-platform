/**
 * End-to-end property-shape proof for intent code anchors (spec's named
 * misleading-green trap: "Anchor unit tests pass against hand-built nodes while
 * real parse output stores different properties").
 *
 * Every other anchor test seeds `GraphNode` literals it wrote itself, so it
 * would stay green even if the real pipeline persisted the versioned ID under a
 * different key, nested it, or serialized it as something other than a string.
 * This test therefore takes the production path for the parts that own that
 * shape:
 *
 * 1. real {@link StableIdGenerator} mints the stable and versioned IDs,
 * 2. the real {@link transformParsedRepo} turns a `ParsedRepo` into graph nodes,
 * 3. a real project SQLite database stores and reads them back,
 * 4. the anchor's `capturedVersionedId` is taken from the TRANSFORMER OUTPUT —
 *    never re-derived here — so a change to the emitted key path or value form
 *    breaks this test instead of passing silently.
 *
 * Limitation: the `ParsedRepo` fixture is hand-built rather than produced by a
 * tree-sitter parse. It is the parser (not the transformer) that fills
 * `versionedId`, so this proves the transform → persist → read contract; the
 * parse → sidecar side is covered in `@coredoc/profile-parser`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StableIdGenerator } from '@coredoc/core';
import type { FileNode, FunctionNode, ParsedRepo } from '@coredoc/core';
import { closeAllDrivers, closeProjectDatabases, openProjectDatabase } from './backend-factory.js';
import { transformParsedRepo } from './transformer.js';
import { NodeType } from './types.js';
import { AnchorStatus, resolveIntentEvidence, type AnchoredIntentSubject } from './intent-evidence.js';

const REPO_NAME = 'api';
const SOURCE = 'export function handle(id: string) {\n  return id;\n}\n';
const CONTENT_HASH = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'intent-transformer-'));
});

afterEach(async () => {
  await Promise.allSettled([closeAllDrivers(), closeProjectDatabases()]);
  rmSync(workspace, { recursive: true, force: true });
});

/** One file, one exported function — the smallest repo that can carry an anchor. */
function buildParsedRepo(ids: StableIdGenerator): ParsedRepo {
  const file: FileNode = {
    id: ids.fileId('src/handler.ts'),
    versionedId: ids.versionedFileId('src/handler.ts', CONTENT_HASH),
    path: 'src/handler.ts',
    extension: '.ts',
    packageId: `${ids.getRepoHash()}:package:root`,
    language: 'typescript',
    contentHash: CONTENT_HASH,
  };

  const fn: FunctionNode = {
    id: ids.functionId('src/handler.ts', 'handle'),
    versionedId: ids.versionedFunctionId('src/handler.ts', 'handle', SOURCE),
    kind: 'function',
    name: 'handle',
    fileId: file.id,
    isAsync: false,
    isGenerator: false,
    isExported: true,
    parameters: [],
    location: { filePath: 'src/handler.ts', startLine: 1, endLine: 3 },
  };

  return {
    id: ids.getRepoHash(),
    name: REPO_NAME,
    path: '/fixture/api',
    type: 'backend',
    parsedAt: '2026-08-26T00:00:00Z',
    parserVersion: '1.0.0',
    parserId: 'intent-fixture',
    packages: [],
    files: [file],
    functions: [fn],
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
  };
}

function item(capturedVersionedId: string, nodeId: string): AnchoredIntentSubject {
  return {
    id: 'BR-1',
    codeAnchors: [
      {
        repo: REPO_NAME,
        nodeId,
        nodeType: NodeType.Function,
        capturedVersionedId,
        rationale: 'the request is handled here',
      },
    ],
  };
}

describe('intent anchors against real transformer output', () => {
  it('matches an anchor capturing the versionedId the real transformer persisted', async () => {
    const ids = new StableIdGenerator('/fixture/api', REPO_NAME);
    const parsed = buildParsedRepo(ids);
    const { nodes } = transformParsedRepo(parsed);

    const functionNode = nodes.find((node) => node.type === NodeType.Function && node.name === 'handle');
    // Read the anchor target off the production output rather than re-deriving
    // it: this is the assertion that the property key path is real.
    const emittedVersionedId = functionNode?.properties.versionedId;
    expect(typeof emittedVersionedId).toBe('string');

    const project = await openProjectDatabase(workspace, 'transformer-project');
    await project.graph.pushNodes(nodes);

    const matched = await resolveIntentEvidence({
      repository: project.graph,
      items: [item(emittedVersionedId as string, functionNode?.id as string)],
      repoHashesByName: { [REPO_NAME]: ids.getRepoHash() },
      observedCheckouts: {},
    });

    expect(matched.items[0]?.anchors[0]?.status).toBe(AnchorStatus.Matched);
    expect(matched.items[0]?.anchors[0]?.currentVersionedId).toBe(emittedVersionedId);

    const changed = await resolveIntentEvidence({
      repository: project.graph,
      items: [item(`${emittedVersionedId as string}-captured-earlier`, functionNode?.id as string)],
      repoHashesByName: { [REPO_NAME]: ids.getRepoHash() },
      observedCheckouts: {},
    });

    expect(changed.items[0]?.anchors[0]?.status).toBe(AnchorStatus.Changed);
    expect(changed.items[0]?.anchors[0]?.currentVersionedId).toBe(emittedVersionedId);
  });

  it('persists the anchored versionedId as a plain string on the stored node', async () => {
    const ids = new StableIdGenerator('/fixture/api', REPO_NAME);
    const parsed = buildParsedRepo(ids);
    const { nodes } = transformParsedRepo(parsed);
    const project = await openProjectDatabase(workspace, 'transformer-project');
    await project.graph.pushNodes(nodes);

    const stored = await project.graph.getNodeWithProperties(parsed.functions[0]?.id as string, [ids.getRepoHash()]);

    // Round-tripped through the real backend: same key, same string, not nested
    // and not re-serialized.
    expect(stored?.properties.versionedId).toBe(parsed.functions[0]?.versionedId);
    expect(stored?.properties.versionedId).toMatch(/^[0-9a-f]{12}:function:src\/handler\.ts:handle@[0-9a-f]+$/);
  });
});
