/**
 * One assembler for the `ParsedRepo` every non-TS language substrate returns.
 *
 * Each substrate used to carry its own copy of this object literal; they differed only in which
 * collections were hard-wired to `[]`. Here every collection a substrate does not emit defaults
 * to `[]`, so a call site lists only the facts it actually produced. Fields outside the fixed
 * set (`components`, `routes`, `errors`, ...) pass through unchanged.
 */
import type { AnalysisRecord, ParsedRepo, ParseStats } from '@coredoc/core';

/** Count fields the assembler derives from the draft's own collections — never hand-written. */
type DerivedStatKeys =
  | 'totalFunctions'
  | 'totalClasses'
  | 'totalEntrypoints'
  | 'totalEntities'
  | 'totalCalls'
  | 'totalExternalCalls';

/**
 * The stats a substrate actually MEASURES. The counts come from the collections it emitted, and
 * `analysis` is the single record a substrate reports (the array is an artifact of the merged,
 * multi-target output shape), so a substrate cannot drift from its own graph.
 */
export type DraftStats = Omit<ParseStats, DerivedStatKeys | 'analysis'> & { analysis?: AnalysisRecord };

/** What a substrate hands the assembler: the identity + stats it must supply, the rest optional. */
type Required_ = 'id' | 'name' | 'path' | 'parsedAt' | 'parserId';
export type ParsedRepoDraft = Partial<Omit<ParsedRepo, Required_ | 'parserVersion' | 'stats'>> &
  Pick<ParsedRepo, Required_> & { stats: DraftStats };

export function toParsedRepo(
  draft: ParsedRepoDraft,
  options: {
    /**
     * Stamped into the artifact — never lower it below 1.1.0. `MESSAGING_SCHEMA_VERSION` in
     * packages/mcp/src/tools/cross-repo/messaging-data.ts (`predatesMessagingSchema`) reads any
     * 1.0.x core as "parsed before messaging descriptors" and permanently excludes the repo's
     * messaging sites from `trace_cross_repo_call` — a staleness a re-parse could never clear.
     */
    parserVersion: string;
  },
): ParsedRepo {
  const {
    id,
    name,
    path,
    type,
    parsedAt,
    parserId,
    packages,
    files,
    functions,
    classes,
    interfaces,
    typeAliases,
    enums,
    variables,
    entrypoints,
    entities,
    dbOperations,
    calls,
    imports,
    externalCalls,
    stats,
    ...rest
  } = draft;
  const { analysis, totalFiles, parsedFiles, skippedFiles, totalImports, parseTimeMs, ...extraStats } = stats;
  const functionList = functions ?? [];
  const classList = classes ?? [];
  const entrypointList = entrypoints ?? [];
  const entityList = entities ?? [];
  const callList = calls ?? [];
  const externalCallList = externalCalls ?? [];
  return {
    id,
    name,
    path,
    type,
    parsedAt,
    parserVersion: options.parserVersion,
    parserId,
    packages: packages ?? [],
    files: files ?? [],
    functions: functionList,
    classes: classList,
    interfaces: interfaces ?? [],
    typeAliases: typeAliases ?? [],
    enums: enums ?? [],
    variables: variables ?? [],
    entrypoints: entrypointList,
    entities: entityList,
    dbOperations: dbOperations ?? [],
    calls: callList,
    imports: imports ?? [],
    externalCalls: externalCallList,
    ...rest,
    stats: {
      totalFiles,
      parsedFiles,
      skippedFiles,
      totalFunctions: functionList.length,
      totalClasses: classList.length,
      totalEntrypoints: entrypointList.length,
      totalEntities: entityList.length,
      totalCalls: callList.length,
      totalImports,
      totalExternalCalls: externalCallList.length,
      parseTimeMs,
      // Whatever else the substrate measured (callResolution, dbOpResolution, per-language
      // records), in its own order.
      ...extraStats,
      // Omitted, not `undefined`, when the substrate reported none.
      ...(analysis ? { analysis: [analysis] } : {}),
    },
  };
}
