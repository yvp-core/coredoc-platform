/**
 * MAIN-process trust boundary for the analytics time window. Both analytics
 * boundaries (observability-manager, delivery-manager) hand the renderer's raw
 * argument here before any request is composed, so a malformed selector never
 * reaches the cloud. Shared rather than duplicated per manager (unlike the
 * per-response projectors) because the rules are non-trivial and identical.
 */

import {
  AnalyticsWindowKind,
  MAX_ANALYTICS_DAYS,
  analyticsWindowError,
  type AnalyticsWindow,
} from '../shared/ipc-types.js';

function invalid(): never {
  throw new TypeError('Invalid analytics window');
}

export function validateAnalyticsWindow(raw: unknown): AnalyticsWindow {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid();
  const candidate = raw as Record<string, unknown>;

  if (candidate.kind === AnalyticsWindowKind.Days) {
    const { days } = candidate;
    if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > MAX_ANALYTICS_DAYS) invalid();
    return { kind: AnalyticsWindowKind.Days, days: days as number };
  }

  if (candidate.kind === AnalyticsWindowKind.Custom) {
    const { since, until } = candidate;
    if (typeof since !== 'string' || typeof until !== 'string') invalid();
    if (analyticsWindowError(since, until) !== null) invalid();
    return { kind: AnalyticsWindowKind.Custom, since, until };
  }

  invalid();
}
