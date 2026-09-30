/**
 * Backend-neutral VizNode construction — shared by BOTH the SQLite and Neo4j
 * repositories so the explorer badge/shape logic cannot drift between backends
 * (the parity risk that §3.2 of docs/web-ui-plan-2026-07.md calls the real
 * hidden cost of the graph module). Unlike `buildRepoFilter`, which is genuinely
 * SQL-vs-Cypher specific and duplicated per backend, this operates on already
 * extracted primitive fields, so one implementation is correct for both.
 */

import { EdgeType, NodeType } from '@coredoc/core';
import type { VizEdge, VizNode } from '@coredoc/core';

/**
 * The already-extracted, backend-neutral fields a VizNode is built from. Each
 * backend maps its own row shape (SQLite column aliases / Neo4j RETURN keys)
 * into this before calling {@link buildVizNode}.
 */
export interface VizNodeFields {
  id: string;
  /** Node type as the stored `NodeType` string value ('function', 'entrypoint', …). */
  type: string;
  name: string;
  repoName: string | null;
  filePath: string | null;
  startLine: number | null;
  summary: string | null;
  /** entrypoint `method` property (badge source). */
  pMethod: unknown;
  /** entrypoint `entrypointType` property (badge fallback). */
  pEntrypointType: unknown;
  /** external_call `protocol` property (badge source). */
  pProtocol: unknown;
}

/**
 * The short presentational chip on a VizNode — purely type-specific and derived,
 * never stored. Entrypoints badge their HTTP method (falling back to the
 * entrypoint type); external calls badge their protocol. Everything else reads
 * fine from name + type alone, so it gets no badge.
 */
function badgeForVizNode(
  type: string,
  pMethod: unknown,
  pEntrypointType: unknown,
  pProtocol: unknown,
): string | undefined {
  if (type === NodeType.Entrypoint) {
    if (typeof pMethod === 'string' && pMethod) return pMethod;
    if (typeof pEntrypointType === 'string' && pEntrypointType) return pEntrypointType;
    return undefined;
  }
  if (type === NodeType.ExternalCall) {
    return typeof pProtocol === 'string' && pProtocol ? pProtocol : undefined;
  }
  return undefined;
}

/** Build a {@link VizNode} from backend-neutral fields, omitting empty optionals. */
export function buildVizNode(f: VizNodeFields): VizNode {
  const node: VizNode = {
    id: f.id,
    type: f.type as VizNode['type'],
    name: f.name,
    repoName: f.repoName || '',
  };
  if (f.filePath) node.filePath = f.filePath;
  if (f.startLine != null) node.startLine = f.startLine;
  if (f.summary) node.summary = f.summary;
  const badge = badgeForVizNode(f.type, f.pMethod, f.pEntrypointType, f.pProtocol);
  if (badge) node.badge = badge;
  return node;
}

/**
 * The already-extracted, backend-neutral fields a VizEdge is built from. `confidence`
 * is coerced to a plain number at each backend's row boundary (Neo4j `Integer`,
 * Ladybug `bigint`, SQLite `REAL`).
 */
export interface VizEdgeFields {
  id: string;
  sourceId: string;
  targetId: string;
  type: EdgeType;
  confidence: number;
  createdBy: string;
  /** The OPERATES_ON edge's stored DB operation; ignored for every other edge kind. */
  operation?: string | null;
}

/**
 * Build a {@link VizEdge}, omitting an empty label. The ONE edge projection the three
 * backends share: the only label worth surfacing today is the DB operation on an
 * OPERATES_ON edge — other kinds read fine from their type alone.
 */
export function buildVizEdge(f: VizEdgeFields): VizEdge {
  return {
    id: f.id,
    sourceId: f.sourceId,
    targetId: f.targetId,
    type: f.type,
    confidence: f.confidence,
    createdBy: f.createdBy as VizEdge['createdBy'],
    ...(f.type === EdgeType.OperatesOn && f.operation ? { label: f.operation } : {}),
  };
}

/**
 * The keyset-pagination glue every paged read shares: the query asks for `limit + 1`
 * rows, so an extra row IS the observation that more exist. Returns the page, that
 * observation, and the cursor to resume from — `nextCursor` present only on a
 * truncated page whose last row has one, never as an undefined-valued key.
 */
export function pageSlice<T>(
  rows: readonly T[],
  limit: number,
  cursorOf?: (row: T) => string | undefined,
): { page: T[]; truncated: boolean; nextCursor?: string } {
  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : [...rows];
  const last = page[page.length - 1];
  const cursor = truncated && cursorOf && last !== undefined ? cursorOf(last) : undefined;
  return { page, truncated, ...(cursor ? { nextCursor: cursor } : {}) };
}
