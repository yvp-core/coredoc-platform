import { GithubApiError, GithubAuthError } from '../../libs/github/github-client.js';
import { GithubIntentReleaseService } from './github-intent-release.service.js';
import { IntentErrorCode } from './contract/index.js';
import { intentStateError } from './intent-state-errors.js';
import { Injectable, ConflictException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma, type IntentHandoff } from '../../generated/prisma/client.js';
import { WorkspaceMcpContextService } from '../../mcp/workspace-mcp-context.service.js';
import { IntentHandoffAnchorsService } from './intent-handoff-anchors.service.js';
import { IntentHandoffGithubService } from './intent-handoff-github.service.js';
import { handoffEnvelope, type IntentDeployment, type HandoffSnapshot } from './intent-handoff.operations.js';
import { handoffPayload, handoffResults, lockHandoff } from './intent-handoff.service.js';
import { IntentReleaseService, resolveIntentReleaseTrigger } from './intent-release.service.js';
import type { IntentActor } from './intent-idempotency.js';
import { ReleaseActorKind, type ReleaseEvent } from './intent-release.fold.js';

const actor = { id: 'system:intent-handoff', role: 'system' };
/** The record response (fresh or replayed); only the fields this file reads are typed. */
type RecordedRelease = { event: { seq: number } } & Record<string, unknown>;
const retryAt = () => new Date(Date.now() + 5 * 60_000);
const finished = new Set(['applied', 'recorded', 'discarded', 'superseded']);
/**
 * Automatic retries AFTER merge are bounded (BR-6): 12 passes at the 5-minute
 * backoff is about an hour, then the row goes to `needs_attention` keeping its
 * reason. A session re-save resets the counters.
 */
const MAX_POST_MERGE_ATTEMPTS = 12;
/** Waiting, not failing: an open PR, a deploy or manual mode, or graph publication are never bounded. */
const unboundedWaits = new Set([
  'pr_not_attached',
  'merge_not_confirmed',
  'merge_metadata_missing',
  'awaiting_production_deploy',
  'manual_delivery',
  'snapshot_does_not_include_merge',
]);

