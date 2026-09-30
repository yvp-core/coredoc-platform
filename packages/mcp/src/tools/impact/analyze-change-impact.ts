/**
 * analyze_change_impact Tool Handler
 *
 * Analyzes what code would be affected by changing a function, class, or file.
 */

import { type IGraphReadRepository, type EntrypointInfo as DbEntrypointInfo } from '@coredoc/db';
import { formatChangeImpact, createMetadata } from '../../response-formatter.js';
import { boundariesInFiles, appendBoundarySection } from '../../boundaries.js';
import { ZERO_RESULTS_MARKER } from '../../empty-results.js';
import { isTestFilePath } from '../../test-file.js';
import { debug, debugResult } from '../../debug-logger.js';
import type {
  ScopeContext,
  OutputFormat,
  McpResponse,
  ChangeImpactResult,
  CallerInfo,
  EntrypointInfo,
  CodeElementInfo,
  DetailLevel,
  DetailLevelConfig,
} from '../../types.js';
import {
  filterCallerArray,
  filterEntrypointArray,
  filterCodeElementArray,
  resolveDetailLevel,
} from '../../detail-level.js';
import {
  ambiguousFunctionNote,
  findEntityByName,
  findFunctionByName,
  findTypeByName,
  parseFunctionName,
} from '../../function-name.js';
import { typeUsageSummary } from '../../type-usage.js';
import { detectAmbiguity, toNodeTypes } from '../../ambiguity.js';
import type { CodeElementType } from '../../types.js';

// Map db NodeType → MCP CodeElementType for typeUsers output. CodeElementType
// covers all NodeType values today; the function/class/interface entries also
// pull double duty as the fallback when a NodeType arrives that isn't in this
// map (returns `function` via the `|| 'function'` lookup at call sites).
const NODE_TYPE_TO_ELEMENT_TYPE: Record<string, CodeElementType> = {
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

// Symbol names (function/class/interface/type alias/enum/entity, optionally
// `Class.method`-qualified) never contain a path separator, and never end in
// a source-file extension — a file path always does one or the other. This
// tool answers "what breaks if THIS DECLARATION changes"; it has no query
// that aggregates impact across every symbol in a file, so a file-path
// target is rejected early (fail-fast) instead of silently resolving to
// nothing and burying a "not found" deep inside a rendered response.
const FILE_EXTENSION_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|java|rb|cs|rs|zig|php|kt|kts|swift|cpp|cc|cxx|c|h|hpp)$/i;

// A `Class.method` target collides with the extension test whenever the method name is
// also a language extension (`Router.go`, `Buffer.c`, `Preact.h`). The two are told apart
// by the STEM: file basenames here are lowercase/kebab/camel (`index.ts`,
// `cypher-guard.ts`), a PascalCase stem is a class.
const PASCAL_CASE_STEM_RE = /^[A-Z][A-Za-z0-9]*$/;

// Cap on the unique file-path set passed to boundariesInFiles: a hot symbol's
// directCallers/transitiveCallers is unfiltered and unbounded, and each path
// becomes a SQL/libsql IN-list parameter — a remote libsql connection caps the
// number of bound parameters per statement, so an uncapped list can fail the
// query outright rather than just being slow.
// Exported for tests only, so the truncation-note test doesn't hardcode a
// second copy of this number.
export const BOUNDARY_FILE_SCOPE_CAP = 200;

function looksLikeFilePath(target: string): boolean {
  if (target.includes('/') || target.includes('\\')) return true;
  const ext = FILE_EXTENSION_RE.exec(target);
  if (!ext) return false;
  return !PASCAL_CASE_STEM_RE.test(target.slice(0, target.length - ext[0].length));
}

/**
 * Handle analyze_change_impact tool
 */
