import type { AnalysisRecord, CallResolutionStats, DbOpResolutionStats } from '@coredoc/core/types';

/** All graph backends persist this portable record as a JSON string property. */
export function analysisFrom(value: unknown): AnalysisRecord[] | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const records: unknown = JSON.parse(value);
    if (!Array.isArray(records) || !records.length) return undefined;
    if (
      !records.every(
        (record) =>
          record !== null &&
          typeof record === 'object' &&
          typeof record.language === 'string' &&
          (record.target === undefined || typeof record.target === 'string') &&
          (record.mode === 'basic' || record.mode === 'enhanced') &&
          typeof record.compilerReceiverTypes === 'boolean' &&
          typeof record.fallback === 'boolean',
      )
    )
      return undefined;
    return records.map(({ language, target, mode, compilerReceiverTypes, fallback }) => ({
      language,
      ...(target === undefined ? {} : { target }),
      mode,
      compilerReceiverTypes,
      fallback,
    }));
  } catch {
    return undefined;
  }
}

/**
 * A backend property that may carry a count. Neo4j returns integers as objects; Ladybug and
 * SQLite return `number` or `bigint`. Anything else (string, boolean, list, map, null) is not
 * a measurement.
 */
function countFrom(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') return Number(value);
  // Neo4j Integer: an object exposing toNumber/toBigInt. Duck-typed so @coredoc/db keeps no
  // driver dependency on a backend it only optionally loads.
  if (value !== null && typeof value === 'object') {
    const candidate = value as { toNumber?: unknown; toBigInt?: unknown };
    if (typeof candidate.toNumber === 'function' && typeof candidate.toBigInt === 'function') {
      const converted = (candidate.toNumber as () => unknown)();
      return typeof converted === 'number' && Number.isFinite(converted) ? converted : undefined;
    }
  }
  return undefined;
}

/**
 * A persisted triple is a MEASUREMENT only when it is arithmetically possible: no count is
 * negative and `resolved + outOfScope <= sites` (the invariant both `CallResolutionStats` and
 * `DbOpResolutionStats` document). A record that breaks it was not written by a measuring
 * parser — it is corrupt or hand-edited — and rendering it yields impossible output such as
 * "150/100 counted sites bound (150%)". Reject it as not measured rather than report a lie.
 */
function measured(sites: number, resolved: number, outOfScope: number): boolean {
  if (sites < 0 || resolved < 0 || outOfScope < 0) return false;
  return resolved + outOfScope <= sites;
}

/**
 * The three call-resolution numbers, or nothing. A missing or non-numeric property means the
 * parser did not measure in-repo call resolution — never zero (spec LIM-3/BR-6). Shared by every
 * backend so no arm can drift into reporting an unmeasured repo as a measured `0/0/0`.
 */
export function callResolutionFrom(
  callSites: unknown,
  resolvedCalls: unknown,
  outOfScopeCalls: unknown,
): CallResolutionStats | undefined {
  const values = [countFrom(callSites), countFrom(resolvedCalls), countFrom(outOfScopeCalls)];
  if (values.some((value) => value === undefined)) return undefined;
  const [sites, resolved, outOfScope] = values as [number, number, number];
  if (!measured(sites, resolved, outOfScope)) return undefined;
  return { callSites: sites, resolvedCalls: resolved, outOfScopeCalls: outOfScope };
}

/**
 * The three db-op-resolution numbers, or nothing. Same discipline as {@link callResolutionFrom}:
 * a missing or non-numeric property means the parser did not measure db-operation resolution,
 * which is not the same fact as "nothing bound" (spec LIM-4/BR-6).
 */
export function dbOpResolutionFrom(
  dbOpSites: unknown,
  boundDbOps: unknown,
  outOfScopeDbOps: unknown,
): DbOpResolutionStats | undefined {
  const values = [countFrom(dbOpSites), countFrom(boundDbOps), countFrom(outOfScopeDbOps)];
  if (values.some((value) => value === undefined)) return undefined;
  const [sites, bound, outOfScope] = values as [number, number, number];
  if (!measured(sites, bound, outOfScope)) return undefined;
  return { dbOpSites: sites, boundDbOps: bound, outOfScopeDbOps: outOfScope };
}
