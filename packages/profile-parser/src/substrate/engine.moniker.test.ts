import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { CodeGraph } from '../facts/graph/graph-builder.js';
import type { BaselineResult } from '../facts/index.js';
import type { ExtractionProfile } from '../types.js';
import { SubstrateProfileEngine } from './engine.js';
import type { ExternalCallFact, Substrate } from './interface.js';

function fakeSubstrate(idGen: StableIdGenerator, facts: ExternalCallFact[]): Substrate {
  return {
    files: () => [{ relativePath: 'a.ts' }],
    classes: () => [],
    functions: () => [],
    callShapes: () => [],
    resolveConst: () => undefined,
    resolveConstMember: () => undefined,
    requireRegistry: () => new Map(),
    internalCalls: () => [],
    externalCalls: () => facts,
    hasFunctionId: () => true,
    resolveMethodOnClass: () => undefined,
    functionId: () => undefined,
    componentSites: () => [],
    resolveJsxTagBySCIP: () => undefined,
    resolveJsxTagByImport: () => undefined,
    routeSites: () => [],
    stateStoreSites: () => [],
    idGen,
  };
}

describe('extractExternalCalls — moniker pass-through', () => {
  it('copies the egress fact moniker onto the emitted ExternalCallEdge', () => {
    const idGen = new StableIdGenerator('/repo', 'k');
    const fact: ExternalCallFact = {
      callerId: 'CALLER',
      serviceName: 'demo-calculations',
      sdkName: '@sample/demo-api-client',
      method: 'dailySummaries',
      location: { filePath: 'a.ts', startLine: 5, endLine: 5 },
      moniker: {
        packageName: '@sample/demo-api-client',
        descriptor: 'src/`index.d.ts`/CalculationsClient#dailySummaries().',
      },
    };
    const profile: ExtractionProfile = { name: 'fake', include: ['**/*.ts'], exclude: [] } as ExtractionProfile;
    const engine = new SubstrateProfileEngine(profile, fakeSubstrate(idGen, [fact]));
    const baseline: BaselineResult = {
      graph: new CodeGraph(),
      idGen,
      errors: [],
      plan: {
        vueFiles: [],
        languages: {
          typescript: { fileCount: 0, files: [] },
          javascript: { fileCount: 0, files: [] },
        },
      },
    } as unknown as BaselineResult;
    const repo = engine.run(baseline, { repoRoot: '/repo', repoName: 'fake' });
    const edge = repo.externalCalls.find((e) => e.method === 'dailySummaries');
    expect(edge?.moniker).toEqual({
      packageName: '@sample/demo-api-client',
      descriptor: 'src/`index.d.ts`/CalculationsClient#dailySummaries().',
    });
  });
});
