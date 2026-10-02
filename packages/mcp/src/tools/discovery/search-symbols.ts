/**
 * search_symbols Tool Handler
 *
 * Search for any named symbol by name or partial name.
 */

import { type IGraphReadRepository } from '@coredoc/db';
// NodeType enum (runtime value) — imported from @coredoc/core (the canonical
// source) rather than @coredoc/db so it survives `vi.mock('@coredoc/db')` in tests.
import { NodeType, normalizePath } from '@coredoc/core';
import { allowSourcesInGraph } from '@coredoc/core/utils';
import { formatCodeElementList, createMetadata } from '../../response-formatter.js';
import { crossRepoLookupHashes } from '../../scope-resolver.js';
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
import { dedupeByKinds } from '../../dedupe-kinds.js';
import { HTTP_METHOD_ALTERNATION } from '../../http-method.js';

// A query "looks like an HTTP path" when it starts with `/` or contains a
// substring that has the path-template shape (slashes between segments). The
// regex tolerates leading method verbs ("POST /foo") and placeholders.
function looksLikeHttpPath(query: string): boolean {
  const q = query.trim();
  if (q.startsWith('/')) return true;
  return /^[A-Z]{3,7}\s+\//.test(q) || /\/[a-zA-Z][\w-]*\/[a-zA-Z{]/.test(q);
}

// Strip the method prefix, then the linker's own normalizer (`@coredoc/core`
// `normalizePath`) so placeholder spellings (`{x}` / `${x}` / `:x`) agree with
// the RESOLVES_TO edges. Lowercased on top to tolerate agent-side spelling.
function normalizeHttpPath(p: string): string {
  return normalizePath(p.replace(new RegExp(`^(?:${HTTP_METHOD_ALTERNATION})\\s+`, 'i'), '')).toLowerCase();
}

/**
 * Handle search_symbols tool
 */
