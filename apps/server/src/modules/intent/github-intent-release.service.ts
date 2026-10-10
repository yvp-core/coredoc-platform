/** Reconciles PR-backed plans from structured handoffs and wakes the server worker.
 * Merge delivery is owned by IntentHandoffProcessor; PR prose and historical attrs
 * never supply declarations after cutover. This hook cannot fail ordinary import.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { CodeChangeState, DeliveryProvider, IntentReleaseTrigger } from '../../generated/prisma/client.js';
import type { IntentActor } from './intent-idempotency.js';
import { ReleaseActorKind, type ReleasePr } from './intent-release.fold.js';
import { IntentErrorCode, IntentPublicException } from './contract/index.js';
import { IntentReleaseService, readReleaseSnapshot, resolveIntentReleaseTrigger } from './intent-release.service.js';
import type { HandoffPayload } from './intent-handoff.operations.js';
type IntentTrailerRef = { itemId: string; version: number };
import { IntentPlanEventKind, intentPlanEvents, type IntentPlanItemState } from './intent-plan-transitions.js';
import type { ReleaseCommand } from './intent-release.operations.js';
import { asRecord } from '../../libs/coerce.js';

/**
 * The connector's identity in the ledger. It is not a user and must never borrow one:
 * `recorded_by` is a plain VARCHAR with no foreign key, and the `system:` prefix is
 * unreachable by any WorkOS user id, so history stays honest about who wrote the event.
 */
const CONNECTOR_ACTOR: IntentActor = { id: 'system:github-connector', role: 'system' };
/** Passes one sync may spend re-reading the ledger after losing the plan head CAS. */
const PLAN_CAS_PASSES = 3;

/** Bounded declarations read from the session-authored handoff. */
interface TrailerProjection {
  delivers: IntentTrailerRef[];
  retires: IntentTrailerRef[];
}

/**
 * The branch a merge into which means PRODUCTION for one pull request: the repository's
 * `productionBranch` when an admin set one, else the default branch the connector itself
 * reported on that PR's payload — never a `main`/`master` guess. `undefined` means the
 * question cannot be answered, and an unanswerable production question is a NO.
 */
function productionBranchOf(repoProductionBranch: string | null | undefined, attrs: unknown): string | undefined {
  const reported = asRecord(attrs).baseDefaultBranch;
  return repoProductionBranch ?? (typeof reported === 'string' ? reported : undefined);
}

@Injectable()
export class GithubIntentReleaseService {
  private readonly logger = new Logger(GithubIntentReleaseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly releases: IntentReleaseService,
  ) {}

  /** Never throws: the caller is a delivery sync, and intent is not allowed to break it. */
  async applyToCodeChange(workspaceId: string, codeChangeId: string, wakeHandoff = true): Promise<void> {
    try {
      await this.apply(workspaceId, codeChangeId, wakeHandoff);
    } catch (error) {
      this.logger.warn(
        `intent connector: workspace=${workspaceId} change=${codeChangeId} failed — ${(error as Error)?.message ?? error}`,
      );
    }
  }

  async applyToHandoff(workspaceId: string, repoKey: string, prNumber: number): Promise<void> {
    const repo = await this.prisma.workspaceRepo.findFirst({
      where: { workspaceId, intentRepoKey: repoKey },
      select: { id: true },
    });
    if (!repo) return;
    const change = await this.prisma.codeChange.findFirst({
      where: {
        workspaceId,
        provider: DeliveryProvider.github,
        number: prNumber,
        workspaceRepoId: repo.id,
      },
      select: { id: true },
    });
    // The worker already owns the attempt; a plan read must not release its claim.
    if (change) await this.applyToCodeChange(workspaceId, change.id, false);
  }

