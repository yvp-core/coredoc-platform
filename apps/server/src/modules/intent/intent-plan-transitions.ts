/**
 * The §3.1 plan machine, as a pure function (RE-03).
 *
 * WHY THIS IS A CONVERGENCE AND NOT A DIFF. The table in the amendment is
 * written as PR EVENTS ("closed without merge", "item removed from Delivers"),
 * but the connector never sees events: it polls, and the CodeChange row is
 * already overwritten with the new PR facts by the time anything downstream
 * runs. So the same table is expressed as the state it implies, which every row
 * of it agrees with:
 *
 *   an item is PLANNED exactly while some open, non-draft pull request of the
 *   workspace names it in `Delivers`.
 *
 * Close, convert-to-draft and removal-from-the-trailer are then one rule
 * (nothing names it any more → `withdraw`), reopen and re-add are one rule
 * (`withdrawn` → `reinstate`), and a second PR naming a planned item is
 * silently nothing. It is also idempotent by construction — a re-sync that
 * changed no PR fact computes the same state and emits no event — and it
 * survives raw-payload retention, because the evidence it reads is the trailer
 * projection on the surviving `CodeChange` rows.
 *
 * Two deliberate bounds on the sweep:
 * - only plans the CONNECTOR wrote are withdrawn. A maintainer's manual plan is
 *   roadmap intent with no PR yet (amendment §3.2) and must never be swept.
 * - a MERGED pull request is skipped entirely (last row of the table): the
 *   delivery consumes the plan, and a merge whose release was refused must not
 *   have its plan withdrawn as a consolation prize.
 */
import type { PlanState } from './intent-release.fold.js';
type IntentTrailerRef = { itemId: string; version: number };

/** The three plan-side event kinds, exactly as `IntentReleaseService.record` names them. */
export enum IntentPlanEventKind {
  Plan = 'plan',
  Withdraw = 'withdraw',
  Reinstate = 'reinstate',
}

/** Only a `plan` carries a version — the one the PR trailer named (RE-01's stale-version rule). */
export type IntentPlanEvent =
  | { kind: IntentPlanEventKind.Plan; itemId: string; expectedVersion: number }
  | { kind: IntentPlanEventKind.Withdraw | IntentPlanEventKind.Reinstate; itemId: string };

/** What the ledger and the item row say about one intent item. */
export interface IntentPlanItemState {
  authority: string;
  planState: PlanState;
  effective: boolean;
}

/** The pull request being projected, as the connector reads it off the `CodeChange` row. */
export interface IntentPlanChange {
  state: 'open' | 'merged' | 'closed';
  isDraft: boolean;
  delivers: readonly IntentTrailerRef[];
}

export interface IntentPlanInput {
  change: IntentPlanChange;
  /**
   * Items named in `Delivers` by OTHER pull requests of this workspace that still hold
   * them: open and non-draft, or merged AND the writer of the item's currently active
   * plan (a rolled-back delivery restores the plan its merge consumed, and the merged
   * body is then the only thing naming the item).
   */
  namedByOtherChanges: ReadonlySet<string>;
  /** Items whose CURRENTLY ACTIVE plan was written by the connector. */
  connectorPlanned: readonly string[];
  /** Item facts, keyed by id. A missing entry is an id this workspace does not hold. */
  items: ReadonlyMap<string, IntentPlanItemState>;
}

export function intentPlanEvents(input: IntentPlanInput): IntentPlanEvent[] {
  const { change, namedByOtherChanges, connectorPlanned, items } = input;
  if (change.state === 'merged') return [];

  const holdsPlans = change.state === 'open' && !change.isDraft;
  const events: IntentPlanEvent[] = [];

  if (holdsPlans) {
    for (const ref of [...change.delivers].sort((a, b) => a.itemId.localeCompare(b.itemId))) {
      const item = items.get(ref.itemId);
      // An unknown, unaccepted or already-effective item is not plannable — the
      // service refuses all three by name, so not asking is the same answer without
      // a refusal in the log every hour.
      if (!item || item.authority !== 'accepted' || item.effective) continue;
      if (item.planState === 'none')
        events.push({ kind: IntentPlanEventKind.Plan, itemId: ref.itemId, expectedVersion: ref.version });
      else if (item.planState === 'withdrawn') events.push({ kind: IntentPlanEventKind.Reinstate, itemId: ref.itemId });
    }
  }

  const named = new Set(namedByOtherChanges);
  if (holdsPlans) for (const ref of change.delivers) named.add(ref.itemId);
  for (const itemId of [...connectorPlanned].sort()) {
    if (named.has(itemId)) continue;
    if (items.get(itemId)?.planState !== 'active') continue;
    events.push({ kind: IntentPlanEventKind.Withdraw, itemId });
  }

  return events;
}
