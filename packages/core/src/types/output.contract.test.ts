// packages/core/src/types/output.contract.test.ts
import { describe, expect, it } from 'vitest';
import type { ExternalCallEdge, FunctionNode } from './output.js';

describe('cross-repo moniker contract', () => {
  it('ExternalCallEdge carries an optional SCIP moniker { packageName, descriptor }', () => {
    const edge: ExternalCallEdge = {
      id: 'e1',
      versionedId: 'e1@v',
      callerId: 'c1',
      serviceName: 'demo-api',
      method: 'dailySummaries',
      location: { filePath: 'a.ts', startLine: 1, endLine: 1 },
      moniker: {
        packageName: '@sample/demo-api-client',
        descriptor: 'src/`index.d.ts`/CalculationsClient#dailySummaries().',
      },
    };
    expect(edge.moniker?.packageName).toBe('@sample/demo-api-client');
    expect(edge.moniker?.descriptor).toContain('dailySummaries');
  });

  it('FunctionNode carries an optional SCIP moniker for SDK-source exported methods', () => {
    const fn: FunctionNode = {
      id: 'm1',
      versionedId: 'm1@v',
      name: 'dailySummaries',
      kind: 'method',
      fileId: 'f1',
      isAsync: false,
      isGenerator: false,
      parameters: [],
      location: { filePath: 'src/lib/core/calculations.ts', startLine: 10, endLine: 12 },
      moniker: {
        packageName: '@sample/demo-api-client',
        descriptor: 'src/lib/core/`calculations.ts`/CalculationsClient#dailySummaries().',
      },
    };
    expect(fn.moniker?.packageName).toBe('@sample/demo-api-client');
  });
});
