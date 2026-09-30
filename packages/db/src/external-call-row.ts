import type { ExternalCallInfo } from './types.js';

/**
 * The flat column projection both SQL-ish backends (SQLite, Neo4j) select for an
 * external call. Kept here with {@link externalCallInfoFromRow} so the four
 * query sites share ONE row→DTO mapping instead of four copies that drift.
 */
export interface ExternalCallRow {
  id: string;
  callerId: string;
  callerName: string | null;
  callerFilePath: string | null;
  serviceName: string;
  targetService: string | null;
  sdkName: string | null;
  method: string;
  protocol: string;
  httpMethod: string | null;
  pathTemplate: string | null;
  messagingSystem: string | null;
  messagingDestination: string | null;
  messagingDestinationRef: string | null;
  ipcDirection: string | null;
  grpcService: string | null;
  grpcMethod: string | null;
  graphqlOperationType: string | null;
  graphqlOperationName: string | null;
  monikerPackage: string | null;
  monikerDescriptor: string | null;
  dispatchMethod: string | null;
  resolvedTargetId: string | null;
  resolvedTargetRepoName: string | null;
  filePath: string;
  startLine: number;
}

/**
 * Map an external-call row to {@link ExternalCallInfo}. Absent optional values are
 * OMITTED (conditional spread) rather than set to `undefined`, so a serialized
 * result carries no null-ish keys — the Ladybug backend's own mapper does the same.
 */
export function externalCallInfoFromRow(row: ExternalCallRow): ExternalCallInfo {
  return {
    id: row.id,
    callerId: row.callerId,
    callerName: row.callerName || 'unknown',
    callerFilePath: row.callerFilePath || '',
    serviceName: row.serviceName,
    ...(row.targetService ? { targetService: row.targetService } : {}),
    ...(row.sdkName ? { sdkName: row.sdkName } : {}),
    method: row.method,
    protocol: row.protocol as ExternalCallInfo['protocol'],
    ...(row.httpMethod ? { httpMethod: row.httpMethod } : {}),
    ...(row.pathTemplate ? { pathTemplate: row.pathTemplate } : {}),
    ...(row.messagingSystem ? { messagingSystem: row.messagingSystem } : {}),
    ...(row.messagingDestination ? { messagingDestination: row.messagingDestination } : {}),
    ...(row.messagingDestinationRef ? { messagingDestinationRef: row.messagingDestinationRef } : {}),
    ...(row.ipcDirection ? { ipcDirection: row.ipcDirection } : {}),
    ...(row.grpcService ? { grpcService: row.grpcService } : {}),
    ...(row.grpcMethod ? { grpcMethod: row.grpcMethod } : {}),
    ...(row.graphqlOperationType ? { graphqlOperationType: row.graphqlOperationType } : {}),
    ...(row.graphqlOperationName ? { graphqlOperationName: row.graphqlOperationName } : {}),
    ...(row.monikerPackage != null
      ? { moniker: { packageName: row.monikerPackage, descriptor: row.monikerDescriptor ?? '' } }
      : {}),
    ...(row.dispatchMethod ? { dispatchMethod: row.dispatchMethod } : {}),
    ...(row.resolvedTargetId ? { resolvedTargetId: row.resolvedTargetId } : {}),
    ...(row.resolvedTargetRepoName ? { resolvedTargetRepoName: row.resolvedTargetRepoName } : {}),
    filePath: row.filePath,
    startLine: row.startLine,
  };
}
