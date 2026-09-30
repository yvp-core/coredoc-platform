/**
 * Review Manager - Handles graph review data extraction and parser approval.
 *
 * Uses stream-json for memory-efficient extraction of entrypoints, entities,
 * and externalCalls from potentially large parsed JSON files.
 */

import { IpcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import Parser from 'stream-json';
import Pick from 'stream-json/filters/Pick.js';
import StreamArray from 'stream-json/streamers/StreamArray.js';
import Chain from 'stream-chain';
import {
  IpcChannels,
  GraphReviewData,
  ReviewEntrypoint,
  ReviewEntity,
  ReviewExternalCall,
  ReviewStateStore,
  ReviewRoute,
  ApprovalStatus,
} from '../shared/ipc-types.js';
import { getCurrentConfig, getConfigDir } from './config-manager.js';
import { parserDir as parserDirHelper, parsedRepoFile } from '@coredoc/core/utils';
import { resolveParserArtifactPath } from './parser-artifact.js';

const { parser } = Parser;
const { pick } = Pick;
const { streamArray } = StreamArray;
const { chain } = Chain;

/**
 * Get the resolved output directory
 */
function getOutputDir(): string | null {
  const config = getCurrentConfig();
  const configDir = getConfigDir();
  if (!config || !configDir) return null;
  return path.resolve(configDir, config.output.dir);
}

/**
 * Get the resolved parser storage directory
 */
function getParserStorageDir(): string | null {
  const config = getCurrentConfig();
  const configDir = getConfigDir();
  if (!config || !configDir) return null;
  return path.resolve(configDir, config.parserStorage);
}

/**
 * Compute SHA256 hash of a file
 */
function hashFile(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Stream a single top-level array from a parsed JSON file, mapping each element
 * via the provided transform function.
 */
function streamArray_<T>(
  jsonPath: string,
  arrayKey: string,
  transform: (value: Record<string, unknown>) => T,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const items: T[] = [];
    const pipeline = chain([fs.createReadStream(jsonPath), parser(), pick({ filter: arrayKey }), streamArray()]);

    pipeline.on('data', ({ value }: { value: Record<string, unknown> }) => {
      items.push(transform(value));
    });
    pipeline.on('end', () => resolve(items));
    pipeline.on('error', reject);
  });
}

/** Helper: format SourceLocation as "filePath:startLine" */
function fmtLoc(loc: Record<string, unknown> | undefined): string {
  if (!loc) return '';
  return `${loc.filePath ?? ''}:${loc.startLine ?? ''}`;
}

function transformEntrypoint(raw: Record<string, unknown>): ReviewEntrypoint {
  const details = raw.details as Record<string, unknown> | undefined;
  const loc = raw.location as Record<string, unknown> | undefined;
  const type = (details?.type as string) ?? (raw.type as string) ?? '';

  const base: ReviewEntrypoint = { id: (raw.id as string) ?? '', location: fmtLoc(loc), type };

  switch (type) {
    case 'http':
      base.method = (details?.method as string) ?? '';
      base.fullPath = (details?.fullPath as string) ?? (details?.path as string) ?? '';
      break;
    case 'queue':
      base.system = (details?.system as string) ?? '';
      base.topic = (details?.topic as string) ?? '';
      base.pattern = (details?.pattern as string) ?? '';
      break;
    case 'graphql':
      base.operationType = (details?.operationType as string) ?? '';
      base.fieldName = (details?.fieldName as string) ?? '';
      base.parentType = (details?.parentType as string) ?? '';
      break;
    case 'grpc':
      base.serviceName = (details?.serviceName as string) ?? '';
      base.methodName = (details?.methodName as string) ?? '';
      base.streaming = (details?.streaming as string) ?? '';
      break;
    case 'websocket':
      base.event = (details?.event as string) ?? '';
      base.namespace = (details?.namespace as string) ?? '';
      break;
    case 'cron':
      base.schedule = (details?.schedule as string) ?? '';
      break;
    case 'event':
      base.eventName = (details?.eventName as string) ?? '';
      break;
    case 'cli':
      base.command = (details?.command as string) ?? '';
      break;
  }
  return base;
}

function transformEntity(raw: Record<string, unknown>): ReviewEntity {
  const loc = raw.location as Record<string, unknown> | undefined;
  const rawFields = (raw.fields as Record<string, unknown>[] | undefined) ?? [];
  const rawRels = (raw.relations as Record<string, unknown>[] | undefined) ?? [];
  return {
    id: (raw.id as string) ?? '',
    name: (raw.name as string) ?? '',
    location: fmtLoc(loc),
    ormType: (raw.ormType as string) ?? '',
    tableName: (raw.tableName as string) ?? '',
    fields: rawFields.map((f) => ({
      name: (f.name as string) ?? '',
      columnName: (f.columnName as string) ?? '',
      type: ((f.type as Record<string, unknown>)?.text as string) ?? '',
      isPrimaryKey: (f.isPrimaryKey as boolean) ?? false,
    })),
    relations: rawRels.map((r) => ({
      name: (r.name as string) ?? '',
      type: (r.type as string) ?? '',
      targetEntityName: (r.targetEntityName as string) ?? '',
    })),
  };
}