@Injectable()
export class IntentHandoffProcessor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly github: IntentHandoffGithubService,
    private readonly context: WorkspaceMcpContextService,
    private readonly anchors: IntentHandoffAnchorsService,
    private readonly releases: IntentReleaseService,
    private readonly plans: GithubIntentReleaseService,
  ) {}

  async process(workspaceId: string, id: string): Promise<void> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { intentEnabled: true },
    });
    // Owner decision: with intent OFF the automatic machinery does nothing — no GitHub
    // call, no ledger write, and NO write to the handoff row either. Leaving the row
    // exactly as it is (including `nextAttemptAt`) is what makes re-enabling the flag
    // resume it; the cron's 5-minute claim it may already hold simply expires on its
    // own, and the cron no longer claims rows of disabled workspaces at all.
    if (workspace?.intentEnabled !== true) return;
    const row = await this.prisma.intentHandoff.findFirst({ where: { workspaceId, id } });
    if (!row) return;
    if (finished.has(row.mappingState) && finished.has(row.deliveryState)) {
      await this.prisma.intentHandoff.updateMany({
        where: { id, workspaceId, version: row.version },
        data: { nextAttemptAt: null },
      });
      return;
    }
    if (!row.prNumber) {
      await this.pending(row, 'pr_not_attached');
      return;
    }
    try {
      // Session edits do not update GitHub's import cursor. Reconcile plans
      // from the imported PR even when only the handoff changed.
      await this.plans.applyToHandoff(workspaceId, row.repoKey, row.prNumber);
      const observedAt = new Date();
      const source = await this.github.pull(workspaceId, row.repoKey, row.prNumber);
      const pr = source.pull;
      if (!pr.merged) {
        await this.prisma.intentHandoff.updateMany({
          where: { id, workspaceId, version: row.version },
          data: { prObservedAt: observedAt, mergedAt: null, mergeCommit: null },
        });
        if (pr.state === 'closed')
          await this.prisma.intentHandoff.updateMany({
            where: { id, workspaceId, version: row.version },
            data: {
              mappingState: 'discarded',
              deliveryState: 'discarded',
              mappingReason: 'pr_closed_unmerged',
              deliveryReason: 'pr_closed_unmerged',
              nextAttemptAt: null,
            },
          });
        else await this.pending(row, 'merge_not_confirmed');
        return;
      }
      if (!pr.merge_commit_sha || !pr.merged_at) {
        await this.pending(row, 'merge_metadata_missing');
        return;
      }
      // Publish the merge and its observation together. A fresh timestamp
      // without mergedAt would falsely look like a verified open PR to peers.
      await this.prisma.intentHandoff.updateMany({
        where: { id, workspaceId, version: row.version },
        data: { mergeCommit: pr.merge_commit_sha, mergedAt: new Date(pr.merged_at), prObservedAt: observedAt },
      });
      const branch = source.repo.productionBranch ?? pr.base.repo.default_branch;
      if (branch !== pr.base.ref) {
        await this.attention(row, 'merge_not_production');
        return;
      }
      // Neither half may prevent the other from consuming an independently verified fact.
      if (!finished.has(row.deliveryState))
        await this.deliver(row, source.repo.intentReleaseTrigger, pr.merge_commit_sha, pr.merged_at);
      if (!finished.has(row.mappingState) && handoffPayload(row).bindings.length === 0) {
        await this.prisma.intentHandoff.updateMany({
          where: { id, workspaceId, version: row.version, mappingState: { notIn: ['discarded', 'superseded'] } },
          data: { mappingState: 'applied', mappingReason: null },
        });
      } else if (!finished.has(row.mappingState)) {
        try {
          const snapshot = await this.snapshot(row, branch, source.repo.repoKey);
          if (!snapshot || !(await this.github.includes(source, pr.merge_commit_sha, snapshot.graphCommit))) {
            await this.mappingStatus(row, 'pending', 'snapshot_does_not_include_merge');
          } else await this.map(row, snapshot);
        } catch (error) {
          const reason = sourceAttentionReason(error);
          await this.mappingStatus(
            row,
            reason ? 'needs_attention' : 'pending',
            reason ?? safeReason(error, 'mapping_retryable'),
          );
        }
      }
    } catch (error) {
      const reason = sourceAttentionReason(error);
      if (reason) await this.attention(row, reason);
      else await this.pending(row, safeReason(error, 'github_unavailable'));
    }
    const latest = await this.prisma.intentHandoff.findFirst({ where: { id, workspaceId, version: row.version } });
    if (latest) {
      const retrying = (state: string, reason: string | null) =>
        latest.mergedAt !== null && state === 'pending' && !unboundedWaits.has(reason ?? '');
      const deliveryRetry = retrying(latest.deliveryState, latest.deliveryReason);
      const mappingRetry = retrying(latest.mappingState, latest.mappingReason);
      const deliveryAttempts = latest.deliveryAttempts + (deliveryRetry ? 1 : 0);
      const mappingAttempts = latest.mappingAttempts + (mappingRetry ? 1 : 0);
      const deliveryState =
        deliveryRetry && deliveryAttempts >= MAX_POST_MERGE_ATTEMPTS ? 'needs_attention' : latest.deliveryState;
      const mappingState =
        mappingRetry && mappingAttempts >= MAX_POST_MERGE_ATTEMPTS ? 'needs_attention' : latest.mappingState;
      await this.prisma.intentHandoff.updateMany({
        where: { id, workspaceId, version: row.version },
        data: {
          deliveryAttempts,
          mappingAttempts,
          nextAttemptAt:
            mappingState === 'pending' ||
            (deliveryState === 'pending' &&
              !['awaiting_production_deploy', 'manual_delivery'].includes(latest.deliveryReason ?? ''))
              ? retryAt()
              : null,
        },
      });
      // An exhausted half moves to attention only while it is still pending: a CI
      // deploy may record it between the read above and this write (version does
      // not move on a ledger record), and `recorded` must never be overwritten.
      if (deliveryState !== latest.deliveryState)
        await this.prisma.intentHandoff.updateMany({
          where: { id, workspaceId, version: row.version, deliveryState: 'pending' },
          data: { deliveryState },
        });
      if (mappingState !== latest.mappingState)
        await this.prisma.intentHandoff.updateMany({
          where: { id, workspaceId, version: row.version, mappingState: 'pending' },
          data: { mappingState },
        });
    }
  }

  async recordDeployment(
    workspaceId: string,
    input: IntentDeployment,
    deployActor: IntentActor = { id: 'system:intent-deployment', role: 'system' },
    deployKind: ReleaseActorKind = ReleaseActorKind.Ci,
  ) {
    const workspace = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { intentEnabled: true, intentReleaseTrigger: true },
    });
    // Owner decision: CI's automatic deployment record is part of the same machinery.
    // With intent OFF it is REFUSED by name rather than answered 200 with no effect —
    // a CI run must be able to tell "recorded nothing" from "the feature is off".
    if (!workspace.intentEnabled)
      throw intentStateError(
        IntentErrorCode.IntentDisabled,
        'Intent is not enabled for this workspace',
        [],
        HttpStatus.CONFLICT,
      );
    if (!(await this.prisma.workspaceRepo.count({ where: { workspaceId, intentRepoKey: input.repoKey } })))
      throw intentStateError(
        IntentErrorCode.UnknownRepoKey,
        'Repository is not linked to this workspace',
        ['repoKey'],
        400,
      );
    await this.releases.assertServiceTokenMayRecord(workspaceId, { ...input, trailers: { delivers: [], retires: [] } });
    const source = await this.github.source(workspaceId, input.repoKey);
    if (resolveIntentReleaseTrigger(source.repo.intentReleaseTrigger, workspace.intentReleaseTrigger) !== 'deploy')
      throw new ConflictException('repo_not_in_deploy_mode');
    if (input.handoffId) {
      const row = await this.prisma.intentHandoff.findFirst({
        where: { workspaceId, repoKey: input.repoKey, id: input.handoffId },
      });
      if (!row || !row.prNumber) return { outcome: 'no_delivery' as const, reason: 'no_handoff' };
      return this.deployOne(workspaceId, source, input, row, deployActor, deployKind);
    }
    // A retried step of THIS deployment replays the PRs it already recorded instead of
    // answering no_delivery; any other deployment only picks up pending handoffs.
    const replayedPrs = (
      await this.prisma.intentReleaseEvent.findMany({
        where: { workspaceId, kind: 'release', deliveredRef: input.deliveredRef },
        select: { data: true },
      })
    )
      .map((event) => event.data as ReleaseEvent['data'])
      .filter((data) => data.repoKey === input.repoKey && data.deployId === input.deployId && data.pr)
      .map((data) => data.pr!.number);
    // A deploy ships every merged PR its ref includes (BR-5), not only the PR of its head commit.
    const pending = await this.prisma.intentHandoff.findMany({
      where: {
        workspaceId,
        repoKey: input.repoKey,
        prNumber: { not: null },
        mergeCommit: { not: null },
        OR: [
          { deliveryState: 'pending' },
          { prNumber: { in: replayedPrs } },
          // A retry of this deploy re-attempts the PRs that failed in it, so a still-failing
          // one fails the call again; failures of other deploys stay out.
          { deliveryState: 'needs_attention', deliveryDeployId: input.deployId },
        ],
      },
      orderBy: [{ mergedAt: 'asc' }, { id: 'asc' }],
    });
    const included: IntentHandoff[] = [];
    for (const row of pending)
      if (await this.github.includes(source, row.mergeCommit!, input.deliveredRef)) included.push(row);
    if (!included.length) return { outcome: 'no_delivery' as const, reason: 'no_handoff' };
    const deliveries: Array<{ handoffId: string; pr: number; outcome: string; seq?: number; reason?: string }> = [];
    let last: RecordedRelease | undefined;
    let failure: unknown;
    // Merge order; one PR's refusal does not stop the others (BR-6), but still fails the call.
    for (const row of included) {
      try {
        const result = await this.deployOne(workspaceId, source, input, row, deployActor, deployKind);
        if ('event' in result) {
          last = result;
          deliveries.push({ handoffId: row.id, pr: row.prNumber!, outcome: 'recorded', seq: result.event.seq });
        } else
          deliveries.push({ handoffId: row.id, pr: row.prNumber!, outcome: result.outcome, reason: result.reason });
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
    // Top level stays the last recorded release, so a single-release reader keeps working.
    return last
      ? { ...last, deliveries }
      : { outcome: 'no_delivery' as const, reason: 'no_delivery_declarations', deliveries };
  }

  private async deployOne(
    workspaceId: string,
    source: Awaited<ReturnType<IntentHandoffGithubService['source']>>,
    input: IntentDeployment,
    row: IntentHandoff,
    deployActor: IntentActor,
    deployKind: ReleaseActorKind,
  ): Promise<RecordedRelease | { outcome: 'no_delivery'; reason: string }> {
    try {
      const verified = await this.github.pull(workspaceId, row.repoKey, row.prNumber!);
      const pr = verified.pull;
      if (
        !pr.merged ||
        !pr.merge_commit_sha ||
        !pr.merged_at ||
        pr.base.ref !== (source.repo.productionBranch ?? pr.base.repo.default_branch)
      )
        throw new ConflictException('deployment_merge_not_confirmed');
      if (!(await this.github.includes(source, pr.merge_commit_sha, input.deliveredRef)))
        throw new ConflictException('deployment_does_not_include_merge');
      const payload = handoffPayload(row);
      if (!payload.delivers.length && !payload.retires.length)
        return { outcome: 'no_delivery' as const, reason: 'no_delivery_declarations' };
      return (await this.releases.record(
        workspaceId,
        deployActor,
        {
          kind: 'release',
          repoKey: row.repoKey,
          deliveredRef: input.deliveredRef,
          deployId: input.deployId,
          deployedAt: input.deployedAt,
          trailers: { delivers: payload.delivers, retires: payload.retires },
          pr: { repoKey: row.repoKey, number: row.prNumber! },
        },
        deployKind,
        { id: row.id, version: row.version },
      )) as RecordedRelease;
    } catch (error) {
      // Only the deploy whose attempt failed claims the failure, atomically with it.
      await this.deliveryFailure(row, error, input.deployId);
      throw error;
    }
  }

  private async snapshot(row: IntentHandoff, branch: string, repoHash: string): Promise<HandoffSnapshot | null> {
    const workspace = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: row.workspaceId },
      select: { activeGraphVersionId: true },
    });
    if (!workspace.activeGraphVersionId) return null;
    return this.context.withContextByWorkspaceId(row.workspaceId, async (ctx) => {
      const [repo] = await ctx.repository.getRepoOverview([repoHash]);
      return repo?.gitCommitHash && ctx.versionId
        ? { repoKey: row.repoKey, branch, graphVersionId: ctx.versionId, graphCommit: repo.gitCommitHash }
        : null;
    });
  }

  private async map(row: IntentHandoff, snapshot: HandoffSnapshot) {
    const payload = handoffPayload(row);
    const done = new Set(
      handoffResults(row)
        .filter((r) => r.outcome !== 'unresolved')
        .map((r) => r.itemId),
    );
    const prepared = await this.anchors.prepare(
      row.workspaceId,
      snapshot,
      handoffEnvelope(row.headSha, { ...payload, bindings: payload.bindings.filter((b) => !done.has(b.itemId)) }),
    );
    await this.prisma.$transaction(
      async (tx) => {
        const current = await lockHandoff(tx, row.workspaceId, row.id, row.version);
        if (finished.has(current.mappingState)) return;
        const currentDone = handoffResults(current).filter((r) => r.outcome !== 'unresolved');
        const results = [
          ...currentDone,
          ...(await this.anchors.applyPrepared(
            tx,
            row.workspaceId,
            snapshot,
            prepared.filter((m) => !currentDone.some((r) => r.itemId === m.itemId)),
          )),
        ];
        const incomplete = results.some((r) => r.outcome === 'unresolved');
        await tx.intentHandoff.update({
          where: { id: row.id },
          data: {
            mappingState: incomplete ? 'needs_attention' : 'applied',
            mappingReason: incomplete ? 'unresolved_targets' : null,
            results: results as unknown as Prisma.InputJsonValue,
          },
        });
        const applied = new Set(results.filter((r) => r.outcome !== 'unresolved').map((r) => r.itemId));
        for (const id of [...payload.supersedesMappingIds].sort()) {
          await tx.$queryRaw`SELECT id FROM intent_handoffs WHERE id = ${id}::uuid AND workspace_id = ${row.workspaceId}::uuid FOR UPDATE`;
          const previous = await tx.intentHandoff.findFirst({
            where: { workspaceId: row.workspaceId, repoKey: row.repoKey, id },
          });
          if (!previous || finished.has(previous.mappingState)) continue;
          const previousDone = new Set(
            handoffResults(previous)
              .filter((r) => r.outcome !== 'unresolved')
              .map((r) => r.itemId),
          );
          if (handoffPayload(previous).bindings.every((b) => previousDone.has(b.itemId) || applied.has(b.itemId)))
            await tx.intentHandoff.update({
              where: { id },
              data: { mappingState: 'superseded', mappingReason: `successor:${row.id}` },
            });
        }
      },
      { timeout: 3000, maxWait: 1000 },
    );
  }

  private async deliver(
    row: IntentHandoff,
    override: 'manual' | 'merge' | 'deploy' | null,
    merge: string,
    mergedAt: string,
  ) {
    const payload = handoffPayload(row);
    const workspace = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: row.workspaceId },
      select: { intentReleaseTrigger: true },
    });
    const mode = resolveIntentReleaseTrigger(override, workspace.intentReleaseTrigger);
    if (!payload.delivers.length && !payload.retires.length) {
      await this.prisma.intentHandoff.updateMany({
        where: { id: row.id, version: row.version, deliveryState: { not: 'recorded' } },
        data: { deliveryState: 'recorded', deliveryReason: 'no_delivery_declarations' },
      });
      return;
    }
    if (mode !== 'merge') {
      await this.prisma.intentHandoff.updateMany({
        where: { id: row.id, version: row.version, deliveryState: 'pending' },
        data: { deliveryReason: mode === 'deploy' ? 'awaiting_production_deploy' : 'manual_delivery' },
      });
      return;
    }
    if (await this.hasEarlierMerge(row, new Date(mergedAt))) {
      await this.prisma.intentHandoff.updateMany({
        where: { id: row.id, version: row.version, deliveryState: 'pending' },
        data: { deliveryReason: 'awaiting_earlier_merge' },
      });
      return;
    }
    try {
      await this.releases.record(
        row.workspaceId,
        actor,
        {
          kind: 'release',
          repoKey: row.repoKey,
          deliveredRef: merge,
          deployId: merge,
          deployedAt: mergedAt,
          trailers: { delivers: payload.delivers, retires: payload.retires },
          pr: { repoKey: row.repoKey, number: row.prNumber! },
        },
        ReleaseActorKind.Connector,
        { id: row.id, version: row.version },
      );
      await this.prisma.intentHandoff.updateMany({
        where: { id: row.id, version: row.version },
        data: { deliveryState: 'recorded', deliveryReason: null },
      });
    } catch (error) {
      await this.deliveryFailure(row, error);
    }
  }

  private async hasEarlierMerge(row: IntentHandoff, mergedAt: Date): Promise<boolean> {
    // Queue order is not merge order. An open PR observed after this merge
    // cannot hide an earlier merge; an unobserved PR can. Check all pending
    // declarations for the repo, including those outside this worker batch.
    const others = await this.prisma.intentHandoff.findMany({
      where: {
        workspaceId: row.workspaceId,
        repoKey: row.repoKey,
        id: { not: row.id },
        prNumber: { not: null },
        deliveryState: 'pending',
      },
      select: { id: true, payload: true, mergedAt: true, prObservedAt: true },
    });
    // Ordering is per item (BR-6): only a PR that shares one of this row's items can
    // make this delivery late. Disjoint PRs of the repository proceed independently.
    const own = new Set(declaredItems(row));
    const blockers = others.filter((other) => {
      if (!declaredItems(other).some((itemId) => own.has(itemId))) return false;
      return other.mergedAt ? other.mergedAt < mergedAt : !other.prObservedAt || other.prObservedAt < mergedAt;
    });
    if (!blockers.length) return false;
    await this.prisma.intentHandoff.updateMany({
      // Pending attempts already have a due time (or an active worker claim).
      // Only wake work that has no scheduled attempt; never steal a live claim.
      where: { id: { in: blockers.map((other) => other.id) }, deliveryState: 'pending', nextAttemptAt: null },
      data: { nextAttemptAt: new Date() },
    });
    return true;
  }

  private async deliveryFailure(row: IntentHandoff, error: unknown, deployId?: string) {
    const sourceReason = sourceAttentionReason(error);
    const semantic =
      sourceReason || error instanceof ConflictException || !!(error as { publicError?: unknown })?.publicError;
    await this.prisma.intentHandoff.updateMany({
      where: { id: row.id, workspaceId: row.workspaceId, version: row.version, deliveryState: { not: 'recorded' } },
      data: {
        deliveryState: semantic ? 'needs_attention' : 'pending',
        deliveryReason: sourceReason ?? safeReason(error, 'delivery_retryable'),
        ...(deployId ? { deliveryDeployId: deployId } : {}),
      },
    });
  }

  private async pending(row: IntentHandoff, reason: string) {
    await this.mappingStatus(row, 'pending', reason);
    await this.prisma.intentHandoff.updateMany({
      where: { id: row.id, version: row.version, deliveryState: { notIn: ['recorded', 'discarded'] } },
      data: {
        deliveryState: 'pending',
        deliveryReason: reason,
        nextAttemptAt: reason === 'pr_not_attached' ? null : retryAt(),
      },
    });
  }
  private async attention(row: IntentHandoff, reason: string) {
    await this.mappingStatus(row, 'needs_attention', reason);
    await this.prisma.intentHandoff.updateMany({
      where: { id: row.id, version: row.version, deliveryState: { notIn: ['recorded', 'discarded'] } },
      data: { deliveryState: 'needs_attention', deliveryReason: reason, nextAttemptAt: null },
    });
  }
  private async mappingStatus(row: IntentHandoff, state: string, reason: string) {
    await this.prisma.intentHandoff.updateMany({
      where: {
        id: row.id,
        workspaceId: row.workspaceId,
        version: row.version,
        mappingState: { notIn: ['applied', 'discarded', 'superseded'] },
      },
      data: { mappingState: state, mappingReason: reason, nextAttemptAt: state === 'pending' ? retryAt() : null },
    });
  }
}