export async function handleSearchSymbols(
  args: Record<string, unknown>,
  scope: ScopeContext,
  format: OutputFormat,
  detailLevel: DetailLevel,
  detailConfig: DetailLevelConfig,
  repository: IGraphReadRepository,
): Promise<McpResponse<CodeElementInfo[] | string>> {
  const query = args.query as string;
  const type = (args.type as CodeElementType) || 'all';
  const limit = Math.floor(Number(args.limit)) || 20;
  const skip = Math.floor(Number(args.skip)) || 0;
  // Source is opt-in AND only available when the operator enabled the capability.
  const includeSource = args.includeSource === true && allowSourcesInGraph();
  // `exact` + `path` turn search_symbols into a precise resolver: given a known
  // name (and optionally the file it lives in), pin down the single canonical
  // node and its owning repo, instead of scanning a fuzzy ranked list and hand-
  // matching the row whose path equals the claim. `exact` requires the declared
  // name to equal `query` (case-insensitive); `path` keeps only nodes whose
  // filePath equals or ends with the given path segment.
  const exact = args.exact === true;
  const pathFilter = ((args.path as string | undefined) ?? '').trim();

  // Map CodeElementType to NodeType[]. 'interface' deliberately also includes
  // type_alias: the two are interchangeable in many TS APIs and callers asking
  // for "interface FooConfig" usually accept the type-alias form. Use
  // type='type_alias' explicitly to scope to aliases only.
  //
  // 'all' covers user-visible declarations agents typically ask about. We
  // include `state_store` (Kea-style logics like `userLogic`, `featureFlagLogic`)
  // and `variable` (filtered to exported only — see `exportedVariablesOnly`
  // below) because legit identifiers like `cohortsLogic`, `cohortsModel`,
  // `featureFlagsApi` are stored as state_store/variable and would otherwise
  // be unreachable. Explicit `type='variable'` preserves the opt-in escape
  // hatch with no export filter, for callers who really want internal const helpers.
  const typeMap: Record<CodeElementType, NodeType[]> = {
    file: [NodeType.File],
    function: [NodeType.Function],
    class: [NodeType.Class],
    interface: [NodeType.Interface, NodeType.TypeAlias],
    type_alias: [NodeType.TypeAlias],
    enum: [NodeType.Enum],
    entrypoint: [NodeType.Entrypoint],
    entity: [NodeType.Entity],
    component: [NodeType.Component],
    route: [NodeType.Route],
    variable: [NodeType.Variable],
    state_store: [NodeType.StateStore],
    all: [
      NodeType.Function,
      NodeType.Class,
      NodeType.Interface,
      NodeType.TypeAlias,
      NodeType.Enum,
      NodeType.Entrypoint,
      NodeType.Entity,
      NodeType.Component,
      NodeType.Route,
      NodeType.StateStore,
      NodeType.Variable,
    ],
  };

  const types = typeMap[type] || typeMap.all;
  // Filter variables to exported only when reached via the broad 'all' set.
  // Explicit `type='variable'` keeps the unfiltered opt-in behavior.
  const exportedVariablesOnly = type !== 'variable';

  // Fetch enough rows to cover skip + limit
  const fetchLimit = skip + limit;

  debug('findCode', `query="${query}", type=${type}, limit=${limit}, skip=${skip}`);

  // Build a forgiving LIKE pattern. Three modes:
  //   1. Explicit wildcards (`*` or `?`) → pass through; findCode translates
  //      to SQL `%` / `_`. Preserves expert usage.
  //   2. Whitespace in the query → tokenize. Use the longest token as the
  //      broad LIKE filter (most selective single substring), then post-
  //      filter results so every name contains EVERY token (case-insensitive).
  //      Handles "AnalyzeApplyTemplate Dto" or "analyzeConflicts apply
  //      template" — agents naturally type multi-word queries.
  //   3. Single bare word → wrap in `*word*` (substring on both sides). Recovers
  //      partial-name guesses like `AnalyzeApplyTemplateDto` matching
  //      `AnalyzeApplyTemplateRequestDto`.
  const tokens = query.includes('*') || query.includes('?') ? null : query.trim().split(/\s+/).filter(Boolean);
  let findCodePattern: string;
  if (!tokens) {
    findCodePattern = query;
  } else if (tokens.length === 1) {
    findCodePattern = `*${tokens[0]}*`;
  } else {
    // Longest token = most selective substring filter; the rest get applied as
    // a name-contains check below to enforce AND-across-tokens semantics.
    const longest = [...tokens].sort((a, b) => b.length - a.length)[0]!;
    findCodePattern = `*${longest}*`;
  }
  // Multi-token queries may need a larger pre-filter pool since the post-
  // filter discards rows that lack one of the other tokens.
  const dbFetchLimit = tokens && tokens.length > 1 ? Math.max(fetchLimit * 4, 50) : fetchLimit;

  const applyTokenFilter = (rows: typeof rawResults) =>
    tokens && tokens.length > 1
      ? rows.filter((r) => {
          const lower = r.name.toLowerCase();
          return tokens.every((t) => lower.includes(t.toLowerCase()));
        })
      : rows;

  const rawResults = await repository.findCode(
    { pattern: findCodePattern, types, limit: dbFetchLimit, exportedVariablesOnly, includeSource },
    scope.repoHashes,
  );
  const results = dedupeStateStoreOverVariable(applyTokenFilter(rawResults));

  // Honor the requested type even when empty. An agent may deliberately be
  // checking entrypoints; other kinds are not matches for that question.
  debugResult('findCode', results.length);

  // Map to CodeElementInfo format
  const codeElements: CodeElementInfo[] = results.map((r) => ({
    id: r.id,
    name: r.name,
    filePath: r.filePath,
    startLine: r.startLine,
    endLine: r.endLine,
    type: mapNodeTypeToElementType(r.type),
    summary: r.summary,
    purpose: r.purpose,
    sourceCode: r.sourceCode,
  }));

  // HTTP path queries → also surface the callers of any external_call whose
  // pathTemplate matches the query. findCode searches symbol names only, so
  // paths like `/v1/users/{id}` would never match a symbol name on their own.
  if ((type === 'all' || type === 'function') && looksLikeHttpPath(query)) {
    const externalCalls = await repository.getExternalCalls(scope.repoHashes);
    const normalizedQuery = normalizeHttpPath(query);
    const seenIds = new Set(codeElements.map((c) => c.id));
    for (const c of externalCalls) {
      if (c.protocol !== 'http' || !c.pathTemplate) continue;
      const np = normalizeHttpPath(c.pathTemplate);
      if (!(np === normalizedQuery || np.includes(normalizedQuery) || normalizedQuery.includes(np))) continue;
      if (seenIds.has(c.callerId)) continue;
      seenIds.add(c.callerId);
      codeElements.push({
        id: c.callerId,
        name: c.callerName,
        filePath: c.callerFilePath,
        startLine: c.startLine,
        endLine: c.startLine,
        type: 'function',
        summary: `Issues ${c.httpMethod || 'HTTP'} ${c.pathTemplate} to ${c.serviceName}`,
      });
    }
    debugResult('externalCallsByPath', codeElements.length);
  }

  // Collapse parser-emitted duplicate rows (function+component, class+entity at
  // the same name+file+line) to one winner BEFORE the resolver filters, sort, and
  // pagination count, so the duplication never inflates results or wastes tokens.
  // Runs after the external-call rows are appended so those are deduped too.
  // Resolver-mode narrowing. `exact` drops every substring/fuzzy near-miss so
  // only the literal name survives; `path` disambiguates collision-heavy names
  // (e.g. `createTemplate` in six repos) down to the one in the claimed file.
  // Both are post-filters so they constrain symbol AND external-call rows.
  let resolvedCodeElements = dedupeParserDuplicates(codeElements);
  if (exact) {
    const lowerQuery = query.trim().toLowerCase();
    resolvedCodeElements = resolvedCodeElements.filter((c) => c.name.toLowerCase() === lowerQuery);
  }
  if (pathFilter) {
    resolvedCodeElements = resolvedCodeElements.filter(
      (c) => c.filePath === pathFilter || c.filePath.endsWith(`/${pathFilter}`),
    );
  }

  // Sort by relevance (exact match first, then vantage repo, then by name).
  // The vantage tier (COREDOC_CURRENT_REPO) is a tiebreak AMONG equally-relevant
  // matches — it never outranks a better name match — so a symbol that exists in
  // several repos surfaces the one the agent is standing in before its cross-repo
  // twins, without burying an exact match in another repo. No vantage → the
  // original relevance+name ordering is preserved exactly.
  const vantagePrefix = scope.currentRepoHash ? `${scope.currentRepoHash}:` : undefined;
  resolvedCodeElements.sort((a, b) => {
    const aExact = a.name.toLowerCase() === query.toLowerCase() ? 0 : 1;
    const bExact = b.name.toLowerCase() === query.toLowerCase() ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    if (vantagePrefix) {
      const aVantage = a.id.startsWith(vantagePrefix) ? 0 : 1;
      const bVantage = b.id.startsWith(vantagePrefix) ? 0 : 1;
      if (aVantage !== bVantage) return aVantage - bVantage;
    }
    return a.name.localeCompare(b.name);
  });

  // Track total before pagination for metadata
  const totalBeforePagination = resolvedCodeElements.length;

  // Apply pagination
  const paginatedElements = resolvedCodeElements.slice(skip, skip + limit);

  // Filter results based on detail level (use default 'full' config if not provided)
  const config = detailConfig || resolveDetailLevel('full');
  const filteredResults = filterCodeElementArray(paginatedElements, config) as CodeElementInfo[];

  // Attach source AFTER the detail filter so includeSource works regardless of
  // level; only present when ALLOW_SOURCES_IN_GRAPH stored it and the caller asked.
  if (includeSource) {
    const sourceById = new Map(paginatedElements.map((e) => [e.id, e.sourceCode]));
    for (const el of filteredResults) {
      const src = sourceById.get(el.id);
      if (src) el.sourceCode = src;
    }
  }

  const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);
  let title = `Search results for "${query}"`;
  if (totalBeforePagination === 0) {
    metadata.warnings = [
      'No indexed symbol matches this query; this does not prove code absence. Raw literals (query parameters, headers, env keys, log messages, topic names) are not searched as source text. Verify with targeted source search.',
      ...(type !== 'all'
        ? [`The type=${type} filter was preserved. Search with type="all" separately to look for other symbol kinds.`]
        : []),
    ];
  }
  if (totalBeforePagination === 0 && tokens && tokens.length > 1) {
    title += ' — no declared symbol contains all words; search one symbol-name concept at a time';
  }
  // `type='all'` deliberately excludes top-level variables/constants (they can
  // be ~5x more numerous than functions). On a zero-result 'all' search, only
  // nudge toward type='variable' when a matching variable/const ACTUALLY exists —
  // probe the variable kind directly (unfiltered, mirroring an explicit
  // type='variable'). A wrong-name zero gets no useless "retry" suggestion.
  if (totalBeforePagination === 0 && type === 'all' && !exact && !pathFilter) {
    const variableProbe = await repository.findCode(
      { pattern: findCodePattern, types: typeMap.variable, limit: 5, exportedVariablesOnly: false },
      scope.repoHashes,
    );
    const probeMatches = applyTokenFilter(variableProbe);
    if (probeMatches.length > 0) {
      const n = probeMatches.length;
      title += ` — note: ${n}${n >= 5 ? '+' : ''} top-level variable/const match(es) exist (excluded from type='all'); retry with type='variable'`;
    }
  }
  // Resolver-mode narrowing zeroed out a non-empty match set: the name exists
  // but not exactly / not at that path. Surface what the pre-filter found so
  // the agent can correct `exact`/`path` instead of concluding "absent".
  if (totalBeforePagination === 0 && (exact || pathFilter) && codeElements.length > 0) {
    const sample = codeElements
      .slice(0, 5)
      .map((c) => `${c.name} (${c.filePath})`)
      .join(', ');
    const narrowed = [exact ? 'exact name' : null, pathFilter ? `path="${pathFilter}"` : null]
      .filter(Boolean)
      .join(' + ');
    title += ` — no match after ${narrowed} narrowing; ${codeElements.length} looser match(es): ${sample}`;
  }
  // A scoped miss for a symbol that DOES exist elsewhere in the graph is the
  // single most misread response this tool produces: an agent reads "not found"
  // as "absent from the codebase" and starts writing the type it is importing
  // (`PaidOvertTimePhasesTypes` lives in the shared API-client package, which a
  // service-scoped search legitimately cannot see). The data is one query away,
  // so name the repos instead of stopping at zero.
  if (totalBeforePagination === 0) {
    const lowerQuery = query.trim().toLowerCase();
    const requiredTokens = tokens && tokens.length > 1 ? tokens.map((t) => t.toLowerCase()) : null;
    const acceptName = (name: string): boolean => {
      const lower = name.toLowerCase();
      if (requiredTokens && !requiredTokens.every((t) => lower.includes(t))) return false;
      return !exact || lower === lowerQuery;
    };
    const elsewhere = await findRepositoriesDeclaring(
      repository,
      scope,
      { pattern: findCodePattern, types, exportedVariablesOnly },
      acceptName,
    );
    if (elsewhere.length > 0) {
      title +=
        ` — 0 in this scope, but the name is declared in: ${elsewhere.join(', ')}` +
        ` (retry with scope="${elsewhere[0]}", or treat it as an external import here)`;
    }
  }
  return formatCodeElementList(filteredResults, title, metadata, totalBeforePagination, skip);
}