function transformExternalCall(raw: Record<string, unknown>): ReviewExternalCall {
  const loc = raw.location as Record<string, unknown> | undefined;
  const td = raw.targetDescriptor as Record<string, unknown> | undefined;
  return {
    id: (raw.id as string) ?? '',
    serviceName: (raw.serviceName as string) ?? '',
    method: (raw.method as string) ?? '',
    location: fmtLoc(loc),
    targetDescriptor: td
      ? {
          protocol: (td.protocol as string) ?? '',
          http: td.http as ReviewExternalCall['targetDescriptor'] extends undefined
            ? never
            : NonNullable<NonNullable<ReviewExternalCall['targetDescriptor']>['http']> | undefined,
          messaging: td.messaging as ReviewExternalCall['targetDescriptor'] extends undefined
            ? never
            : NonNullable<NonNullable<ReviewExternalCall['targetDescriptor']>['messaging']> | undefined,
          grpc: td.grpc as ReviewExternalCall['targetDescriptor'] extends undefined
            ? never
            : NonNullable<NonNullable<ReviewExternalCall['targetDescriptor']>['grpc']> | undefined,
          graphql: td.graphql as ReviewExternalCall['targetDescriptor'] extends undefined
            ? never
            : NonNullable<NonNullable<ReviewExternalCall['targetDescriptor']>['graphql']> | undefined,
          targetService: (td.targetService as string) ?? undefined,
        }
      : undefined,
  };
}

function transformStateStore(raw: Record<string, unknown>): ReviewStateStore {
  const loc = raw.location as Record<string, unknown> | undefined;
  return {
    id: (raw.id as string) ?? '',
    name: (raw.storeName as string) ?? (raw.name as string) ?? '',
    library: (raw.library as string) ?? '',
    location: fmtLoc(loc),
  };
}

function transformRoute(raw: Record<string, unknown>): ReviewRoute {
  const loc = raw.location as Record<string, unknown> | undefined;
  return {
    id: (raw.id as string) ?? '',
    path: (raw.path as string) ?? '',
    componentName: (raw.componentName as string) ?? '',
    location: fmtLoc(loc),
  };
}

/**
 * Extract graph review data from parsed JSON using stream-json.
 * Streams each array in parallel without loading the full file into memory.
 */
export async function getGraphReviewData(projectId: string, repoName: string): Promise<GraphReviewData | null> {
  const outputDir = getOutputDir();
  if (!outputDir) return null;

  const parsedPath = parsedRepoFile(outputDir, projectId, repoName);
  if (!fs.existsSync(parsedPath)) return null;

  try {
    const [entrypoints, entities, externalCalls, stateStores, routes] = await Promise.all([
      streamArray_<ReviewEntrypoint>(parsedPath, 'entrypoints', transformEntrypoint),
      streamArray_<ReviewEntity>(parsedPath, 'entities', transformEntity),
      streamArray_<ReviewExternalCall>(parsedPath, 'externalCalls', transformExternalCall),
      streamArray_<ReviewStateStore>(parsedPath, 'stateStores', transformStateStore),
      streamArray_<ReviewRoute>(parsedPath, 'routes', transformRoute),
    ]);

    return { entrypoints, entities, externalCalls, stateStores, routes };
  } catch {
    return null;
  }
}

/**
 * Stream a single top-level scalar field from a parsed JSON file.
 * Reads only until the field is found, then destroys the stream.
 */
function streamScalarField(jsonPath: string, fieldName: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const pipeline = chain([fs.createReadStream(jsonPath), parser(), pick({ filter: fieldName })]);

    let resolved = false;
    pipeline.on('data', (token: { name: string; value: unknown }) => {
      if (!resolved && token.name === 'stringValue') {
        resolved = true;
        resolve(token.value as string);
        pipeline.destroy();
      }
    });
    pipeline.on('end', () => {
      if (!resolved) resolve(undefined);
    });
    pipeline.on('error', (err) => {
      // stream destroy triggers ERR_STREAM_PREMATURE_CLOSE — ignore it
      if (!resolved) reject(err);
    });
  });
}

/**
 * Get current approval status for a repo by comparing parser hashes.
 */
