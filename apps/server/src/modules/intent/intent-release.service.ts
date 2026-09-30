import { lockHandoff } from './intent-handoff.service.js';
import { resolveIntentReleaseTrigger } from './intent-release-trigger.js';
import { createHash } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { IntentReleaseTrigger, Prisma } from '../../generated/prisma/client.js';
import { IntentErrorCode } from './contract/index.js';
import {
  canonicalJson,
  hashIntentRequest,
  IntentOperation,
  runIntentMutation,
  type IntentActor,
  type IntentTransaction,
} from './intent-idempotency.js';
import {
  foldIntentReleases,
  ReleaseActorKind,
  type ReleaseEvent,
  type ReleasePr,
  type ReleaseSnapshot,
} from './intent-release.fold.js';
import {
  automaticIdempotencyKey,
  defaultReleaseReason,
  isAutomaticRecord,
  type AutomaticRecordIntentRelease,
  type HumanRecordIntentRelease,
  type ReleaseCommand,
  type ResolvedReleaseCommand,
} from './intent-release.operations.js';
import { intentConflict, intentNotFound, intentStateError } from './intent-state-errors.js';

type TrailerRef = { itemId: string; version: number };

type Reader = Pick<IntentTransaction, 'intentReleaseEvent'>;
export async function readReleaseSnapshot(reader: Reader, workspaceId: string): Promise<ReleaseSnapshot> {
  const events: ReleaseEvent[] = [];
  let after = 0;
  const head = await reader.intentReleaseEvent.findFirst({
    where: { workspaceId },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  });
  const through = head?.seq ?? 0;
  // Page durable history rather than loading replay responses and notes into context reads.
  for (;;) {
    const page = await reader.intentReleaseEvent.findMany({
      where: { workspaceId, seq: { gt: after, lte: through } },
      orderBy: { seq: 'asc' },
      take: 500,
      select: { seq: true, kind: true, recordedAt: true, recordedBy: true, data: true },
    });
    for (const row of page)
      events.push({
        ...row,
        kind: row.kind as ReleaseEvent['kind'],
        recordedAt: row.recordedAt.toISOString(),
        data: row.data as ReleaseEvent['data'],
      });
    if (page.length < 500) break;
    after = page.at(-1)?.seq as number;
  }
  return foldIntentReleases(events);
}

async function readReleaseAncestry(tx: IntentTransaction, workspaceId: string, origins: string[]) {
  if (!origins.length) return [];
  return tx.$queryRaw<Array<{ origin: string; id: string; predecessor: string | null }>>`
    WITH RECURSIVE chain AS (
      SELECT id AS origin, id, proposed_successor_of_id AS predecessor FROM intent_items
      WHERE workspace_id = ${workspaceId}::uuid AND id = ANY(${[...new Set(origins)]}::text[])
      UNION
      SELECT c.origin, i.id, i.proposed_successor_of_id FROM intent_items i JOIN chain c ON i.id = c.predecessor
      WHERE i.workspace_id = ${workspaceId}::uuid
    ) SELECT origin, id, predecessor FROM chain`;
}

/** Stored `applies_when`, or `undefined` when absent or empty. */
function conditionsOf(appliesWhen: unknown): unknown {
  return Array.isArray(appliesWhen) && appliesWhen.length > 0 ? appliesWhen : undefined;
}

export function releaseContentHash(item: {
  kind: string;
  title: string;
  statement: string;
  rationale: string | null;
  payload: unknown;
  appliesWhen?: unknown;
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        kind: item.kind,
        title: item.title,
        statement: item.statement,
        rationale: item.rationale,
        payload: item.payload,
        // Omitted (not null) when unconditioned, so pre-dimensions hashes stay valid (BR-8).
        appliesWhen: conditionsOf(item.appliesWhen),
      }),
    )
    .digest('hex');
}

/**
 * The one statement of "the trailer names a version that is no longer current".
 *
 * Run TWICE per automatic record, deliberately: once on the unlocked read (a cheap
 * refusal before any work), and once on the rows `validateEvent` holds FOR UPDATE —
 * a review that bumps an item between those two reads is exactly the race, and only
 * the locked read can refuse it truthfully.
 */