/**
 * How many out-of-scope rows the "declared elsewhere" probe pulls. Enough to
 * cover several repos without paying for a fleet-wide listing on a typo.
 */
const OUT_OF_SCOPE_PROBE_LIMIT = 25;

/**
 * Repo names OUTSIDE the current scope that declare a matching symbol, sorted
 * and deduped. Empty when the scope is already the whole graph (nothing to
 * widen to) or when the scope is a hard boundary — a cloud workspace scope
 * enumerates the connected repos and must not report rows beyond them.
 */
async function findRepositoriesDeclaring(
  repo: IGraphReadRepository,
  scope: ScopeContext,
  params: { pattern: string; types: NodeType[]; exportedVariablesOnly: boolean },
  acceptName: (name: string) => boolean,
): Promise<string[]> {
  if (scope.repoHashes.length === 0) return [];
  if (crossRepoLookupHashes(scope).length !== 0) return [];

  const rows = await repo.findCode({ ...params, limit: OUT_OF_SCOPE_PROBE_LIMIT }, []);
  const inScope = new Set(scope.repoHashes);
  const hashes = new Set<string>();
  for (const row of rows) {
    if (!acceptName(row.name)) continue;
    const hash = row.id.split(':')[0];
    if (hash && !inScope.has(hash)) hashes.add(hash);
  }
  if (hashes.size === 0) return [];

  const names = await repo.getRepositoryNames([...hashes]);
  return [...new Set(names.map((row) => row.name).filter(Boolean))].sort();
}