  private async apply(workspaceId: string, codeChangeId: string, wakeHandoff: boolean): Promise<void> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { intentEnabled: true, intentReleaseTrigger: true },
    });
    // Owner decision: with intent OFF for the workspace the automatic machinery does
    // nothing at all — no plan, no withdraw, no release read or write. This is a
    // separate, earlier gate than the release trigger: `resolveIntentReleaseTrigger`
    // still answers only manual/merge/deploy and its contract is unchanged.
    if (workspace?.intentEnabled !== true) return;
    const workspaceTrigger = workspace.intentReleaseTrigger;

    const change = await this.prisma.codeChange.findFirst({
      where: { id: codeChangeId, workspaceId, provider: DeliveryProvider.github },
      select: {
        id: true,
        number: true,
        title: true,
        state: true,
        isDraft: true,
        targetBranch: true,
        mergedAt: true,
        externalUrl: true,
        repoExternalId: true,
        workspaceRepoId: true,
        attrs: true,
      },
    });
    if (!change) return;

    let trailers: TrailerProjection = { delivers: [], retires: [] };
    const identity = `${change.repoExternalId}#${change.number ?? change.id}`;
    const repo = change.workspaceRepoId
      ? await this.prisma.workspaceRepo.findFirst({
          where: { id: change.workspaceRepoId, workspaceId },
          select: { intentRepoKey: true, productionBranch: true, intentReleaseTrigger: true },
        })
      : null;
    // Every `repoKey` in the ledger must be a key the other actors use (CLI, `intent_release`,
    // the per-repository ordering check). A PR whose repository is not linked to a workspace
    // repo has no such key, and the GitHub full name is not one — so the connector records
    // nothing for it rather than writing events that can never order against a real release.
    if (!repo?.intentRepoKey) return;

    const handoff = change.number
      ? await this.prisma.intentHandoff.findFirst({
          where: { workspaceId, repoKey: repo.intentRepoKey, prNumber: change.number },
        })
      : null;
    if (handoff) {
      if (change.state === CodeChangeState.open)
        await this.prisma.intentHandoff.updateMany({
          where: { id: handoff.id, mappingState: 'discarded', deliveryState: 'discarded' },
          data: { mappingState: 'pending', deliveryState: 'pending', mappingReason: null, deliveryReason: null },
        });
      const payload = handoff.payload as unknown as HandoffPayload;
      trailers = { delivers: payload.delivers, retires: payload.retires };
      if (wakeHandoff)
        await this.prisma.intentHandoff.updateMany({ where: { id: handoff.id }, data: { nextAttemptAt: new Date() } });
    }

    const trigger = resolveIntentReleaseTrigger(repo.intentReleaseTrigger, workspaceTrigger);
    if (trigger === IntentReleaseTrigger.manual) return;

    const pr: ReleasePr | undefined =
      change.number === null
        ? undefined
        : {
            repoKey: repo.intentRepoKey,
            number: change.number,
            ...(change.externalUrl ? { url: change.externalUrl } : {}),
          };
    const reason = `PR ${repo.intentRepoKey}#${change.number ?? '?'}: ${change.title ?? ''}`.slice(0, 2000);

    await this.applyPlanMachine(workspaceId, change, trailers, pr, reason, identity, workspaceTrigger);
  }

  /**
   * The §3.1 table, applied to whatever the ledger and the workspace's open PRs now say.
   *
   * A pass that loses the expected-head CAS to a concurrent writer re-reads the ledger and
   * recomputes its events, a bounded number of times, instead of dropping the transition.
   */
  private async applyPlanMachine(...args: Parameters<GithubIntentReleaseService['applyPlanPass']>): Promise<void> {
    for (let pass = 1; pass <= PLAN_CAS_PASSES; pass++) {
      if (!(await this.applyPlanPass(...args))) return;
    }
    this.logger.warn(`intent connector: plan head kept moving for PR ${args[5]}; left for the next sync`);
  }

  /** One pass of the plan machine. Answers whether it lost the expected-head CAS. */
  private async applyPlanPass(
    workspaceId: string,
    change: { id: string; state: CodeChangeState; isDraft: boolean },
    trailers: TrailerProjection,
    pr: ReleasePr | undefined,
    reason: string,
    identity: string,
    workspaceTrigger: IntentReleaseTrigger | undefined,
  ): Promise<boolean> {
    // Cheapest first: a PR with no trailers can only ever produce a WITHDRAW, and a
    // withdraw needs a plan event to exist. One indexed count answers that without
    // replaying the whole ledger for every synced pull request of the workspace.
    if (trailers.delivers.length === 0) {
      if ((await this.prisma.intentReleaseEvent.count({ where: { workspaceId, kind: 'plan' } })) === 0) return false;
    }
    const snapshot = await readReleaseSnapshot(this.prisma, workspaceId);

    // Only a pull request in a LINKED, automatically managed repository can hold a plan: the connector writes no
    // event for an unlinked one, so counting it as a holder would block the withdraw forever
    // — nothing would ever converge. Same rows answer the production-branch question below.
    const linkedRepos = (
      await this.prisma.workspaceRepo.findMany({
        where: { workspaceId, intentRepoKey: { not: null } },
        select: { id: true, intentRepoKey: true, productionBranch: true, intentReleaseTrigger: true },
      })
    ).filter(
      (repo) =>
        resolveIntentReleaseTrigger(repo.intentReleaseTrigger, workspaceTrigger) !== IntentReleaseTrigger.manual,
    );
    const automaticRepoKeys = new Set(linkedRepos.flatMap((repo) => (repo.intentRepoKey ? [repo.intentRepoKey] : [])));
    const handoffs = await this.prisma.intentHandoff.findMany({
      where: { workspaceId, repoKey: { in: [...automaticRepoKeys] }, prNumber: { not: null } },
      select: { repoKey: true, prNumber: true, payload: true, deliveryState: true },
    });
    // The workspace's LIVE declarations, keyed by the pull request that wrote them.
    // Missing handoff means unmigrated, not an explicit removal of declarations.
    // A discarded handoff still proves the PR joined this writer before closing.
    const declarations = new Map(handoffs.map((h) => [`${h.repoKey}#${h.prNumber}`, h]));
    const connectorPlanned = connectorPlannedItems(snapshot, automaticRepoKeys, new Set(declarations.keys()));
    if (connectorPlanned.length === 0 && trailers.delivers.length === 0) return false;
    const repoKeys = new Map(linkedRepos.map((r) => [r.id, r.intentRepoKey]));
    const productionBranches = new Map(linkedRepos.map((row) => [row.id, row.productionBranch]));
    // ponytail: the declaring pull requests are loaded and filtered in memory rather than
    // queried by JSON path. Bounded by the handoffs of the automatic repositories — a pull
    // request that declared nothing can hold nothing, so it is never fetched.
    const declaringChanges = await this.prisma.codeChange.findMany({
      where: {
        workspaceId,
        id: { not: change.id },
        workspaceRepoId: { in: linkedRepos.map((row) => row.id) },
        number: { in: handoffs.flatMap((h) => (h.prNumber === null ? [] : [h.prNumber])) },
      },
      select: {
        state: true,
        isDraft: true,
        mergedAt: true,
        targetBranch: true,
        attrs: true,
        workspaceRepoId: true,
        number: true,
      },
    });
    const declaringPrs = new Map(
      declaringChanges.map((row) => [
        `${row.workspaceRepoId ? repoKeys.get(row.workspaceRepoId) : ''}#${row.number}`,
        row,
      ]),
    );
    const selfKey = pr ? `${pr.repoKey}#${pr.number}` : '';
    // Driven from the DECLARATIONS, not from the pull-request rows. The handoffs are the
    // live set; enumerating `CodeChange` rows and looking their declaration up by PR number
    // lost every declaration this sync could not see from that side — a pull request the
    // connector has not imported yet, or one whose handoff was momentarily `discarded`
    // while the pull request was still open. The unrelated pull request being synced then
    // found nobody naming the item and withdrew a plan another open PR still holds, which
    // that PR's own next sync reinstated (the observed hourly plan/withdraw/reinstate
    // flap). Silence about a pull request is not a removal of its declaration.
    const namedByOtherChanges = new Set(
      [...declarations].flatMap(([key, handoff]) => {
        // The synced change's own declarations are `change.delivers`, which the machine adds.
        if (key === selfKey) return [];
        const delivers = (handoff.payload as unknown as HandoffPayload).delivers.map((ref) => ref.itemId);
        const row = declaringPrs.get(key);
        // No imported row: a `discarded` handoff is then the only evidence the pull request
        // closed. An imported OPEN row outranks it — the same precedence `apply` applies
        // when it un-discards the handoff of a pull request that is open.
        if (!row) return handoff.deliveryState === 'discarded' ? [] : delivers;
        if (row.state === CodeChangeState.open) return row.isDraft ? [] : delivers;
        // A MERGED pull request still names an item when it went into PRODUCTION
        // after the item's current plan was recorded: `deploy` mode's "merged,
        // awaiting the CI record", and a rollback that restored the plan its merge
        // consumed (AC4). The question is TIME, not provenance — two PRs may name one
        // item and only the first writes the plan event, so the merged one that holds
        // it is rarely the one that planned it. A merge from BEFORE the plan — a
        // historical production merge, one made while the workspace was `manual` —
        // holds nothing, and a merge into any other branch delivered nothing at all.
        // A CLOSED pull request holds nothing at all.
        if (row.state !== CodeChangeState.merged) return [];
        const mergedAt = row.mergedAt?.getTime();
        if (mergedAt === undefined) return [];
        const productionBranch = productionBranchOf(
          row.workspaceRepoId ? productionBranches.get(row.workspaceRepoId) : null,
          row.attrs,
        );
        if (!productionBranch || row.targetBranch !== productionBranch) return [];
        return delivers.filter((itemId) => {
          const plannedAt = snapshot.planRecordedAt.get(itemId);
          return plannedAt !== undefined && mergedAt > Date.parse(plannedAt);
        });
      }),
    );

    const ids = [...new Set([...trailers.delivers.map((ref) => ref.itemId), ...connectorPlanned])];
    const rows = await this.prisma.intentItem.findMany({
      where: { workspaceId, id: { in: ids } },
      select: { id: true, authority: true },
    });
    const items = new Map<string, IntentPlanItemState>(
      rows.map((row) => [
        row.id,
        {
          authority: row.authority,
          planState: snapshot.planState(row.id),
          effective: snapshot.effectivity(row.id) === 'effective',
        },
      ]),
    );

    const events = intentPlanEvents({
      change: { state: change.state, isDraft: change.isDraft, delivers: trailers.delivers },
      namedByOtherChanges,
      connectorPlanned,
      items,
    });

    let head = snapshot.headSeq;
    for (const event of events) {
      // The key is stable for the (transition, item, head) this pass computed, so a lost
      // response replays rather than writing twice; a pass that already converged computes
      // no event at all, which is the real idempotency.
      const envelope = {
        itemId: event.itemId,
        idempotencyKey: `connector:${event.kind}:${event.itemId}:${head}`,
        expectedHeadSeq: head,
        reason,
        ...(pr ? { pr } : {}),
      };
      const command: ReleaseCommand =
        event.kind === IntentPlanEventKind.Plan
          ? { ...envelope, kind: 'plan', expectedVersion: event.expectedVersion }
          : event.kind === IntentPlanEventKind.Withdraw
            ? { ...envelope, kind: 'withdraw' }
            : { ...envelope, kind: 'reinstate' };
      try {
        const written = await this.releases.record(workspaceId, CONNECTOR_ACTOR, command, ReleaseActorKind.Connector);
        // The next event of this pass must expect the head this one just moved to.
        head = (written as { headSeq: number }).headSeq;
      } catch (error) {
        // `release_out_of_order` carries two meanings: a late automatic delivery, and the
        // expected-head CAS loss of a head-checked write. A plan event is always the second:
        // another writer moved the head, so the rest of this pass is computed on stale state.
        if (error instanceof IntentPublicException && error.publicError.code === IntentErrorCode.ReleaseOutOfOrder)
          return true;
        this.logger.warn(
          `intent connector: ${event.kind} refused for ${event.itemId} on PR ${identity} — ${(error as Error)?.message ?? error}`,
        );
      }
    }
    return false;
  }
}

