/**
 * Sentinel marking for an entrypoint dimension (queue topic, route path, cli
 * command) whose detector matched but whose value is not a static string.
 *
 * The engine used to DROP the whole entrypoint in that case — a fail-quiet loss
 * that no consumer could see. It now emits the entrypoint with the dimension
 * marked, so the surface is visible while the value is unmistakably not a real
 * topic/path/command (nothing joins `unresolved:…` by accident).
 *
 * A leaf module (no imports) for the same reason as entity-sentinels.ts: the
 * substrate engine and any downstream consumer share one definition without an
 * import cycle.
 */
export const UNRESOLVED_PREFIX = 'unresolved:';

/**
 * Length cap for the marked expression. The source text of an unresolved dimension can be a
 * whole multi-KB SQL template or object literal, and the marked value becomes both an entity
 * name and part of an operation id — capped HERE so every lane shares one limit rather than
 * one call site slicing and the others not.
 */
const MAX_MARKED_LENGTH = 120;

/** Mark a non-static expression as an unresolved dimension value. */
export function markUnresolved(expression: string): string {
  return `${UNRESOLVED_PREFIX}${expression.replace(/\s+/g, ' ').trim().slice(0, MAX_MARKED_LENGTH)}`;
}

/** Whether a dimension value is an engine unresolved-sentinel, not a real value. */
export function isUnresolved(value: string): boolean {
  return value.startsWith(UNRESOLVED_PREFIX);
}
