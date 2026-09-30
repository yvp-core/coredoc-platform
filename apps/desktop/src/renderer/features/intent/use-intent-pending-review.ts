/**
 * How many intent candidates are waiting for a decision — for surfaces OUTSIDE
 * the Intent tab (issue v1.1-01, the discovery badge).
 *
 * WHY IT IS A HOOK AND NOT A PROP DRILL. A maintainer who never opens the tab
 * never learns that anything is waiting, which is the defect this closes; so the
 * count has to be read where the top bar lives, not where the queue does. It is
 * ONE call — the queue route's summary, bought with a one-row page — under a
 * single stable key, and it shares the `['intent']` prefix every write
 * invalidates, so deciding a batch updates the badge without a second mechanism.
 *
 * GATED, NOT MERELY HIDDEN: the query does not run at all for a project with no
 * workspace or for a member who cannot review. A badge nobody can act on is
 * noise, and an unusable read is still a round trip.
 */

import { useQuery } from '@tanstack/react-query';
import { intentPendingReviewQueryOptions } from './intent-api';

/**
 * The waiting count, or 0 while it is unknown. Zero and unknown are deliberately
 * the same answer HERE — the badge renders nothing for either, and a count that
 * flickered in from a failed read would be worse than none.
 */
export function useIntentPendingCount(workspaceId: string | null): number {
  const query = useQuery({
    ...intentPendingReviewQueryOptions(workspaceId ?? ''),
    enabled: workspaceId !== null,
  });
  return query.data?.waiting ?? 0;
}
