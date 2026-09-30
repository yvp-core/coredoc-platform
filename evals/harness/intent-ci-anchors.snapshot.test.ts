import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type GraphNode } from '@coredoc/core';
import { openIntentGraphFixture } from '@coredoc/db/testing';
import { expect, it } from 'vitest';
import fixture from '../cases-intent/context-first/fixture.json';
import { resolveAnchorEnvelope } from './intent-ci-anchors/index.js';

const snapshotPath = process.env.INTENT_CONTEXT_AB_GRAPH;

it.skipIf(!snapshotPath)(
  'resolves T2 names against the frozen production graph, preserving its versioned IDs',
  async () => {
    expect(createHash('sha256').update(readFileSync(snapshotPath!)).digest('hex')).toBe(fixture.graph.sha256);
    const graph = await openIntentGraphFixture(snapshotPath!, { readOnly: true });
    try {
      const path = 'apps/server/src/modules/delivery/github-intent-release.service.ts';
      const elements = await graph.repository.listSymbolsInFile(path, [fixture.graph.graphRepoHash]);
      const nodes: GraphNode[] = [];
      for (const element of elements.filter((entry) => entry.filePath === path)) {
        const stored = await graph.repository.getNodeWithProperties(element.id, [fixture.graph.graphRepoHash]);
        if (stored) nodes.push({ ...stored.node, properties: stored.properties });
      }
      const snapshot = {
        graphVersionId: fixture.graph.graphVersionId,
        commit: fixture.graph.graphCommit,
        repoKey: fixture.graph.repoKey,
        repoHash: fixture.graph.graphRepoHash,
        nodes,
      };
      const result = resolveAnchorEnvelope(
        {
          schemaVersion: 1,
          headSha: fixture.graph.graphCommit,
          bindings: [
            {
              itemId: 'cap-automatic-intent-release-recording',
              files: [path],
              symbols: [`${path}#GithubIntentReleaseService`, `${path}#productionBranchOf`],
              replaceNodeIds: [],
            },
          ],
        },
        snapshot,
        [],
      );
      const mapped = result.mappings[0];
      expect(mapped?.kind).toBe('mapped');
      if (mapped?.kind !== 'mapped') throw new Error('Expected real snapshot targets');
      expect(mapped.targets.map((target) => target.nodeType)).toEqual(['file', 'class', 'function']);
      for (const target of mapped.targets) {
        const persisted = nodes.find((node) => node.id === target.nodeId)!;
        expect(target.capturedVersionedId).toBe(persisted.properties.versionedId);
        expect(target.filePath).toBe(path);
      }
    } finally {
      await graph.close();
    }
  },
  30_000,
);
