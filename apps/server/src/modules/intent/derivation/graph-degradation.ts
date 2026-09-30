/**
 * Graph-unavailability vocabulary (spec §6.3).
 *
 * Graph unavailability is DEGRADATION, never an error and never silent: the
 * read still returns intent, attachment-based applicability still works,
 * anchor-derived applicability is empty, and the response says so with a code
 * and a remediation the caller can act on.
 *
 * The code→remediation tables are salvaged from the archived branch
 * (`archive/intent-cloud-first-v1`, `intent-authority.service.ts`), where they
 * were proven against the same two failure sources they map here: the context
 * resolver's own refusals and the file cache's typed failures.
 */

import {
  WorkspaceFileCacheError,
  type WorkspaceFileCacheErrorCode,
} from '../../../database/workspace-file-cache.service.js';
import {
  WorkspaceGraphContextError,
  type WorkspaceGraphContextErrorCode,
} from '../../../mcp/workspace-mcp-context.service.js';
import { IntentGraphUnavailableCode } from './derivation-contract.js';

const CONTEXT_UNAVAILABLE: Record<WorkspaceGraphContextErrorCode, IntentGraphUnavailableCode> = {
  WORKSPACE_NOT_FOUND: IntentGraphUnavailableCode.WorkspaceNotFound,
  DATABASE_UNAVAILABLE: IntentGraphUnavailableCode.LegacyDatabaseUnavailable,
  ACTIVE_VERSION_MISSING: IntentGraphUnavailableCode.ActiveVersionMissing,
  VERSION_NOT_FOUND: IntentGraphUnavailableCode.VersionNotFound,
  UNSUPPORTED_BACKEND: IntentGraphUnavailableCode.UnsupportedBackend,
  UNSUPPORTED_ENGINE: IntentGraphUnavailableCode.UnsupportedEngine,
};

const CACHE_UNAVAILABLE: Record<WorkspaceFileCacheErrorCode, IntentGraphUnavailableCode> = {
  NOT_FOUND: IntentGraphUnavailableCode.GraphObjectMissing,
  DOWNLOAD_TIMEOUT: IntentGraphUnavailableCode.GraphDownloadTimeout,
  INTEGRITY: IntentGraphUnavailableCode.GraphIntegrityFailed,
  UNSUPPORTED_FORMAT: IntentGraphUnavailableCode.GraphFormatUnsupported,
  INVALID_STORAGE_KEY: IntentGraphUnavailableCode.GraphDescriptorInvalid,
  CACHE_CAPACITY: IntentGraphUnavailableCode.GraphCacheCapacity,
  OPEN_FAILED: IntentGraphUnavailableCode.GraphOpenFailed,
};

/**
 * What the reader should DO. Every entry names an action, not a condition — a
 * remediation that only restates the failure ("the snapshot is missing") gives
 * an agent nothing to try next.
 */
const GRAPH_REMEDIATION: Record<IntentGraphUnavailableCode, string> = {
  [IntentGraphUnavailableCode.WorkspaceNotFound]: 'Confirm the workspace still exists and retry the intent read.',
  [IntentGraphUnavailableCode.LegacyDatabaseUnavailable]:
    'Restore the legacy workspace graph or migrate it to a file snapshot, then retry.',
  [IntentGraphUnavailableCode.ActiveVersionMissing]:
    'Publish a graph snapshot for this workspace, then retry the intent read.',
  [IntentGraphUnavailableCode.VersionNotFound]:
    'Republish the workspace graph so its active version points to an available snapshot.',
  [IntentGraphUnavailableCode.UnsupportedBackend]:
    'Configure a supported workspace graph backend, then retry the intent read.',
  [IntentGraphUnavailableCode.UnsupportedEngine]:
    'Republish the workspace graph with the supported Ladybug engine, then retry.',
  [IntentGraphUnavailableCode.GraphObjectMissing]:
    'Republish the active workspace graph object, then retry the intent read.',
  [IntentGraphUnavailableCode.GraphDownloadTimeout]:
    'Retry the intent read; if it persists, check graph-object storage availability.',
  [IntentGraphUnavailableCode.GraphIntegrityFailed]:
    'Republish the active workspace graph from verified source artifacts, then retry.',
  [IntentGraphUnavailableCode.GraphFormatUnsupported]:
    'Upgrade Coredoc or republish the graph with the currently supported format.',
  [IntentGraphUnavailableCode.GraphDescriptorInvalid]:
    'Republish the workspace graph to replace its invalid storage descriptor.',
  [IntentGraphUnavailableCode.GraphCacheCapacity]:
    'Retry after active graph reads finish or increase the configured graph-cache capacity.',
  [IntentGraphUnavailableCode.GraphOpenFailed]:
    'Publish a fresh graph snapshot to this workspace (desktop Cloud sync, or `coredoc push <parsed.json> --remote --workspace-id <id>`), then retry the intent read.',
  [IntentGraphUnavailableCode.GraphQueryFailed]:
    'Retry the intent read; if it persists, inspect the active graph snapshot and server logs.',
  [IntentGraphUnavailableCode.BatchTraversalUnsupported]:
    'Migrate this workspace to a file-snapshot graph: the legacy backend cannot answer the batched traversals ' +
    'anchor-derived intent needs. Attached and inherited intent is unaffected.',
};

export function graphRemediation(code: IntentGraphUnavailableCode): string {
  return GRAPH_REMEDIATION[code];
}

/**
 * Map a thrown graph failure to a degradation code.
 *
 * Returns `undefined` for anything that is NOT a known graph-plane failure:
 * a bug in derivation must surface as a real error, not be laundered into a
 * cheerful "the graph is unavailable" that hides it forever.
 */
export function graphUnavailableCode(error: unknown): IntentGraphUnavailableCode | undefined {
  if (error instanceof WorkspaceGraphContextError) return CONTEXT_UNAVAILABLE[error.code];
  if (error instanceof WorkspaceFileCacheError) return CACHE_UNAVAILABLE[error.code];
  return undefined;
}

/**
 * The native error classes only a BUG produces.
 *
 * A graph backend reports its failures as its own error types or as plain
 * `Error`s; a `TypeError` ("cannot read properties of undefined"), a
 * `ReferenceError`, or a `RangeError` raised while a snapshot is open is this
 * module misusing its own data. Those must NOT be laundered into a §6.3
 * degradation: a caller told "the graph is unavailable, republish the snapshot"
 * would chase a healthy snapshot forever while the real defect stays invisible.
 */
const PROGRAMMING_ERROR_TYPES = [TypeError, ReferenceError, RangeError, SyntaxError, EvalError, URIError] as const;

export function isProgrammingError(error: unknown): boolean {
  return PROGRAMMING_ERROR_TYPES.some((kind) => error instanceof kind);
}