function assertTrailerVersions(refs: readonly TrailerRef[], versionOf: (itemId: string) => number | undefined): void {
  const stale = refs
    .filter((ref) => versionOf(ref.itemId) !== ref.version)
    .map((ref) => `${ref.itemId}@${ref.version} (current ${versionOf(ref.itemId)})`);
  if (stale.length > 0)
    throw intentConflict(
      IntentErrorCode.ReleaseVersionStale,
      `The trailers name version(s) that are no longer current: ${stale.join(', ')}`,
      ['trailers'],
    );
}

/**
 * Ordering of AUTOMATIC deliveries (amendment §3.2, decisions 5 and 6).
 *
 * The workspace row lock serialises writes; it does not order them. A record
 * step that lost its response and retries after a later deploy was recorded
 * would otherwise make the OLDER content current. The token is a property of
 * the deployment (`run_started_at`), so the retry carries R1's original token
 * and loses this comparison — which is the whole point.
 *
 * Ordering is per ITEM (BR-6): the candidate is refused only when one of its own
 * items already has a newer delivery in this repository (`latestTokenOf`). A PR
 * whose items no newer delivery touched records even when the repository has a
 * newer release — another PR is not an ordering fact about these items. Equal
 * tokens pass: one deploy ships several PRs with the same `deployedAt`.
 *
 * Returns the first refusing item and its newer token, or null when it may pass.
 */
export function releaseOrderingConflict(
  state: Pick<ReleaseSnapshot, 'latestTokenOf'>,
  repoKey: string,
  itemIds: readonly string[],
  orderingToken: string,
): { itemId: string; token: string } | null {
  for (const itemId of itemIds) {
    const token = state.latestTokenOf(repoKey, itemId);
    if (token && Date.parse(token) > Date.parse(orderingToken)) return { itemId, token };
  }
  return null;
}

function samePr(a: ReleasePr | undefined, b: ReleasePr | undefined): boolean {
  return a?.repoKey === b?.repoKey && a?.number === b?.number;
}

@Injectable()
export class IntentReleaseService {
  private readonly logger = new Logger(IntentReleaseService.name);
  constructor(private readonly prisma: PrismaService) {}

  async preview(workspaceId: string, itemId: string) {
    return (await this.previewMany(workspaceId, [itemId]))[0]!;
  }

