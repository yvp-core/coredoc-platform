/**
 * list_file_symbols Tool Handler
 *
 * List every named symbol declared in a single file, ordered by line. Answers
 * "what's in this file?" in one call — the inverse of search_symbols (which
 * searches by name across files). Backed by the `listSymbolsInFile` DB query,
 * which matches the file by exact path or trailing segment.
 */

import { type IGraphReadRepository, type CodeElement, type NodeType } from '@coredoc/db';
import { formatCodeElementList, createMetadata } from '../../response-formatter.js';
import { debug, debugResult } from '../../debug-logger.js';
import type {
  ScopeContext,
  OutputFormat,
  McpResponse,
  CodeElementInfo,
  CodeElementType,
  DetailLevel,
  DetailLevelConfig,
} from '../../types.js';
import { filterCodeElementArray, resolveDetailLevel } from '../../detail-level.js';

// NodeType → CodeElementType for the user-visible named symbols. Node kinds
// absent here (e.g. `file`, `package`) are NOT symbols — they're container
// nodes the parser stores at the file root with no real start line. We drop
// them rather than mislabel them as `function`.
const NODE_TYPE_MAP: Record<string, CodeElementType> = {
  function: 'function',
  class: 'class',
  interface: 'interface',
  type_alias: 'type_alias',
  enum: 'enum',
  entrypoint: 'entrypoint',
  entity: 'entity',
  component: 'component',
  route: 'route',
  variable: 'variable',
  state_store: 'state_store',
};

function mapNodeType(type: NodeType): CodeElementType | null {
  return NODE_TYPE_MAP[type] ?? null;
}

// Collapse parser-emitted duplicates that share (name, startLine): a React FC is
// stored as both `function` and `component`, a TypeORM entity as both `class`
// and `entity`. Listing both at the same line is noise — keep the richer node.
const DEDUP_PRECEDENCE: Record<string, number> = {
  class: 0,
  function: 1,
  interface: 2,
  type_alias: 3,
  enum: 4,
  entity: 5,
  component: 6,
  route: 7,
  state_store: 8,
  variable: 9,
};

function dedupeByLocation(rows: CodeElement[]): CodeElement[] {
  const buckets = new Map<string, CodeElement[]>();
  for (const r of rows) {
    const key = `${r.name}|${r.startLine}`;
    const arr = buckets.get(key) ?? [];
    arr.push(r);
    buckets.set(key, arr);
  }
  const merged: CodeElement[] = [];
  for (const arr of buckets.values()) {
    if (arr.length === 1) {
      merged.push(arr[0]!);
      continue;
    }
    const sorted = [...arr].sort((a, b) => (DEDUP_PRECEDENCE[a.type] ?? 99) - (DEDUP_PRECEDENCE[b.type] ?? 99));
    merged.push(sorted[0]!);
  }
  return merged;
}

/**
 * Empty-result title. Three DIFFERENT facts hide behind "zero rows", and
 * collapsing them into "check the path" sent agents hunting a path that was
 * already correct (measured on supabase's `packages/pg-meta/src/index.ts`, a
 * re-export barrel that the parser records as a file with no declarations):
 *
 *   - no rows at all      → the file really isn't in the graph
 *   - rows, no symbols    → the file IS parsed and declares nothing
 *   - symbols, filtered   → the `type` filter removed them
 */
function emptyTitle(
  filePath: string,
  rowCount: number,
  symbolsBeforeTypeFilter: number,
  typeFilter: CodeElementType | undefined,
): string {
  if (rowCount === 0) {
    return `No symbols found in a file matching "${filePath}" — check the path (it matches exactly or by trailing segment) and scope.`;
  }
  if (symbolsBeforeTypeFilter > 0 && typeFilter) {
    return `"${filePath}" is parsed and has ${symbolsBeforeTypeFilter} symbol(s), but no \`${typeFilter}\` symbols. Drop the \`type\` filter to see them.`;
  }
  return `"${filePath}" is parsed but declares no symbols — it is a re-export barrel, a config module, or type-only. Follow its imports/exports in the source instead.`;
}

/**
 * Handle list_file_symbols tool.
 */
export async function handleListFileSymbols(
  args: Record<string, unknown>,
  scope: ScopeContext,
  format: OutputFormat,
  detailLevel: DetailLevel,
  detailConfig: DetailLevelConfig,
  repository: IGraphReadRepository,
): Promise<McpResponse<CodeElementInfo[] | string>> {
  const filePath = ((args.path as string | undefined) ?? '').trim();
  const typeFilter = args.type as CodeElementType | undefined;
  const limit = Math.floor(Number(args.limit)) || 200;
  const skip = Math.floor(Number(args.skip)) || 0;

  const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);

  if (!filePath) {
    return formatCodeElementList(
      [],
      'list_file_symbols requires a `path` — the file to list symbols from (full repo-relative path or its distinctive tail, e.g. "templates.service.ts").',
      metadata,
      0,
      0,
    );
  }

  debug('listSymbolsInFile', `path="${filePath}", scope=[${scope.repoHashes.join(',')}]`);
  const rows = await repository.listSymbolsInFile(filePath, scope.repoHashes);
  const deduped = dedupeByLocation(rows);
  debugResult('listSymbolsInFile', deduped.length);

  let codeElements: CodeElementInfo[] = deduped.flatMap((r) => {
    const type = mapNodeType(r.type);
    // Drop non-symbol container nodes (file/package) — see mapNodeType.
    if (type === null) return [];
    return [
      {
        id: r.id,
        name: r.name,
        filePath: r.filePath,
        startLine: r.startLine,
        endLine: r.endLine,
        type,
        summary: r.summary,
      },
    ];
  });

  const symbolsBeforeTypeFilter = codeElements.length;
  if (typeFilter && typeFilter !== ('all' as CodeElementType)) {
    codeElements = codeElements.filter((c) => c.type === typeFilter);
  }

  // Already ordered by start line from the DB; keep that ordering for pagination.
  const totalBeforePagination = codeElements.length;
  const paginated = codeElements.slice(skip, skip + limit);

  const config = detailConfig || resolveDetailLevel('full');
  const filtered = filterCodeElementArray(paginated, config) as CodeElementInfo[];

  const title =
    totalBeforePagination === 0
      ? emptyTitle(filePath, rows.length, symbolsBeforeTypeFilter, typeFilter)
      : `Symbols in ${filePath}`;

  return formatCodeElementList(filtered, title, metadata, totalBeforePagination, skip);
}
