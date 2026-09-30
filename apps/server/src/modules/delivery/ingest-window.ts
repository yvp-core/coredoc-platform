/**
 * Ingest-window floor shared by the polled delivery importers (github, jira).
 *
 * Both importers bound their FIRST/backfill fetch to this floor so a connector
 * pointed at years of history (32 repos of PRs, a 30k-issue Jira project) does not
 * pull the whole archive on its first sync. The floor is applied as
 * `cursor ?? windowStart` — never `max(cursor, windowStart)`, which would push the
 * fetch past unimported items in a quiet gap and silently drop them. Once a cursor
 * exists the floor is inert, so editing it on an already-synced connector changes
 * nothing until its cursors are reset.
 *
 * Two forms, `since` winning when present:
 *  - `config.since`        — an absolute ISO instant. Deterministic: the same floor on
 *                            every sync, whenever the first one happens to run.
 *  - `config.lookbackDays` — a window relative to `now` (default 30). Convenient, but
 *                            the floor slides until the first sync lands.
 * The DTO layer rejects a body that sets both.
 */

/** Default ingest window when a connector's config carries neither `since` nor `lookbackDays`. */
export const DEFAULT_LOOKBACK_DAYS = 30;

/**
 * The ISO cutoff `days` days before now. Pure but for `Date.now()`, so tests freeze time.
 */
export function lookbackIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * An ISO instant from an untyped JSON value, or null when absent/unparseable. Writes are
 * DTO-validated (@IsISO8601); this guard only defends the untyped `config` JSON read.
 */
export function normalizeSince(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

/**
 * A connector's ingest window in days from its `config` JSON, defaulting to
 * DEFAULT_LOOKBACK_DAYS when the key is absent (connectors created before the window
 * existed) or not a positive number. Writes are DTO-validated (@IsInt @Min(1) @Max(3650));
 * this guard only defends the untyped JSON read.
 */
export function resolveLookbackDays(config: unknown): number {
  const raw = asRecord(config).lookbackDays;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_LOOKBACK_DAYS;
}

/**
 * The connector's backfill floor as an ISO instant: the absolute `since` when it is set
 * and parseable, otherwise the relative lookback window. A corrupt `since` falls through
 * to the window rather than throwing — a bad floor must not wedge an otherwise healthy
 * connector, and the window is the safe (narrower) direction to fail.
 */
export function resolveWindowStart(config: unknown): string {
  return normalizeSince(asRecord(config).since) ?? lookbackIso(resolveLookbackDays(config));
}

/**
 * The ingest floor already persisted on a connector, in the same one-key form the
 * service writes, or null when the stored config carries neither (or a corrupt `since`
 * with no window beside it). Lets an update that supplies no floor carry the stored one
 * forward instead of resetting it to the default.
 */
export function storedIngestWindow(config: unknown): { since: string } | { lookbackDays: number } | null {
  const record = asRecord(config);
  const since = normalizeSince(record.since);
  if (since !== null) return { since };
  const lookbackDays = record.lookbackDays;
  if (typeof lookbackDays === 'number' && Number.isFinite(lookbackDays) && lookbackDays > 0) {
    return { lookbackDays: Math.floor(lookbackDays) };
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