function declaredItems(row: Pick<IntentHandoff, 'payload'>): string[] {
  const payload = handoffPayload(row);
  return [...payload.delivers, ...payload.retires].map((ref) => ref.itemId);
}

function sourceAttentionReason(error: unknown): string | undefined {
  if (error instanceof GithubAuthError) return 'github_auth_required';
  if (error instanceof GithubApiError) {
    if (error.status === 403) return 'github_access_denied';
    if (error.status === 404 || error.status === 410) return 'github_source_unavailable';
    if (error.status === 400 || error.status === 422) return 'github_source_invalid';
  }
  const code = error instanceof Error ? error.message : '';
  if (
    [
      'repository_not_found',
      'repository_remote_missing',
      'repository_remote_invalid',
      'github_connector_unavailable',
      'github_repository_mismatch',
    ].includes(code)
  )
    return code;
  return undefined;
}

function safeReason(error: unknown, fallback: string): string {
  const code = (error as { publicError?: { code?: unknown } } | null)?.publicError?.code;
  if (typeof code === 'string' && /^[a-z][a-z0-9_]{1,100}$/.test(code)) return code;
  const message = error instanceof Error ? error.message : '';
  // Never persist provider URLs, credentials or arbitrary response bodies as user-visible state.
  return /^[a-z][a-z0-9_]{1,100}$/.test(message) ? message : fallback;
}
