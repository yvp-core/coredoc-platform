/**
 * Shared plumbing for the daily retention sweeps (metrics, intent, capture,
 * delivery raw payloads). Each cron kept its own env parse, clamp, cutoff and
 * log line; the four had drifted into three different ways of reading a boolean.
 * The POLICY stays with the cron — which flag, which default, whether an
 * unreadable window clamps or refuses — only the mechanics live here.
 */

const DAY_MS = 86_400_000;

/**
 * One reading of a retention kill-switch, from the RAW configured value. The
 * vocabulary is deliberately EXACT
 * — no trim, no case-fold, no `0`/`off`/`no` — for rollback safety: existing
 * deployments carry values like `0` whose meaning must not flip when this
 * helper replaced four hand-rolled comparisons. A default-ON sweep is stopped
 * only by the literal `false`; a default-OFF sweep is started only by the
 * literal `true`. Everything else means the cron's own documented default.
 */
export function parseRetentionFlag(raw: string | undefined, options: { defaultEnabled: boolean }): boolean {
  return options.defaultEnabled ? raw !== 'false' : raw === 'true';
}

export interface RetentionDaysOptions {
  /** The window to use when the operator set nothing at all. */
  fallback: number;
  /**
   * What an unreadable explicit value means:
   *  - `clamp` (default): the operator's mistake stays visible as a >= 1-day
   *    window rather than silently becoming the default.
   *  - `refuse`: return null — the caller would rather not sweep at all than
   *    sweep on a window nobody chose.
   */
  onInvalid?: 'clamp' | 'refuse';
}

/**
 * Unset → `fallback`. Otherwise the explicit value, never below one day: a 0 or
 * negative window would push the cutoff into the future and purge everything.
 */
export function parseRetentionDays(
  raw: string | undefined,
  options: RetentionDaysOptions & { onInvalid?: 'clamp' },
): number;
export function parseRetentionDays(
  raw: string | undefined,
  options: RetentionDaysOptions & { onInvalid: 'refuse' },
): number | null;
export function parseRetentionDays(raw: string | undefined, options: RetentionDaysOptions): number | null {
  const { fallback, onInvalid = 'clamp' } = options;
  if (raw === undefined) return fallback;
  const parsed = Number(raw.trim());
  const usable = raw.trim() !== '' && Number.isFinite(parsed);
  if (onInvalid === 'refuse') return usable && parsed > 0 ? Math.max(1, parsed) : null;
  return Math.max(1, usable ? parsed : fallback);
}

export interface RetentionSweepInput {
  /** Log prefix, e.g. `delivery retention`. */
  name: string;
  /** What is being deleted, e.g. `rows`, `events`, `raw payloads`. */
  unit: string;
  /** Included in the log line when the cron reports its window. */
  days?: number;
  cutoff: Date;
  purge: (cutoff: Date) => Promise<number>;
  logger: { log: (message: string) => void };
}

/** Runs the purge and writes the one log line every sweep is expected to leave. */
export async function runRetentionSweep(input: RetentionSweepInput): Promise<number> {
  const count = await input.purge(input.cutoff);
  const window = input.days === undefined ? '' : ` older than ${input.days}d`;
  input.logger.log(`${input.name}: deleted ${count} ${input.unit}${window} (cutoff ${input.cutoff.toISOString()})`);
  return count;
}

/** `new Date(now - days)` — the one place a retention window becomes a cutoff. */
export function retentionCutoff(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}