  async previewMany(workspaceId: string, itemIds: string[]) {
    return this.prisma.$transaction(
      async (tx) => {
        const items = await tx.intentItem.findMany({
          where: { workspaceId, id: { in: itemIds } },
          include: {
            sources: {
              select: { kind: true, ref: true, localId: true, revision: true, locator: true, title: true, url: true },
              orderBy: { id: 'asc' },
            },
          },
        });
        if (items.length !== new Set(itemIds).size)
          throw intentNotFound(IntentErrorCode.ItemNotFound, 'The item does not exist in this workspace', ['itemId']);
        const state = await readReleaseSnapshot(tx, workspaceId);
        const ancestry = await readReleaseAncestry(tx, workspaceId, [...itemIds, ...state.effectiveIds]);
        const affected = await tx.intentItem.findMany({
          where: { workspaceId, id: { in: [...new Set(ancestry.map((row) => row.id))] } },
          select: { id: true, title: true },
        });
        const titles = new Map(affected.map((row) => [row.id, row.title]));
        const summaries = (ids: string[]) => ids.map((itemId) => ({ itemId, title: titles.get(itemId) ?? itemId }));
        const effective = new Set(state.effectiveIds);
        return itemIds.map((itemId) => {
          const item = items.find((item) => item.id === itemId)!;
          const ancestors = [
            ...new Set(
              ancestry
                .filter((row) => row.origin === itemId && row.predecessor !== null)
                .map((row) => row.predecessor as string),
            ),
          ].sort();
          const replacing = ancestors.filter((id) => state.effectivity(id) === 'effective');
          const blocking = [
            ...new Set(
              ancestry
                .filter((row) => row.origin !== itemId && effective.has(row.origin) && row.predecessor === itemId)
                .map((row) => row.origin),
            ),
          ].sort();

          return {
            itemId,
            deliveryImpact: { ancestors, replaces: summaries(replacing), blockingSuccessors: summaries(blocking) },
            authority: item.authority,
            version: item.version,
            contentHash: releaseContentHash(item),
            content: {
              kind: item.kind,
              title: item.title,
              statement: item.statement,
              rationale: item.rationale,
              payload: item.payload,
              appliesWhen: conditionsOf(item.appliesWhen),
            },
            effectivity: state.effectivity(itemId),
            planState: state.planState(itemId),
            sources: item.sources,
            headSeq: state.headSeq,
            currentRelease: state.currentRelease,
          };
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async list(workspaceId: string, query: { beforeSeq?: number; limit: number }) {
    return this.prisma.$transaction(
      async (tx) => {
        const state = await readReleaseSnapshot(tx, workspaceId);
        const rows = await tx.intentReleaseEvent.findMany({
          where: { workspaceId, ...(query.beforeSeq === undefined ? {} : { seq: { lt: query.beforeSeq } }) },
          orderBy: { seq: 'desc' },
          take: query.limit + 1,
          select: {
            seq: true,
            kind: true,
            deliveredRef: true,
            reason: true,
            recordedAt: true,
            recordedBy: true,
            data: true,
          },
        });
        const entries = rows.slice(0, query.limit).map((row) => ({
          ...row,
          recordedAt: row.recordedAt.toISOString(),
          rolledBack: state.rolledBack.has(row.seq),
        }));
        const entryIds = (entry: (typeof entries)[number]) => {
          const data = entry.data as ReleaseEvent['data'];
          return [
            ...(data.included ?? []),
            ...(data.retired ?? []),
            ...(data.ancestors ?? []),
            ...(data.itemId ? [data.itemId] : []),
          ];
        };
        const ids = [...new Set(entries.flatMap(entryIds))];
        const items = await tx.intentItem.findMany({
          where: { workspaceId, id: { in: ids } },
          select: { id: true, title: true },
        });
        const titles = Object.fromEntries(items.map((item) => [item.id, item.title]));
        return {
          entries: entries.map((entry) => {
            const { actorKind, orderingToken, pr } = entry.data as ReleaseEvent['data'];
            return {
              ...entry,
              // Delivery provenance lives on the payload; lifted to the entry so a
              // history view reads it without unpacking `data` (amendment §5).
              ...(actorKind ? { actorKind } : {}),
              ...(orderingToken ? { orderingToken } : {}),
              ...(pr ? { pr } : {}),
              titles: Object.fromEntries(
                entryIds(entry)
                  .filter((id) => titles[id] !== undefined)
                  .map((id) => [id, titles[id]]),
              ),
            };
          }),
          nextBeforeSeq: rows.length > query.limit ? entries.at(-1)?.seq : null,
          headSeq: state.headSeq,
          currentReleaseSeq: state.currentRelease?.seq ?? null,
          currentRelease: state.currentRelease,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /**
   * The ONLY machine path into the release ledger (amendment §4).
   *
   * A service token that holds `intent:release` records a delivery, and only
   * while the workspace runs the `deploy` trigger — the mode in which a CI step
   * after the production deploy is the declared actor. Baseline, rollback,
   * plan, withdraw and reinstate keep `UserSessionGuard` on their own routes
   * and are unreachable this way.
   *
   * The admissible body is the AUTOMATIC one, not merely `kind: 'release'`: the
   * maintainer's body defaults `kind` to `release` too, so gating on the kind
   * alone would let a CI token post `{ included, retired }` and bypass the
   * trailers, the version check and the per-repository ordering token.
   */
  async assertServiceTokenMayRecord(workspaceId: string, input: ReleaseCommand): Promise<void> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { intentReleaseTrigger: true },
    });
    if (isAutomaticRecord(input)) {
      const repo = await this.prisma.workspaceRepo.findFirst({
        where: { workspaceId, intentRepoKey: input.repoKey },
        select: { intentReleaseTrigger: true },
      });
      if (
        resolveIntentReleaseTrigger(repo?.intentReleaseTrigger, workspace?.intentReleaseTrigger) ===
        IntentReleaseTrigger.deploy
      )
        return;
    }
    throw intentStateError(
      IntentErrorCode.ReleaseModeForbids,
      "A service token records only a deployment (kind 'release' with PR trailers), and only while this repository's effective release trigger is 'deploy'",
      ['kind'],
      HttpStatus.FORBIDDEN,
    );
  }

  /**
   * Both actors write through THIS method. The automatic body is resolved into
   * the same command the maintainer sends (`included` with the hashes the
   * server itself computed, `retired`) and then runs the identical validation
   * and write path — a second write path is a second set of rules to keep in
   * agreement, which is how "conflicting items" and "ref recorded" would drift
   * apart between a human and a CI delivery.
   */
  async record(
    workspaceId: string,
    actor: IntentActor,
    input: ReleaseCommand,
    actorKind: ReleaseActorKind = ReleaseActorKind.Maintainer,
    handoff?: { id: string; version: number },
  ) {
    const automatic = isAutomaticRecord(input);
    const key = automatic ? automaticIdempotencyKey(input) : input.idempotencyKey;
    const reason = defaultReleaseReason(input);
    return runIntentMutation(
      this.prisma,
      {
        workspaceId,
        actor,
        operation: IntentOperation.ReleaseEvent,
        idempotencyKey: key,
        request: input,
        transaction: { timeout: 15_000, maxWait: 5_000 },
        // A deployment may predate its session handoff. Replaying the event must
        // attach that fact under the same locks as a new release, even on a cache hit.
        onReplay: handoff
          ? async (tx) => {
              await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId}::uuid FOR NO KEY UPDATE`;
              await lockHandoff(tx, workspaceId, handoff.id, handoff.version);
              await tx.intentHandoff.update({
                where: { id: handoff.id },
                data: { deliveryState: 'recorded', deliveryReason: null },
              });
            }
          : undefined,
      },
      async (tx) => {
        // Serializes even the first event. NO KEY UPDATE allows concurrent foreign-key checks by ordinary intent mutations.
        await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId}::uuid FOR NO KEY UPDATE`;
        if (handoff) await lockHandoff(tx, workspaceId, handoff.id, handoff.version);
        const requestHash = hashIntentRequest(IntentOperation.ReleaseEvent, input);
        const replay = await tx.intentReleaseEvent.findUnique({
          where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey: key } },
        });
        if (replay) {
          if (replay.requestHash !== requestHash)
            throw intentConflict(
              IntentErrorCode.IdempotencyRequestConflict,
              'This key was used for a different release request',
              ['idempotencyKey'],
            );
          if (handoff)
            await tx.intentHandoff.update({
              where: { id: handoff.id },
              data: { deliveryState: 'recorded', deliveryReason: null },
            });
          return { response: replay.response, audits: [] };
        }
        // Before BR-5 the automatic key had no PR. An event of THIS PR at this ref under
        // the old key is the same delivery: attach it rather than refuse the ref as recorded.
        const legacyKey = automatic && input.pr ? automaticIdempotencyKey({ ...input, pr: undefined }) : null;
        const legacy = legacyKey
          ? await tx.intentReleaseEvent.findUnique({
              where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey: legacyKey } },
            })
          : null;
        if (
          legacy &&
          automatic &&
          legacy.deliveredRef === input.deliveredRef &&
          samePr((legacy.data as ReleaseEvent['data']).pr, input.pr)
        ) {
          if (handoff)
            await tx.intentHandoff.update({
              where: { id: handoff.id },
              data: { deliveryState: 'recorded', deliveryReason: null },
            });
          return { response: legacy.response, audits: [] };
        }
        const state = await readReleaseSnapshot(tx, workspaceId);
        // A CI step cannot know the ledger head, so the automatic body carries
        // none: its ordering guarantee is the deployment token below.
        if (!automatic && input.expectedHeadSeq !== state.headSeq)
          throw intentConflict(
            IntentErrorCode.ReleaseOutOfOrder,
            `Expected head does not match current headSeq ${state.headSeq}`,
            ['expectedHeadSeq'],
          );
        const command: ResolvedReleaseCommand = automatic
          ? await this.resolveAutomaticRecord(tx, workspaceId, input, state, { key, reason })
          : input;
        const validated = await this.validateEvent(tx, workspaceId, command, state, automatic ? input : undefined);
        // AFTER the row locks `validateEvent` took: the trailer versions were first
        // compared against an unlocked read, so a concurrent review could bump an item
        // to v2 in between and let a release naming `@1` commit. Both sets are locked.
        if (automatic)
          await this.assertTrailerVersionsUnderLock(tx, workspaceId, [
            ...input.trailers.delivers,
            ...input.trailers.retires,
          ]);
        const data = {
          ...validated,
          // Every event, not only a delivery: the plan machine of a `merge`/`deploy`
          // workspace has to tell ITS OWN plans from a maintainer's roadmap plan before
          // it may withdraw one (amendment §3.1), and this is where that is written down.
          actorKind,
          // Plan-side provenance, same field a delivery carries.
          ...('pr' in command && command.pr ? { pr: command.pr } : {}),
          ...(automatic
            ? {
                repoKey: input.repoKey,
                deployId: input.deployId,
                // Verbatim: the server never substitutes its own clock here.
                orderingToken: input.deployedAt,
                ...(input.pr ? { pr: input.pr } : {}),
              }
            : {}),
        };
        const seq = state.headSeq + 1;
        const recordedAt = new Date();
        const event: ReleaseEvent = {
          seq,
          kind: command.kind,
          data,
          recordedBy: actor.id,
          recordedAt: recordedAt.toISOString(),
        };
        const next = foldIntentReleases([...state.events, event]);
        const response = {
          event: { ...event, reason },
          headSeq: seq,
          currentReleaseSeq: next.currentRelease?.seq ?? null,
          currentRelease: next.currentRelease,
        };
        await tx.intentReleaseEvent.create({
          data: {
            workspaceId,
            seq,
            kind: command.kind,
            idempotencyKey: key,
            requestHash,
            recordedBy: actor.id,
            recordedAt,
            reason,
            deliveredRef: 'deliveredRef' in command ? command.deliveredRef : null,
            data: data as Prisma.InputJsonValue,
            response: response as Prisma.InputJsonValue,
          },
        });
        if (handoff)
          await tx.intentHandoff.update({
            where: { id: handoff.id },
            data: { deliveryState: 'recorded', deliveryReason: null },
          });
        // The durable event is the audit; it commits alongside the common replay cache.
        return { response, audits: [] };
      },
    );
  }

  /**
   * Turn one deployment into the maintainer's own command shape.
   *
   * Order is deliberate: the repository gate first (a key outside the workspace
   * is refused before anything is read), then ordering (pure, and a late record
   * must write NOTHING), then the trailer ids. Every refusal here is
   * whole-record: a six-id trailer with one stale version records nothing.
   */
  private async resolveAutomaticRecord(
    tx: IntentTransaction,
    workspaceId: string,
    input: AutomaticRecordIntentRelease,
    state: ReleaseSnapshot,
    envelope: { key: string; reason: string },
  ): Promise<HumanRecordIntentRelease> {
    // Names the offending key ONLY. The seed path enumerates the workspace's
    // registered identities in its refusal; a CI token holds no read permission,
    // so it must not learn the repository inventory from an error message.
    const registered = await tx.workspaceRepo.findFirst({
      where: { workspaceId, intentRepoKey: input.repoKey },
      select: { id: true },
    });
    if (!registered)
      throw intentStateError(
        IntentErrorCode.UnknownRepoKey,
        `Repo key outside this workspace graph: ${input.repoKey}`,
        ['repoKey'],
        HttpStatus.BAD_REQUEST,
      );
    const refs = [...input.trailers.delivers, ...input.trailers.retires];
    // The fold also retires every predecessor of a delivered item, so those
    // ancestors take part in ordering too: a late successor must not overwrite a
    // newer delivery of the rule it replaces.
    const delivered = input.trailers.delivers.map((ref) => ref.itemId);
    const ancestry = delivered.length ? await readReleaseAncestry(tx, workspaceId, delivered) : [];
    const ancestors = ancestry
      .filter((row) => delivered.includes(row.origin) && row.predecessor !== null)
      .map((row) => row.predecessor as string);
    const conflict = releaseOrderingConflict(
      state,
      input.repoKey,
      [...new Set([...refs.map((ref) => ref.itemId), ...ancestors])],
      input.deployedAt,
    );
    if (conflict !== null) {
      this.logger.warn(
        `Out-of-order intent release refused: repo=${input.repoKey} deploy=${input.deployId} ref=${input.deliveredRef} ` +
          `pr=${input.pr ? `${input.pr.repoKey}#${input.pr.number}` : 'none'} item=${conflict.itemId} ` +
          `token=${input.deployedAt} currentToken=${conflict.token}`,
      );
      throw intentConflict(
        IntentErrorCode.ReleaseOutOfOrder,
        `A later delivery of ${conflict.itemId} in ${input.repoKey} is current: its ordering token ${conflict.token} is newer than ${input.deployedAt}`,
        ['deployedAt'],
      );
    }
    const rows = await tx.intentItem.findMany({
      where: { workspaceId, id: { in: refs.map((ref) => ref.itemId) } },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const unknown = refs.filter((ref) => !byId.has(ref.itemId)).map((ref) => ref.itemId);
    if (unknown.length > 0)
      throw intentNotFound(
        IntentErrorCode.ReleaseItemUnknown,
        `The trailers name item(s) this workspace does not hold: ${unknown.join(', ')}`,
        ['trailers'],
      );
    // The version the reviewer looked at, or nothing: a human decides whether
    // the delivered code still implements an item that changed after review.
    assertTrailerVersions(refs, (itemId) => byId.get(itemId)?.version);
    return {
      kind: 'release',
      idempotencyKey: envelope.key,
      expectedHeadSeq: state.headSeq,
      reason: envelope.reason,
      deliveredRef: input.deliveredRef,
      included: input.trailers.delivers.map((ref) => ({
        itemId: ref.itemId,
        contentHash: releaseContentHash(byId.get(ref.itemId)!),
      })),
      retired: input.trailers.retires.map((ref) => ref.itemId),
    };
  }

  /** Re-read the trailer items under the locks `validateEvent` holds, and refuse a version that moved. */
  private async assertTrailerVersionsUnderLock(
    tx: IntentTransaction,
    workspaceId: string,
    refs: readonly TrailerRef[],
  ): Promise<void> {
    const rows = await tx.intentItem.findMany({
      where: { workspaceId, id: { in: refs.map((ref) => ref.itemId) } },
      select: { id: true, version: true },
    });
    const current = new Map(rows.map((row) => [row.id, row.version]));
    assertTrailerVersions(refs, (itemId) => current.get(itemId));
  }

  private async validateEvent(
    tx: IntentTransaction,
    workspaceId: string,
    input: ResolvedReleaseCommand,
    state: ReleaseSnapshot,
    automatic?: AutomaticRecordIntentRelease,
  ): Promise<ReleaseEvent['data']> {
    if (input.kind === 'rollback') {
      if (!state.events.some((e) => e.seq === input.releaseSeq && (e.kind === 'release' || e.kind === 'baseline')))
        throw intentNotFound(IntentErrorCode.ReleaseNotFound, 'No such delivery in this workspace', ['releaseSeq']);
      if (state.currentRelease?.seq !== input.releaseSeq)
        throw intentConflict(
          IntentErrorCode.ReleaseNotCurrent,
          `Rollback must name currentReleaseSeq ${state.currentRelease?.seq ?? 'none'}`,
          ['releaseSeq'],
        );
      return { releaseSeq: input.releaseSeq };
    }
    if (input.kind === 'plan' || input.kind === 'withdraw' || input.kind === 'reinstate') {
      await tx.$queryRaw`SELECT id FROM intent_items WHERE workspace_id = ${workspaceId}::uuid AND id = ${input.itemId} FOR UPDATE`;
      const item = await tx.intentItem.findUnique({ where: { workspaceId_id: { workspaceId, id: input.itemId } } });
      if (!item) throw intentNotFound(IntentErrorCode.ItemNotFound, 'No such item in this workspace', ['itemId']);
      if (input.kind !== 'withdraw' && item.authority !== 'accepted')
        throw intentStateError(IntentErrorCode.PlanNotPlannable, 'Only an accepted item can be planned or reinstated', [
          'itemId',
        ]);
      if (input.kind === 'plan' && input.expectedVersion !== item.version)
        throw intentConflict(IntentErrorCode.VersionConflict, `Current item version is ${item.version}`, [
          'expectedVersion',
        ]);
      const plan = state.planState(item.id);
      if (input.kind === 'plan' && (plan !== 'none' || state.effectivity(item.id) === 'effective'))
        throw intentStateError(
          IntentErrorCode.PlanNotPlannable,
          'An effective or previously planned item cannot start a new plan',
          ['itemId'],
        );
      if (input.kind === 'withdraw' && plan !== 'active')
        throw intentStateError(IntentErrorCode.PlanNotActive, 'There is no active plan to withdraw', ['itemId']);
      if (input.kind === 'reinstate' && plan !== 'withdrawn')
        throw intentStateError(IntentErrorCode.PlanNotWithdrawn, 'There is no withdrawn plan to reinstate', ['itemId']);
      return { itemId: item.id };
    }
    const included = input.included.map((i) => i.itemId);
    const touched = [...included, ...input.retired];
    if (new Set(touched).size !== touched.length)
      throw intentStateError(
        IntentErrorCode.ReleaseConflictingItems,
        'Delivery items must be distinct, including across included and retired',
        ['included'],
      );
    // One deploy ref ships several PRs (BR-5): an automatic record is unique per (ref, PR);
    // a maintainer's record, which names no PR, keeps plain per-ref uniqueness and
    // also covers every later automatic record of that ref.
    const duplicate = state.events.some(
      (e) =>
        !state.rolledBack.has(e.seq) &&
        e.data.deliveredRef === input.deliveredRef &&
        (!automatic || !e.data.pr || samePr(e.data.pr, automatic.pr)),
    );
    if (duplicate)
      throw intentConflict(
        IntentErrorCode.ReleaseRefRecorded,
        automatic?.pr
          ? 'This deliveredRef already has a recorded delivery of this PR'
          : 'This deliveredRef already has a recorded delivery',
        ['deliveredRef'],
      );
    await tx.$queryRaw`SELECT id FROM intent_items WHERE workspace_id = ${workspaceId}::uuid AND id IN (${Prisma.join(touched)}) ORDER BY id FOR UPDATE`;
    const rows = await tx.intentItem.findMany({ where: { workspaceId, id: { in: touched } } });
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of touched)
      if (!byId.has(id))
        throw intentNotFound(IntentErrorCode.ItemNotFound, 'A delivery item does not exist in this workspace', [
          'included',
        ]);
    for (const ref of input.included) {
      const item = byId.get(ref.itemId)!;
      if (item.authority !== 'accepted' && item.authority !== 'superseded')
        throw intentStateError(
          IntentErrorCode.ReleaseItemNotReleasable,
          'Only reviewed accepted or superseded content can be delivered',
          ['included'],
        );
      if (releaseContentHash(item) !== ref.contentHash)
        throw intentConflict(IntentErrorCode.ReleaseContentMismatch, 'Delivered content differs from the preview', [
          'included',
        ]);
    }
    const ancestry = included.length
      ? await readReleaseAncestry(tx, workspaceId, [...included, ...state.effectiveIds])
      : [];
    const includedSet = new Set(included);
    const ancestors = new Set(
      ancestry
        .filter((row) => includedSet.has(row.origin))
        .map((row) => row.predecessor)
        .filter((id): id is string => id !== null),
    );
    // A fresh delivery of an older revision must explicitly retire its live successor.
    // Otherwise the delta would assert two mutually replacing rules are both effective.
    if (
      ancestry.some(
        (row) =>
          !includedSet.has(row.origin) &&
          !input.retired.includes(row.origin) &&
          row.predecessor !== null &&
          includedSet.has(row.predecessor),
      )
    ) {
      throw intentStateError(
        IntentErrorCode.ReleaseConflictingItems,
        'Restoring an older revision must retire its currently effective successor',
        ['retired'],
      );
    }
    if (included.some((id) => ancestors.has(id)))
      throw intentStateError(
        IntentErrorCode.ReleaseConflictingItems,
        'One delivery cannot include multiple revisions in the same supersession chain',
        ['included'],
      );
    return {
      deliveredRef: input.deliveredRef,
      included,
      retired: input.retired,
      ancestors: [...ancestors].sort(),
      // Hashes are kept in the durable event as evidence, not recomputed on history reads.
      contentHashes: Object.fromEntries(input.included.map((ref) => [ref.itemId, ref.contentHash])),
    };
  }
}