/** Map NodeType to CodeElementType, with a legacy function fallback for unsupported kinds. */
function mapNodeTypeToElementType(nodeType: NodeType): CodeElementType {
  const map: Record<string, CodeElementType> = {
    file: 'file',
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
  return map[nodeType] || 'function';
}

// Collapse the substrate's multi-kind duplicate rows (class+entity for an ORM
// model, function+component for a React FC, at the SAME name+file+startLine) to
// one winner — noise that otherwise inflates the result/pagination count and
// burns tokens. Record every collapsed kind on `kinds` (only when >1) so the
// agent still sees the dual nature and knows both follow-up tools apply. The
// winner rule lives in dedupeByKinds, shared with `explain` so the two tools
// never disagree. Distinct same-named symbols are NOT merged (different file or
// line → different bucket).
function dedupeParserDuplicates(rows: CodeElementInfo[]): CodeElementInfo[] {
  return dedupeByKinds(rows).map(({ element, kinds }) => (kinds.length > 1 ? { ...element, kinds } : element));
}

// The parser emits Kea-style `kea({...})` declarations as BOTH a `state_store`
// (semantic) and a `variable` (raw decl) row with identical name+file. Returning
// both to the agent looks like noise and inflates pagination counts. Prefer the
// state_store row when (name, filePath) collides.
function dedupeStateStoreOverVariable<T extends { name: string; filePath: string; type: NodeType }>(rows: T[]): T[] {
  const stateStoreKeys = new Set<string>();
  for (const r of rows) {
    if (r.type === NodeType.StateStore) stateStoreKeys.add(`${r.name}|${r.filePath}`);
  }
  return rows.filter((r) => !(r.type === NodeType.Variable && stateStoreKeys.has(`${r.name}|${r.filePath}`)));
}
