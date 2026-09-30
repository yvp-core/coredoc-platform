/** Pure replay of durable evidence. Ancestors are captured at delivery time: later
 * authority changes must never rewrite what an earlier delivery asserted. */
export type ReleaseKind = 'baseline' | 'release' | 'rollback' | 'plan' | 'withdraw' | 'reinstate';
export type Effectivity = 'effective' | 'not_effective' | 'planned' | 'withdrawn' | 'unknown';
export type PlanState = 'none' | 'active' | 'withdrawn' | 'consumed';
/**
 * WHO wrote the event (amendment §3.2). `maintainer` is a user session,
 * `ci` a service token in a `deploy` workspace, `connector` the in-process
 * GitHub connector of a `merge` workspace (RE-03). Evidence for a human reading
 * history — it grants nothing; the guards decide who may write.
 */
export enum ReleaseActorKind {
  Maintainer = 'maintainer',
  Connector = 'connector',
  Ci = 'ci',
}
/**
 * The PR a delivery came from. `(repoKey, number)`, never a bare number.
 * A type alias rather than an interface so it stays assignable to Prisma's
 * `InputJsonValue` when the payload is written.
 */
export type ReleasePr = { repoKey: string; number: number; url?: string };
export interface ReleaseEvent {
  seq: number;
  kind: ReleaseKind;
  recordedAt: string;
  recordedBy: string;
  data: {
    deliveredRef?: string;
    contentHashes?: Record<string, string>;
    included?: string[];
    retired?: string[];
    ancestors?: string[];
    itemId?: string;
    releaseSeq?: number;
    /** Automatic delivery provenance (amendment §3.2), additive on the payload — no new table. */
    repoKey?: string;
    deployId?: string;
    /** The DEPLOYMENT's own token (`deployedAt` / `mergedAt`), stored verbatim; never the server clock. */
    orderingToken?: string;
    actorKind?: ReleaseActorKind;
    pr?: ReleasePr;
  };
}

/** One unrolled delivery that included an item. A human record carries no repoKey/pr/orderingToken. */
export type ItemDelivery = {
  seq: number;
  deliveredRef: string;
  repoKey?: string;
  pr?: ReleasePr;
  orderingToken?: string;
};

function latestTokenKey(repoKey: string, itemId: string): string {
  return `${repoKey}\u0000${itemId}`;
}

