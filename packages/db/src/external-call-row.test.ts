import { describe, it, expect } from 'vitest';
import { externalCallInfoFromRow, type ExternalCallRow } from './external-call-row.js';

const baseRow = (overrides: Partial<ExternalCallRow> = {}): ExternalCallRow => ({
  id: 'e1',
  callerId: 'c1',
  callerName: null,
  callerFilePath: null,
  serviceName: 'svc',
  targetService: null,
  sdkName: null,
  method: 'GET /x',
  protocol: 'http',
  httpMethod: null,
  pathTemplate: null,
  messagingSystem: null,
  messagingDestination: null,
  messagingDestinationRef: null,
  ipcDirection: null,
  grpcService: null,
  grpcMethod: null,
  graphqlOperationType: null,
  graphqlOperationName: null,
  monikerPackage: null,
  monikerDescriptor: null,
  dispatchMethod: null,
  resolvedTargetId: null,
  resolvedTargetRepoName: null,
  filePath: 'src/a.ts',
  startLine: 3,
  ...overrides,
});

describe('externalCallInfoFromRow', () => {
  it('omits absent optional keys entirely and defaults caller fields', () => {
    const info = externalCallInfoFromRow(baseRow());

    expect(info.callerName).toBe('unknown');
    expect(info.callerFilePath).toBe('');
    const keys = Object.keys(info);
    for (const optional of [
      'targetService',
      'sdkName',
      'httpMethod',
      'pathTemplate',
      'messagingSystem',
      'messagingDestination',
      'messagingDestinationRef',
      'ipcDirection',
      'grpcService',
      'grpcMethod',
      'graphqlOperationType',
      'graphqlOperationName',
      'moniker',
      'dispatchMethod',
      'resolvedTargetId',
      'resolvedTargetRepoName',
    ]) {
      expect(keys).not.toContain(optional);
    }
  });

  it('builds the moniker from monikerPackage, defaulting a missing descriptor to empty', () => {
    expect(externalCallInfoFromRow(baseRow({ monikerPackage: 'pkg' })).moniker).toEqual({
      packageName: 'pkg',
      descriptor: '',
    });
    expect(externalCallInfoFromRow(baseRow({ monikerPackage: 'pkg', monikerDescriptor: 'd' })).moniker).toEqual({
      packageName: 'pkg',
      descriptor: 'd',
    });
  });
});
