/**
 * Per-route request-body size ceilings.
 *
 * The global body parsers allow up to LARGE_UPLOAD_LIMIT (needed by the
 * allow-listed upload routes), but that limit otherwise applies to EVERY route —
 * including unauthenticated ones like /api/v1/auth/*. `bodyLimitFor` lets the
 * bootstrap guard reject oversize requests from the Content-Length header before
 * the parser buffers them, capping each route appropriately.
 *
 * Matched against `req.url`, which includes the /api/v1 prefix at the Express layer.
 */

import { MAX_STATE_ARCHIVE_BYTES } from '@coredoc/core/agent-runner';

const OneMB = 1024 * 1024;

/** Default ceiling for ordinary JSON API requests (auth, tokens, members, …). */
export const DEFAULT_BODY_LIMIT = 1 * OneMB;
/**
 * Allow-listed large-payload routes, all behind AuthGuard + WorkspaceRoleGuard + PermissionsGuard.
 *
 * A stripped ParsedRepo for a ~30K-function repo exceeds 100 MiB, and the
 * server holds the whole artifact in memory anyway (R2 put here, JSON.parse
 * again on push). Ceiling is V8's max string length (~512 MiB): body-parser
 * does `buf.toString()` before JSON.parse, so anything above that cannot be
 * parsed at all. Clients gzip these bodies on the wire; this tier's parser
 * bounds the INFLATED size, so ordinary routes never inflate past their own
 * ceiling.
 */
export const LARGE_UPLOAD_LIMIT = 500 * OneMB;
/** Mapper PUT — capped well below the global ceiling. */
export const MAPPER_BODY_LIMIT = 3 * OneMB;
/** Canonical artifact revision PUT — allows JSON escaping around a bounded 1 MiB Markdown value. */
export const ARTIFACT_REVISION_BODY_LIMIT = 3 * OneMB;
/** OTLP ingest — a busy Claude Code log-export window can exceed 1MB. */
export const OTLP_BODY_LIMIT = 25 * OneMB;
/**
 * Intent workspace import — one whole `CloudIntentWorkspaceDocumentV1` plus its
 * envelope. Under DEFAULT_BODY_LIMIT a legal multi-megabyte document would be
 * rejected before the service ever saw it.
 */
export const INTENT_IMPORT_BODY_LIMIT = 6 * OneMB;

/**
 * Agent runner state archive PUT (SF-001): a raw gzip body, buffered for the
 * create-only object write. Its own tier, derived from the shared archive cap
 * plus headroom, so the service sees an over-cap archive and fails the run
 * with `archive_too_large` instead of a bare 413.
 */
export const AGENT_STATE_ARCHIVE_BODY_LIMIT = MAX_STATE_ARCHIVE_BYTES + OneMB;

// First match wins; unmatched routes get DEFAULT_BODY_LIMIT.
const BODY_LIMITS: ReadonlyArray<{ re: RegExp; limit: number; method?: string }> = [
  {
    re: /^\/api\/v1\/workspaces\/[^/]+\/agent-runner\/turns\/[^/]+\/archive\/?(?:\?.*)?$/,
    limit: AGENT_STATE_ARCHIVE_BODY_LIMIT,
    method: 'PUT',
  },
  {
    re: /^\/api\/v1\/workspaces\/[^/]+\/delivery\/v2\/artifacts\/[^/]+\/revisions\/?(?:\?.*)?$/,
    limit: ARTIFACT_REVISION_BODY_LIMIT,
    method: 'PUT',
  },
  // Parser-result / summary / embeddings uploads — large JSON payloads.
  {
    re: /^\/api\/v1\/workspaces\/[^/]+\/repos\/[^/]+\/(?:results|summaries|embeddings)\/upload(?:\/|$|\?)/,
    limit: LARGE_UPLOAD_LIMIT,
  },
  // Parser tarball upload (POST) — large binary payload read via @RawBody().
  { re: /^\/api\/v1\/workspaces\/[^/]+\/parsers\/[^/]+(?:\/|$|\?)/, limit: LARGE_UPLOAD_LIMIT },
  // Mapper PUT — capped well below the global ceiling.
  { re: /^\/api\/v1\/workspaces\/[^/]+\/mapper(?:\/|$|\?)/, limit: MAPPER_BODY_LIMIT },
  // OTLP ingest — a busy Claude Code log-export window can exceed 1MB; give it 25MB.
  { re: /^\/api\/v1\/workspaces\/[^/]+\/otel\/v1\/(?:metrics|logs)(?:\/|$|\?)/, limit: OTLP_BODY_LIMIT },
  // Intent workspace import (POST only) — one whole workspace document in one body.
  {
    re: /^\/api\/v1\/workspaces\/[^/]+\/intent\/import\/workspace\/?(?:\?.*)?$/,
    limit: INTENT_IMPORT_BODY_LIMIT,
    method: 'POST',
  },
];

/**
 * Every distinct ceiling, so bootstrap can mount one body parser per tier and
 * enforce that tier on the INFLATED bytes (the Content-Length guard only sees
 * the compressed size of a gzipped body).
 */
export const BODY_LIMIT_TIERS: readonly number[] = [
  ...new Set([DEFAULT_BODY_LIMIT, ...BODY_LIMITS.map((b) => b.limit)]),
];

export function bodyLimitFor(url: string, method?: string): number {
  for (const { re, limit, method: requiredMethod } of BODY_LIMITS) {
    if ((requiredMethod === undefined || requiredMethod === method) && re.test(url)) return limit;
  }
  return DEFAULT_BODY_LIMIT;
}