export function foldIntentReleases(events: readonly ReleaseEvent[]) {
  const rolledBack = new Set(events.filter((e) => e.kind === 'rollback').map((e) => e.data.releaseSeq));
  const delivery = new Map<string, 'effective' | 'not_effective'>();
  /** Every unrolled delivery per item (BR-5): an item shipped from several repos lists each. */
  const deliveries = new Map<string, ItemDelivery[]>();
  const plans = new Map<string, PlanState>();
  /**
   * WHEN each item's current plan was written (amendment §3.1).
   *
   * The connector answers "does this merged pull request still hold a plan?" with it,
   * BY TIME rather than by provenance: a PR merged into production AFTER the plan was
   * recorded names an item that is in production-bound code, whichever PR happened to
   * write the plan event — two PRs can name one item and only the first plans it.
   * A merge from BEFORE the plan — a historical production merge, one made while the
   * workspace was `manual` — holds nothing.
   */
  const planRecordedAt = new Map<string, string>();
  /**
   * The newest ordering token of each (repository, item) over UNROLLED automatic
   * deliveries (BR-6): included, retired and ancestor ids all count, because each
   * is a fact the delivery asserted about that item. Keyed by `latestTokenKey`.
   *
   * Ordering is per item, not per repository: a late PR that touches none of the
   * items a newer delivery carried is not stale and records. Repositories never
   * order each other, and a human record — no `repoKey` — never appears here.
   */
  const latestTokenByRepoItem = new Map<string, string>();
  let currentRelease: {
    seq: number;
    deliveredRef: string;
    recordedAt: string;
    repoKey?: string;
    orderingToken?: string;
    actorKind?: ReleaseActorKind;
    pr?: ReleasePr;
  } | null = null;
  for (const event of events) {
    if (rolledBack.has(event.seq) || event.kind === 'rollback') continue;
    const { data } = event;
    if (event.kind === 'baseline' || event.kind === 'release') {
      for (const id of [...(data.retired ?? []), ...(data.ancestors ?? [])]) delivery.set(id, 'not_effective');
      for (const id of data.ancestors ?? []) if (plans.has(id)) plans.set(id, 'consumed');
      const shipped: ItemDelivery = {
        seq: event.seq,
        deliveredRef: data.deliveredRef as string,
        ...(data.repoKey ? { repoKey: data.repoKey } : {}),
        ...(data.pr ? { pr: data.pr } : {}),
        ...(data.orderingToken ? { orderingToken: data.orderingToken } : {}),
      };
      for (const id of data.included ?? []) {
        delivery.set(id, 'effective');
        plans.set(id, 'consumed');
        deliveries.set(id, [...(deliveries.get(id) ?? []), shipped]);
      }
      if (data.repoKey && data.orderingToken)
        for (const id of [...(data.included ?? []), ...(data.retired ?? []), ...(data.ancestors ?? [])]) {
          const key = latestTokenKey(data.repoKey, id);
          const known = latestTokenByRepoItem.get(key);
          if (!known || Date.parse(data.orderingToken) > Date.parse(known))
            latestTokenByRepoItem.set(key, data.orderingToken);
        }
      currentRelease = {
        seq: event.seq,
        deliveredRef: data.deliveredRef as string,
        recordedAt: event.recordedAt,
        // Carried so the ordering rule is a comparison against the fold's own
        // answer rather than a second query (amendment §3.2, decision 6).
        ...(data.repoKey ? { repoKey: data.repoKey } : {}),
        ...(data.orderingToken ? { orderingToken: data.orderingToken } : {}),
        ...(data.actorKind ? { actorKind: data.actorKind } : {}),
        ...(data.pr ? { pr: data.pr } : {}),
      };
    } else if (event.kind === 'plan' || event.kind === 'withdraw' || event.kind === 'reinstate') {
      const itemId = data.itemId as string;
      plans.set(itemId, event.kind === 'withdraw' ? 'withdrawn' : 'active');
      // A reinstate restarts the clock: the plan that is live now is the one recorded
      // by THIS event, so only merges after it can hold it.
      if (event.kind !== 'withdraw') planRecordedAt.set(itemId, event.recordedAt);
    } else {
      throw new Error(`Unsupported intent release event kind: ${event.kind}`);
    }
  }
  return {
    events,
    rolledBack,
    headSeq: events.at(-1)?.seq ?? 0,
    currentRelease,
    /** The newest ordering token of `itemId` in `repoKey`, if any automatic delivery carried it. */
    latestTokenOf: (repoKey: string, itemId: string): string | undefined =>
      latestTokenByRepoItem.get(latestTokenKey(repoKey, itemId)),
    effectiveIds: [...delivery]
      .filter(([, state]) => state === 'effective')
      .map(([id]) => id)
      .sort(),
    /** When the plans that are ACTIVE now were recorded — a consumed or withdrawn plan holds nothing. */
    planRecordedAt: new Map([...planRecordedAt].filter(([id]) => plans.get(id) === 'active')),
    planState: (id: string): PlanState => plans.get(id) ?? 'none',
    deliveriesOf: (id: string): ItemDelivery[] => deliveries.get(id) ?? [],
    effectivity: (id: string): Effectivity =>
      delivery.get(id) ??
      (plans.get(id) === 'active' ? 'planned' : plans.get(id) === 'withdrawn' ? 'withdrawn' : 'unknown'),
  };
}
export type ReleaseSnapshot = ReturnType<typeof foldIntentReleases>;
