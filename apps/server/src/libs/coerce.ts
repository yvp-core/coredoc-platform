/** Tolerant readers for untrusted JSON (connector payloads, stored attrs) and small shared parsers. */

/** Non-object (or array/null) -> {}. */
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Non-array -> []. */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Missing or unparseable timestamp -> null. */
export function toDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** Prisma's unique-constraint violation, i.e. someone else inserted the row first. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

/** null (not 0) for an empty set, so callers can render "no data" instead of a misleading zero. */
export function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** `?days=` in (0, 365], floored; anything else (missing, bogus, out of range) -> 30. */
export function parseDays(raw?: string): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 365 ? Math.floor(n) : 30;
}

/** `?days=` parsed as an integer and clamped to `max`; missing, bogus or < 1 -> 30. */
export function parseDaysParam(raw: string | undefined, max: number): number {
  if (!raw) return 30;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 30;
  return Math.min(parsed, max);
}