export async function handleAnalyzeChangeImpact(
  args: Record<string, unknown>,
  scope: ScopeContext,
  format: OutputFormat,
  detailLevel: DetailLevel,
  detailConfig: DetailLevelConfig,
  repository: IGraphReadRepository,
): Promise<McpResponse<ChangeImpactResult | string>> {
  const target = args.target as string;
  const targetType = args.targetType as string | undefined;
  const fileHint = args.fileHint as string | undefined;
  const depth = (args.depth as number) || 3;

  if (looksLikeFilePath(target)) {
    throw new Error(
      `analyze_change_impact targets a single declaration (function, class, interface, type alias, enum, or entity name) — "${target}" looks like a file path, which is not supported. Call list_file_symbols with path: "${target}" to see the declarations in that file, then pass one of those names as target.`,
    );
  }

  debug(
    'findTarget',
    `Searching for "${target}", type=${targetType}, fileHint=${fileHint}, hashes=${scope.repoHashes.join(',')}`,
  );

  // Find the target element
  let targetElement: CodeElementInfo | null = null;

  // Search for the target based on type. type_alias and enum are looked up via
  // the generic findCode path because there's no type-alias-specific repo
  // method (yet) — but the search still works because type_alias/enum nodes
  // live in the same nodes table as classes/interfaces. `entity` is its own
  // branch because TypeORM @Entity-decorated classes are filed as type='entity'
  // in the graph even though their ID segment still says `:class:` — findClass
  // filters by type='class' and would miss them, so without this branch the
  // tool returns "not found" for every entity (e.g. `Shift`, `Workspace`).
  const types = targetType
    ? [targetType as 'function' | 'class' | 'interface' | 'type_alias' | 'enum' | 'entity']
    : (['function', 'class', 'interface', 'type_alias', 'enum', 'entity'] as const);

  for (const type of types) {
    if (targetElement) break;

    if (type === 'function') {
      // Accept "Class.method" — see packages/mcp/src/function-name.ts. Pass
      // the qualifier as className so the lookup filters by owning class.
      // The path-safety guard means file-path inputs pass through unchanged.
      // Pass fileHint so bare-name collisions (e.g. 12+ `wrapper` functions
      // across Pages API routes) disambiguate by file path. Without this,
      // findFunction does a name-only `WHERE n.name = ?` and returns the
      // alphabetically-first match.
      // Exact only here; the signature-suffix fallback runs after every kind's exact lookup.
      const { lookupName, requestedClassName } = parseFunctionName(target);
      const fn = await repository.findFunction(lookupName, scope.repoHashes, fileHint, requestedClassName);
      if (fn) {
        targetElement = {
          id: fn.id,
          name: fn.name,
          filePath: fn.filePath,
          startLine: fn.startLine,
          endLine: fn.endLine,
          type: 'function',
        };
      }
    } else if (type === 'class' || type === 'interface' || type === 'type_alias' || type === 'enum') {
      const found = await findTypeByName(repository, target, type, scope.repoHashes, false);
      if (found) targetElement = { ...found, type };
    } else if (type === 'entity') {
      const ent = await findEntityByName(repository, target, scope.repoHashes);
      if (ent) {
        targetElement = {
          id: ent.id,
          name: ent.name,
          filePath: ent.filePath,
          startLine: ent.startLine,
          endLine: ent.endLine,
          type: 'entity',
        };
      }
    }
  }

  // Exact names win across every kind; only then a unique signature-bearing function
  // (C# `Ns.Type.Method(Args)`) or namespace-qualified type (`Ns.Product`), so a short
  // name never shadows an exact match of another kind.
  for (const type of types) {
    if (targetElement) break;
    if (type === 'function') {
      const fn = await findFunctionByName(repository, target, scope.repoHashes, fileHint);
      if (fn)
        targetElement = {
          id: fn.id,
          name: fn.name,
          filePath: fn.filePath,
          startLine: fn.startLine,
          endLine: fn.endLine,
          type: 'function',
        };
    } else if (type === 'class' || type === 'interface' || type === 'type_alias' || type === 'enum') {
      const found = await findTypeByName(repository, target, type, scope.repoHashes);
      if (found) targetElement = { ...found, type };
    }
  }

  if (!targetElement) {
    debugResult('findTarget', 0);
    const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);
    const ambiguous = await ambiguousFunctionNote(repository, target, scope.repoHashes, fileHint);
    return formatChangeImpact(
      createEmptyResult(target, ambiguous ?? `Target '${target}' not found in scope`),
      metadata,
    );
  }

  debugResult('findTarget', 1);

  // CALLS-edge traversal answers "what invokes this function?" — meaningless
  // for pure types and entities. We skip it for type_alias/enum/entity (the
  // callers query would return an empty list anyway) and use specialized
  // signals: USES_TYPE for type-shape consumers, OPERATES_ON for entities.
  // class/interface targets get CALLS plus USES_TYPE: classes can be both
  // called and used as a type; interfaces are typically only referenced as
  // a type but a method on them can still appear as a CALLS target via
  // implementing classes.
  const traverseCalls = !['type_alias', 'enum', 'entity'].includes(targetElement.type);

  const directCallers: CallerInfo[] = [];
  const transitiveCallers: CallerInfo[] = [];

  if (traverseCalls) {
    debug('getCallers', `targetId=${targetElement.id}, depth=${depth}`);
    const allCallers = await repository.getTransitiveCallers(targetElement.id, depth, scope.repoHashes);
    debugResult('getCallers', allCallers.length);

    for (const caller of allCallers) {
      const callerInfo: CallerInfo = {
        id: caller.id,
        name: caller.name,
        filePath: caller.filePath,
        startLine: caller.startLine,
        endLine: caller.endLine,
        type: 'function',
        // Same honesty rule as find_callers. On a TRANSITIVE caller this means
        // "at least one hop in the shortest chain was inferred".
        ...(caller.provenanceInferred && { provenanceInferred: true as const }),
        kind: caller.kind,
        className: caller.className,
        summary: caller.summary,
        purpose: caller.purpose,
        distance: caller.distance,
      };

      if (caller.distance === 1) {
        directCallers.push(callerInfo);
      } else {
        transitiveCallers.push(callerInfo);
      }
    }
  }

  // Type-usage consumers (USES_TYPE edges) plus package-import RESOLVES_TO
  // files. For type_alias/enum these are the only signal; for class/interface
  // they complement CALLS-based callers. Functions are included so imports of
  // an exported function surface alongside its ordinary callers.
  // Surfaced as a separate `typeUsers` list instead of being mixed into
  // directCallers because the consumers may be classes/interfaces/type
  // aliases — fakable as `type: 'function'` would lose data fidelity.
  const typeUsersOut: CodeElementInfo[] = [];
  if (['function', 'type_alias', 'enum', 'interface', 'class'].includes(targetElement.type)) {
    debug('getTypeUsages', `targetId=${targetElement.id}`);
    const typeUsers = await repository.getTypeUsages(targetElement.id, scope.repoHashes);
    debugResult('getTypeUsages', typeUsers.length);
    for (const u of typeUsers) {
      typeUsersOut.push({
        id: u.id,
        name: u.name,
        filePath: u.filePath,
        startLine: u.startLine,
        endLine: u.endLine,
        type: NODE_TYPE_TO_ELEMENT_TYPE[u.type] ?? 'function',
        // find_dependents marks an unverified-identity consumer; this surface
        // read the same rows and dropped the flag, so the SAME row rendered as
        // proven here and unverified there.
        ...(u.ambiguous && { ambiguous: true as const }),
        summary: typeUsageSummary(u, targetElement.name),
      });
    }
  }

  // Entity consumers (OPERATES_ON edges). Functions that read/write/query the
  // entity ARE its direct callers in the impact sense — changing the entity's
  // schema breaks them. Tag each with its DB operation in the summary so the
  // formatted output can say "createShift uses Shift (create)" instead of
  // dropping the verb. EntityInfo has no endLine; surface what we have.
  if (targetElement.type === 'entity') {
    debug('getEntityConsumers', `entity=${targetElement.name}`);
    const consumers = await repository.getEntityConsumers(targetElement.name, scope.repoHashes);
    debugResult('getEntityConsumers', consumers.length);
    for (const c of consumers) {
      directCallers.push({
        id: c.id,
        name: c.name,
        filePath: c.filePath,
        startLine: c.startLine,
        endLine: 0,
        type: 'function',
        kind: c.kind,
        className: c.className,
        summary: `${c.operation} ${targetElement.name}`,
        distance: 1,
      });
    }
  }

  // Get affected entrypoints. Walk from the target plus executable/declaration
  // type users —
  // for a type alias used by route handlers, the type itself has no CALLS
  // chain, so reach-from-target returns nothing; reach-from-each-typeUser
  // is where the actual API surface shows up. Dedup by entrypoint id.
  // Package-import dependents are File nodes. A file is an honest dependency
  // result but not a CALLS-graph seed, so do not run recursive entrypoint
  // closure queries for those rows.
  const entrypointSeeds: string[] = [
    targetElement.id,
    ...typeUsersOut.filter((user) => user.type !== 'file').map((user) => user.id),
  ];
  debug('getReachingEntrypoints', `seedCount=${entrypointSeeds.length}, depth=${depth}`);
  // Bounded concurrency: each getReachingEntrypoints is an independent
  // recursive-closure query. typeUsersOut is unbounded — a widely-used type
  // alias can produce hundreds of users, and unbounded Promise.all would
  // queue that many in-flight recursive-closure queries (against Turso each
  // becomes a separate HTTP round trip; against local SQLite they serialize
  // on the connection but still tie up event-loop memory). 8 in flight gives
  // most of the parallel speed-up while protecting both backends.
  const CONCURRENCY = 8;
  const seenEntrypointIds = new Set<string>();
  const reachingEntrypoints: DbEntrypointInfo[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, entrypointSeeds.length) }, async () => {
      while (true) {
        const idx = next++;
        if (idx >= entrypointSeeds.length) return;
        const seedId = entrypointSeeds[idx]!;
        const eps = await repository.getReachingEntrypoints(seedId, depth, scope.repoHashes);
        for (const ep of eps) {
          if (seenEntrypointIds.has(ep.id)) continue;
          seenEntrypointIds.add(ep.id);
          reachingEntrypoints.push(ep);
        }
      }
    }),
  );
  debugResult('getReachingEntrypoints', reachingEntrypoints.length);

  const affectedEntrypoints: EntrypointInfo[] = reachingEntrypoints.map((ep) => ({
    id: ep.id,
    type: ep.type,
    method: ep.method,
    path: ep.path,
    fullPath: ep.fullPath,
    fieldName: ep.fieldName,
    operationType: ep.operationType,
    topic: ep.topic,
    topicValue: ep.topicValue,
    schedule: ep.schedule,
    // A mobile entrypoint is addressed by its component class; without it every Android row
    // here would read as its lifecycle method. (This projection also predates, and still
    // omits, the event/CLI address fields — see the Kotlin substrate follow-ups.)
    className: ep.className,
    trigger: ep.trigger,
    handlerId: ep.handlerId || '',
    handlerName: ep.handlerName || 'unknown',
    filePath: ep.filePath,
    startLine: ep.startLine || 0,
  }));

  // Affected tests — derived from the dependency sets already computed above
  // (callers + type users whose file path is test code), so this costs no extra
  // query and can never disagree with the rows rendered below it. Test nodes
  // only exist when the extraction profile includes test sources; when it
  // doesn't, this is empty and the formatter says so explicitly instead of
  // omitting the section.
  const seenTestIds = new Set<string>();
  const affectedTests: CodeElementInfo[] = [...directCallers, ...transitiveCallers, ...typeUsersOut]
    .filter((dependent) => isTestFilePath(dependent.filePath))
    .filter((dependent) => {
      if (seenTestIds.has(dependent.id)) return false;
      seenTestIds.add(dependent.id);
      return true;
    })
    .map((dependent) => ({
      id: dependent.id,
      name: dependent.name,
      filePath: dependent.filePath,
      startLine: dependent.startLine,
      type: dependent.type,
    }));

  // Cross-repo impact tracking not yet implemented
  const crossRepoImpacts = undefined as { repo: string; consumers: CallerInfo[] }[] | undefined;

  // Calculate risk level. Type users are first-class dependencies (a change
  // to a DTO breaks every consumer typed as it), so count them alongside
  // direct callers in the risk score.
  const riskLevel = calculateRiskLevel(
    directCallers.length + typeUsersOut.length,
    affectedEntrypoints.length,
    crossRepoImpacts?.length ?? 0,
  );

  // Build impact summary
  const impactSummary = buildImpactSummary(
    targetElement,
    directCallers,
    transitiveCallers,
    affectedEntrypoints,
    affectedTests,
    crossRepoImpacts,
    typeUsersOut,
  );

  // Filter results based on detail level (use default 'full' config if not provided)
  const config = detailConfig || resolveDetailLevel('full');
  const filteredDirectCallers = filterCallerArray(directCallers, config) as CallerInfo[];
  const filteredTransitiveCallers = filterCallerArray(transitiveCallers, config) as CallerInfo[];
  const filteredEntrypoints = filterEntrypointArray(affectedEntrypoints, config) as EntrypointInfo[];
  const filteredTests = filterCodeElementArray(affectedTests, config) as CodeElementInfo[];
  // `preserveSummary`: a type-user row's `summary` is the USES_TYPE relation
  // (`typeUsageSummary`), not AI prose — it is the only thing distinguishing a
  // type-position consumer from a value-position one, and this tool is
  // basic-by-default. See CodeElementFilterOptions in detail-level.ts.
  const filteredTypeUsers =
    typeUsersOut.length > 0
      ? (filterCodeElementArray(typeUsersOut, config, { preserveSummary: true }) as CodeElementInfo[])
      : undefined;

  const result: ChangeImpactResult = {
    target: targetElement,
    directCallers: filteredDirectCallers,
    transitiveCallers: filteredTransitiveCallers,
    typeUsers: filteredTypeUsers,
    affectedEntrypoints: filteredEntrypoints,
    affectedTests: filteredTests,
    crossRepoImpacts,
    riskLevel,
    impactSummary,
  };

  // Re-derive the class qualifier for function targets so an explicit
  // `Class.method` input suppresses the ambiguity banner.
  const ambiguityClassName =
    targetElement.type === 'function' ? parseFunctionName(target).requestedClassName : undefined;
  const ambiguity = await detectAmbiguity(repository, {
    name: targetElement.name,
    scope,
    nodeTypes: toNodeTypes(targetElement.type),
    resolvedId: targetElement.id,
    resolvedFilePath: targetElement.filePath,
    fileHint,
    className: ambiguityClassName,
    supportsClassName: targetElement.type === 'function',
  });
  const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository, ambiguity);
  const response = formatChangeImpact(result, metadata);

  // Dynamic boundaries: statically unresolved call sites INSIDE the impacted
  // symbols (the target plus its direct/transitive callers) — impact may
  // extend through these even though the static trace stops at them. Own
  // labeled section, never folded into the impact lists/counts above (spec
  // BR-1); no-op when nothing matches.
  //
  // Scoped to the target's OWN repo, not the whole cross-repo scope: two
  // repos can both have e.g. `src/service.ts`, and a bare file-path query run
  // across every repo in scope would return another repository's sites while
  // the target's own site fell off the display cap.
  const targetRepoHash = targetElement.id.split(':')[0];
  const allUniqueFilePaths = [
    ...new Set(
      [targetElement, ...directCallers, ...transitiveCallers].map((el) => el.filePath).filter((p): p is string => !!p),
    ),
  ];
  const impactedFilePaths = allUniqueFilePaths.slice(0, BOUNDARY_FILE_SCOPE_CAP);
  const fileScopeTruncated = allUniqueFilePaths.length > impactedFilePaths.length;
  const fileScopeTruncationNote = fileScopeTruncated
    ? `boundary scan covered the first ${BOUNDARY_FILE_SCOPE_CAP} of ${allUniqueFilePaths.length} impacted files`
    : undefined;
  const candidateBoundaryRecords = targetRepoHash
    ? await boundariesInFiles(repository, impactedFilePaths, [targetRepoHash])
    : [];
  // UC-2's actual semantics: sites INSIDE the impacted symbols, not "sites
  // anywhere in the same files" — a file can hold unrelated functions whose
  // unresolved calls have nothing to do with this change. No fallback when
  // the intersection is empty; empty is the honest answer.
  const impactedSymbolIds = new Set(
    [targetElement.id, ...directCallers.map((c) => c.id), ...transitiveCallers.map((c) => c.id)].filter(
      (id): id is string => !!id,
    ),
  );
  const boundaryRecords = candidateBoundaryRecords.filter((record) => impactedSymbolIds.has(record.callerId));
  appendBoundarySection(
    response,
    boundaryRecords,
    'Dynamic boundaries — impact may extend through these statically unresolved sites',
    fileScopeTruncationNote,
  );
  return response;
}

