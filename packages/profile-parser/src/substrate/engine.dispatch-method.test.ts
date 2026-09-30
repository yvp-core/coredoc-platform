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
  } as unknown as Substrate;
}

function runEngine(facts: ExternalCallFact[]) {
  const idGen = new StableIdGenerator('/repo', 'k');
  const profile: ExtractionProfile = { name: 'fake', include: ['**/*.ts'], exclude: [] } as ExtractionProfile;
  const engine = new SubstrateProfileEngine(profile, fakeSubstrate(idGen, facts));
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
  return engine.run(baseline, { repoRoot: '/repo', repoName: 'fake' });
}

describe('extractExternalCalls — dispatchMethod pass-through', () => {
  it('copies the egress fact dispatchMethod onto the emitted ExternalCallEdge', () => {
    // A dynamic-dispatch egress: `method` is the wrapper verb, `dispatchMethod` carries
    // the real SDK method name read from the positional string arg.
    const fact: ExternalCallFact = {
      callerId: 'CALLER',
      serviceName: 'sample-management-api',
      sdkName: '@sample/management-api-client',
      method: 'PERFORMAPIREQUEST',
      dispatchMethod: 'listCompanyBookings',
      location: { filePath: 'a.ts', startLine: 5, endLine: 5 },
    };
    const repo = runEngine([fact]);
    const edge = repo.externalCalls.find((e) => e.callerId === 'CALLER');
    expect(edge?.method).toBe('PERFORMAPIREQUEST');
    expect(edge?.dispatchMethod).toBe('listCompanyBookings');
  });

  it('leaves dispatchMethod unset on an ordinary (non-dispatch) egress fact', () => {
    const fact: ExternalCallFact = {
      callerId: 'CALLER2',
      serviceName: 'demo-calculations',
      sdkName: '@sample/demo-api-client',
      method: 'dailySummaries',
      location: { filePath: 'a.ts', startLine: 5, endLine: 5 },
    };
    const repo = runEngine([fact]);
    const edge = repo.externalCalls.find((e) => e.callerId === 'CALLER2');
    expect(edge?.dispatchMethod).toBeUndefined();
  });

  // A destination-less messaging egress (client.connect/close) still gets a
  // protocol-only descriptor, so the call is visible without inventing an address.
  it('emits a protocol-only messaging descriptor for a destination-less fact', () => {
    const fact: ExternalCallFact = {
      callerId: 'CALLER3',
      serviceName: 'kafka',
      method: 'send',
      protocol: 'messaging',
      location: { filePath: 'a.ts', startLine: 8, endLine: 8 },
    };

    const repo = runEngine([fact]);
    const edge = repo.externalCalls.find((e) => e.callerId === 'CALLER3');

    expect(edge?.targetDescriptor).toEqual({ protocol: 'messaging' });
  });
});
