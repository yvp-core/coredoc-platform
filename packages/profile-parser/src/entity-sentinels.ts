/**
 * Sentinel entityNames the engine emits on dbOperations that don't resolve to
 * a declared entity: 'unknown' for unresolvable receivers, 'transaction' for
 * entity-agnostic transaction ops. A leaf module (no imports) so both the
 * substrate engine (entityId-lookup exclusion) and the scorer (operated-entity
 * denominator) share one definition without an import cycle.
 *
 * `unresolved:…` (unresolved-sentinel.ts) counts as a sentinel too: a raw-SQL op whose
 * target could not be read statically names an EXPRESSION, not a table, and must never
 * inflate the distinct-entity count or attempt an entityId lookup.
 */
import { isUnresolved } from './unresolved-sentinel.js';

export const SENTINEL_ENTITY_NAMES: ReadonlySet<string> = new Set(['unknown', 'transaction']);

/** Whether a dbOperation's entityName is an engine sentinel, not a real entity. */
export function isSentinelEntityName(entityName: string): boolean {
  return SENTINEL_ENTITY_NAMES.has(entityName) || isUnresolved(entityName);
}