/**
 * Calculate risk level based on impact metrics
 */
function calculateRiskLevel(
  directCallers: number,
  affectedEntrypoints: number,
  crossRepoImpacts: number,
): 'low' | 'medium' | 'high' {
  const score = directCallers + affectedEntrypoints * 3 + crossRepoImpacts * 5;

  if (score >= 20) return 'high';
  if (score >= 8) return 'medium';
  return 'low';
}

/**
 * Build human-readable impact summary
 */
function buildImpactSummary(
  target: CodeElementInfo,
  directCallers: CallerInfo[],
  transitiveCallers: CallerInfo[],
  affectedEntrypoints: EntrypointInfo[],
  affectedTests: CodeElementInfo[],
  crossRepoImpacts?: { repo: string; consumers: CallerInfo[] }[],
  typeUsers?: CodeElementInfo[],
): string {
  const parts: string[] = [];

  parts.push(`Changing \`${target.name}\` would affect:`);

  if (directCallers.length > 0) {
    parts.push(`- ${directCallers.length} direct caller(s)`);
  }
  if (transitiveCallers.length > 0) {
    parts.push(`- ${transitiveCallers.length} transitive caller(s)`);
  }
  if (typeUsers && typeUsers.length > 0) {
    parts.push(`- ${typeUsers.length} type user(s)`);
  }
  if (affectedEntrypoints.length > 0) {
    parts.push(`- ${affectedEntrypoints.length} API endpoint(s)`);
  }
  if (affectedTests.length > 0) {
    parts.push(`- ${affectedTests.length} test file(s)`);
  }
  if (crossRepoImpacts && crossRepoImpacts.length > 0) {
    const totalConsumers = crossRepoImpacts.reduce((sum, i) => sum + i.consumers.length, 0);
    parts.push(`- ${totalConsumers} consumer(s) in ${crossRepoImpacts.length} other service(s)`);
  }

  if (parts.length === 1) {
    parts.push(`- ${ZERO_RESULTS_MARKER} — No detected impacts (may be unused or only used by untracked code)`);
  }

  return parts.join('\n');
}

/**
 * Create empty result for not found cases
 */
function createEmptyResult(targetName: string, message: string): ChangeImpactResult {
  return {
    target: {
      id: '',
      name: targetName,
      filePath: '',
      startLine: 0,
      type: 'function',
    },
    directCallers: [],
    transitiveCallers: [],
    affectedEntrypoints: [],
    affectedTests: [],
    riskLevel: 'low',
    impactSummary: message,
  };
}