/**
 * Items whose CURRENTLY ACTIVE plan the connector itself wrote.
 *
 * The sweep may withdraw only these: a maintainer's manual plan is roadmap intent that
 * has no pull request yet (§3.2), and withdrawing it because no PR names it would delete
 * the one plan kind a human typed a reason for.
 */
export function connectorPlannedItems(
  snapshot: {
    events: readonly {
      kind: string;
      data: { itemId?: string; actorKind?: ReleaseActorKind; pr?: { repoKey: string; number?: number } };
    }[];
    planState: (id: string) => string;
  },
  automaticRepoKeys: ReadonlySet<string>,
  managedPrs: ReadonlySet<string>,
): string[] {
  const lastWriter = new Map<string, ReleaseActorKind | undefined>();
  const planRepo = new Map<string, string | undefined>();
  const planPr = new Map<string, string>();
  for (const event of snapshot.events) {
    if (event.kind !== 'plan' && event.kind !== 'withdraw' && event.kind !== 'reinstate') continue;
    if (event.data.itemId) {
      lastWriter.set(event.data.itemId, event.data.actorKind);
      // Withdraw/reinstate can be emitted while syncing another repo. Keep the
      // original plan owner so switching it to manual ends automatic sweeps.
      if (event.kind === 'plan') {
        planRepo.set(event.data.itemId, event.data.pr?.repoKey);
        planPr.set(event.data.itemId, `${event.data.pr?.repoKey}#${event.data.pr?.number}`);
      }
    }
  }
  return [...lastWriter]
    .filter(
      ([itemId, actorKind]) =>
        actorKind === ReleaseActorKind.Connector &&
        snapshot.planState(itemId) === 'active' &&
        automaticRepoKeys.has(planRepo.get(itemId) ?? '') &&
        managedPrs.has(planPr.get(itemId) ?? ''),
    )
    .map(([itemId]) => itemId)
    .sort();
}