export function getApprovalStatus(projectId: string, repoName: string): Promise<ApprovalStatus | null>;
export function getApprovalStatus(
  projectId: string,
  repoName: string,
  verifyOutput: false,
): Promise<Omit<ApprovalStatus, 'outputMatchesParser'> | null>;
export async function getApprovalStatus(
  projectId: string,
  repoName: string,
  verifyOutput = true,
): Promise<Omit<ApprovalStatus, 'outputMatchesParser'> | null> {
  const parserStorage = getParserStorageDir();
  const outputDir = getOutputDir();
  if (!parserStorage || !outputDir) return null;

  const repoParserDir = parserDirHelper(parserStorage, projectId, repoName);
  const artifactPath = resolveParserArtifactPath(parserStorage, projectId, repoName);
  const metadataPath = path.join(repoParserDir, 'metadata.json');
  const parsedPath = parsedRepoFile(outputDir, projectId, repoName);

  // Current parser artifact hash (profile.ts preferred, legacy parser.ts fallback)
  const currentParserHash = artifactPath ? hashFile(artifactPath) : null;
  if (!currentParserHash) {
    return { approved: false, isStale: false, ...(verifyOutput ? { outputMatchesParser: false } : {}) };
  }

  // Check if output was produced by the current parser (stream — avoids full parse)
  let outputMatchesParser = false;
  try {
    if (verifyOutput && fs.existsSync(parsedPath)) {
      const hashFromOutput = await streamScalarField(parsedPath, 'parserHashAtParse');
      outputMatchesParser = hashFromOutput === currentParserHash;
    }
  } catch {
    // Ignore — outputMatchesParser stays false
  }
  // The workspace list needs approval metadata only. Omitting this field keeps
  // an unperformed output verification distinct from a verified mismatch.
  const outputStatus = verifyOutput ? { outputMatchesParser } : {};

  // Read metadata for approval info (metadata.json is tiny — full read is fine)
  try {
    if (!fs.existsSync(metadataPath)) {
      return { approved: false, isStale: false, ...outputStatus };
    }

    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    const approval = metadata.approval;

    if (!approval?.approvedParserHash) {
      return { approved: false, isStale: false, ...outputStatus };
    }

    const isStale = approval.approvedParserHash !== currentParserHash;

    return {
      approved: true,
      approvedAt: approval.approvedAt,
      approvedParserHash: approval.approvedParserHash,
      isStale,
      ...outputStatus,
    };
  } catch {
    return { approved: false, isStale: false, ...outputStatus };
  }
}

/**
 * Approve the parser for a repo. Verifies parserHashAtParse matches current parser.ts,
 * then writes approval to metadata.json atomically.
 */
export async function approveParser(
  projectId: string,
  repoName: string,
): Promise<{ success: boolean; error?: string }> {
  const parserStorage = getParserStorageDir();
  const outputDir = getOutputDir();
  if (!parserStorage || !outputDir) {
    return { success: false, error: 'Config not loaded' };
  }

  const repoParserDir = parserDirHelper(parserStorage, projectId, repoName);
  const artifactPath = resolveParserArtifactPath(parserStorage, projectId, repoName);
  const metadataPath = path.join(repoParserDir, 'metadata.json');
  const parsedPath = parsedRepoFile(outputDir, projectId, repoName);

  // Current parser artifact hash (profile.ts preferred, legacy parser.ts fallback)
  const currentParserHash = artifactPath ? hashFile(artifactPath) : null;
  if (!currentParserHash) {
    return { success: false, error: 'Parser file not found' };
  }

  // Verify output was produced by current parser (stream — avoids full parse)
  try {
    const hashFromOutput = await streamScalarField(parsedPath, 'parserHashAtParse');
    if (hashFromOutput !== currentParserHash) {
      return {
        success: false,
        error: 'Output was produced by a different parser version. Please re-parse first.',
      };
    }
  } catch {
    return { success: false, error: 'Parsed output not found' };
  }

  // Read existing metadata or create minimal structure
  let metadata: Record<string, unknown> = {};
  try {
    if (fs.existsSync(metadataPath)) {
      metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    }
  } catch {
    // Start fresh if metadata is invalid
  }

  // Set approval
  metadata.approval = {
    approvedAt: new Date().toISOString(),
    approvedParserHash: currentParserHash,
  };

  // Atomic write: write to tmp then rename
  const tmpPath = `${metadataPath}.tmp`;
  try {
    await fs.promises.writeFile(tmpPath, JSON.stringify(metadata, null, 2));
    fs.renameSync(tmpPath, metadataPath);
    return { success: true };
  } catch (err) {
    // Clean up tmp file on failure
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    return { success: false, error: `Failed to write metadata: ${err}` };
  }
}

/**
 * Register IPC handlers for review operations
 */
export function registerReviewHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IpcChannels.REVIEW_GET_GRAPH_DATA, async (_event, projectId: string, repoName: string) => {
    const data = await getGraphReviewData(projectId, repoName);
    if (data) {
      return { success: true, data };
    }
    return { success: false, error: 'Failed to load graph data' };
  });

  ipcMain.handle(IpcChannels.REVIEW_APPROVE, async (_event, projectId: string, repoName: string) => {
    return approveParser(projectId, repoName);
  });

  ipcMain.handle(IpcChannels.REVIEW_GET_APPROVAL, async (_event, projectId: string, repoName: string) => {
    const status = await getApprovalStatus(projectId, repoName);
    if (status) {
      return { success: true, status };
    }
    return { success: false, error: 'Failed to get approval status' };
  });
}
