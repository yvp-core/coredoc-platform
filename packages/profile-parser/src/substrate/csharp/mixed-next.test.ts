import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { linkWorkspace, sliceParsedRepoByTarget } from '@coredoc/core';
import '../../providers/index.js';
import { parseMultiTarget } from '../../multi/orchestrate.js';
import { enumerateRepoFiles } from '../../facts/discovery/discover.js';
import { profile } from './__fixtures__/mixed-next/profile.js';

it('links Next.js calls to a C# basic endpoint and abstains on wrong method and missing route', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coredoc-mixed-next-'));
  try {
    cpSync(fileURLToPath(new URL('./__fixtures__/mixed-next', import.meta.url)), root, {
      recursive: true,
      filter: (source) => basename(source) !== 'profile.ts',
    });
    // This fixture has no npm dependencies; the existing TS preflight expects an
    // installed dependency directory. The bundled TS indexer runs normally.
    mkdirSync(join(root, 'node_modules'));
    const fingerprint = () => {
      const hash = createHash('sha256');
      for (const file of enumerateRepoFiles(root).sort()) hash.update(file).update(readFileSync(join(root, file)));
      return hash.digest('hex');
    };
    const before = fingerprint();
    const graph = await parseMultiTarget(profile, { repoRoot: root, repoName: 'mixed', repoKey: 'validation/mixed' });
    expect(graph.errors ?? []).toEqual([]);
    expect(graph.stats.analysis).toEqual([
      { language: 'csharp', target: 'backend', mode: 'basic', compilerReceiverTypes: false, fallback: false },
      { language: 'ts', target: 'web', mode: 'enhanced', compilerReceiverTypes: false, fallback: false },
    ]);
    expect(fingerprint()).toBe(before);
    const slices = sliceParsedRepoByTarget(graph, []);
    const linked = linkWorkspace(slices.map((slice) => slice.repoLike));
    const destination = graph.entrypoints.find(
      (entry) => entry.details.type === 'http' && entry.details.fullPath === '/api/v1/items',
    );
    expect(destination).toBeDefined();
    const functions = new Map(graph.functions.map((fn) => [fn.id, fn.name]));
    for (const caller of ['HomePage', 'ReadConfigured']) {
      const call = graph.externalCalls.find((edge) => functions.get(edge.callerId) === caller);
      expect(call).toBeDefined();
      expect(linked.edges.find((edge) => edge.sourceId === call!.id)?.targetId).toBe(destination!.id);
    }
    for (const caller of ['WrongMethod', 'MissingRoute']) {
      const call = graph.externalCalls.find((edge) => functions.get(edge.callerId) === caller);
      expect(call).toBeDefined();
      expect(linked.edges.some((edge) => edge.sourceId === call!.id)).toBe(false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
