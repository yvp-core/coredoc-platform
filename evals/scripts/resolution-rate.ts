/**
 * Resolution-rate measurement — re-runs the SQLite distribution-by-protocol
 * query the cross-repo-linking design used as its evidence (spec §2) and derives
 * the resolvable rate + events-resolved count.
 *
 * Pure + client-injected so it runs against either an in-memory libsql DB (tests)
 * or the selected project's live database (the re-measure gate in measure-resolution.ts).
 *
 * The "resolvable denominator" follows spec §10/§12: intra-process / infra noise
 * is excluded (it is correctly never resolved cross-repo). HTTP + events are the
 * resolvable surface the redesign targets.
 */

/** Protocols excluded from the resolvable denominator (spec §10: intra-process / infra / SaaS noise). */
export const INFRA_NOISE_PROTOCOLS: ReadonlySet<string> = new Set([
  'internal',
  'ipc',
  'subprocess',
  'bolt',
  'temporal',
]);

/** Event protocols — the green-field zero the redesign's topic resolver fixes (spec §2, §6). */
export const EVENT_PROTOCOLS: ReadonlySet<string> = new Set(['messaging', 'kafka']);

/** Pre-redesign measured rate of resolvable calls (spec §2: ~66% of ~2,000 resolvable). */
export const BASELINE_RESOLVABLE_RATE = 0.66;

/** Spec §2 projection for the substrate-native linker (~96% of resolvable). */
export const PROJECTED_RESOLVABLE_RATE = 0.96;

/**
 * Minimum the re-measure gate asserts after the redesign lands. Set conservatively
 * between baseline and projection because the exact landed rate depends on Phase 1
 * topic-extraction fidelity and Phase 3 moniker join recall, only known after a
 * real demo re-parse + re-link.
 */
export const REGRESSION_GUARD_RATE = 0.8;

export interface ResolutionRow {
  protocol: string;
  resolved: number;
  unresolved: number;
  total: number;
}

export interface ResolutionSnapshot {
  /** One row per distinct protocol, sorted by protocol name. */
  byProtocol: ResolutionRow[];
  /** All external_call nodes regardless of protocol. */
  totalCalls: number;
  /** External calls in the resolvable surface (http + events), denominator for the rate. */
  resolvableTotal: number;
  /** Of the resolvable surface, how many carry a resolvedTargetId. */
  resolvableResolved: number;
  /** resolvableResolved / resolvableTotal (0 when the surface is empty). */
  resolvableRate: number;
  /** Resolved calls whose protocol is an event protocol — the §2 green-field metric. */
  eventsResolved: number;
  /** Count of RESOLVES_TO edges in the graph. */
  resolvesToEdges: number;
}

/** The single thing this module needs from a DB connection — keeps it engine-agnostic and mockable. */
export interface QueryClient {
  execute(query: string): Promise<{ rows: Record<string, unknown>[] }>;
}

function num(v: unknown): number {
  return typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : Number(v ?? 0);
}

/**
 * Run the protocol × resolved-status distribution query and fold it into a snapshot.
 * Mirrors the planning-time evidence query verbatim so the re-measure is apples-to-apples.
 */
export async function measureResolution(client: QueryClient): Promise<ResolutionSnapshot> {
  const dist = await client.execute(`
    SELECT
      COALESCE(json_extract(n.properties, '$.protocol'), '') AS protocol,
      CASE WHEN json_extract(n.properties, '$.resolvedTargetId') IS NOT NULL THEN 'resolved' ELSE 'unresolved' END AS status,
      COUNT(*) AS c
    FROM nodes n
    WHERE n.type = 'external_call'
    GROUP BY protocol, status
    ORDER BY protocol, status
  `);

  const byProto = new Map<string, ResolutionRow>();
  for (const row of dist.rows) {
    const protocol = String(row.protocol ?? '');
    const status = String(row.status);
    const c = num(row.c);
    const entry = byProto.get(protocol) ?? { protocol, resolved: 0, unresolved: 0, total: 0 };
    if (status === 'resolved') entry.resolved += c;
    else entry.unresolved += c;
    entry.total += c;
    byProto.set(protocol, entry);
  }

  const byProtocol = [...byProto.values()].sort((a, b) => a.protocol.localeCompare(b.protocol));

  let totalCalls = 0;
  let resolvableTotal = 0;
  let resolvableResolved = 0;
  let eventsResolved = 0;
  for (const r of byProtocol) {
    totalCalls += r.total;
    if (INFRA_NOISE_PROTOCOLS.has(r.protocol)) continue;
    if (r.protocol === 'http' || EVENT_PROTOCOLS.has(r.protocol)) {
      resolvableTotal += r.total;
      resolvableResolved += r.resolved;
    }
    if (EVENT_PROTOCOLS.has(r.protocol)) eventsResolved += r.resolved;
  }

  const edges = await client.execute(`SELECT COUNT(*) AS c FROM edges WHERE type = 'RESOLVES_TO'`);
  const resolvesToEdges = num(edges.rows[0]?.c);

  return {
    byProtocol,
    totalCalls,
    resolvableTotal,
    resolvableResolved,
    resolvableRate: resolvableTotal === 0 ? 0 : resolvableResolved / resolvableTotal,
    eventsResolved,
    resolvesToEdges,
  };
}
