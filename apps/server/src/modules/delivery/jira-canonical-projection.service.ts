import { createHash } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { type CanonicalStatusPolicy, StatusMapService } from './status-map.service.js';
import { isUniqueViolation } from '../../libs/coerce.js';

const UNIQUE_RACE_RETRY_LIMIT = 1;
const REPROJECT_BATCH_SIZE = 100;
const JIRA_PROVIDER = 'jira';
/** Matches the `delivery_tasks.title` column width. */
const TASK_TITLE_CHARS = 512;
/**
 * Truncate to TASK_TITLE_CHARS *code points*, never mid-surrogate-pair.
 *
 * `String.slice` counts UTF-16 units, so a summary with an emoji straddling the boundary
 * would be cut into a lone surrogate — invalid UTF-8 that Postgres rejects INSIDE the
 * projection transaction, turning a single emoji-titled issue into a watermark-gated
 * poison pill that replays forever. Postgres counts VARCHAR(512) in characters, so code
 * points are also the right unit for the cap. (github-canonical-projection.service keeps
 * its own copy: the two projectors share no runtime module.)
 */
function truncateTitle(value: string): string {
  const points = Array.from(value);
  return points.length <= TASK_TITLE_CHARS ? value : points.slice(0, TASK_TITLE_CHARS).join('');
}

const TRANSITION_KEY_PREFIX = 'jira-transition:';
const TERMINAL_LIFECYCLES = new Set<CanonicalLifecycle>(['completed', 'abandoned']);

type CanonicalLifecycle = 'active' | 'completed' | 'abandoned';

export interface JiraCanonicalTransition {
  sourceRef: string;
  fromState: string | null;
  toState: string;
  occurredAt: Date;
  actorId: string | null;
}

export interface JiraCanonicalProjectionInput {
  workspaceId: string;
  connectorId: string;
  taskId: string;
  externalRefId: bigint;
  /** Normalized Jira summary; absent when the issue carries none. */
  title?: string | null;
  currentState: string | null;
  sourceUpdatedAt: Date;
  observedAt: Date;
  transitions: JiraCanonicalTransition[];
}

export interface JiraCanonicalProjectionResult {
  stateFacts: number;
  lifecycleChanged: boolean;
  shipEvidence: number;
  reworkSignals: number;
}

interface ProjectionTask {
  id: string;
  lifecycle: string;
  authority: string;
  authorityRefId: bigint | null;
  title: string | null;
}

interface ProjectionRef {
  id: bigint;
  deliveryTaskId: string;
  provider: string;
  externalId: string;
  externalState: string | null;
  connectorId: string | null;
  sourceUpdatedAt: Date | null;
  lastObservedAt: Date | null;
}

interface ProjectionFact {
  id: bigint;
  externalRefId: bigint;
  sourceRef: string;
  fromState: string | null;
  toState: string;
  occurredAt: Date;
  sourceUpdatedAt: Date;
  receivedAt: Date;
  actorId: string | null;
}

function conflict(code: string, message: string): never {
  throw new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code,
    message,
  });
}

function assertResolvedAuthority(task: ProjectionTask): void {
  if (task.authorityRefId === null && task.authority !== 'coredoc') {
    conflict('TASK_AUTHORITY_MIGRATION_REQUIRED', 'Canonical task authority requires exact administrator repair');
  }
}

function sameInstant(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    conflict('TASK_STATE_FACT_CONFLICT', `${label} must be a valid timestamp`);
  }
}

function assertSameFact(established: ProjectionFact, incoming: JiraCanonicalTransition): void {
  if (
    established.fromState !== incoming.fromState ||
    established.toState !== incoming.toState ||
    !sameInstant(established.occurredAt, incoming.occurredAt) ||
    !sameInstant(established.sourceUpdatedAt, incoming.occurredAt) ||
    established.actorId !== incoming.actorId
  ) {
    conflict('TASK_STATE_FACT_CONFLICT', 'Jira transition replay contradicts an established state fact');
  }
}

function normalizeState(value: string): string {
  return value.toLowerCase();
}

/**
 * Namespace and hash the provider occurrence identity. Jira history IDs are not
 * globally unique and are provider-controlled strings. Provider plus immutable
 * external issue identity disambiguate them without depending on the connector or
 * surrogate ref row, both of which can change across a supported detach/reattach.
 * The stored key is fixed-width and never carries provider content into bounded
 * diagnostics.
 */
function transitionKey(workspaceId: string, provider: string, externalId: string, providerSourceRef: string): string {
  const digest = createHash('sha256');
  for (const part of [workspaceId, provider, externalId, providerSourceRef]) {
    const bytes = Buffer.from(part, 'utf8');
    digest.update(String(bytes.byteLength));
    digest.update(':');
    digest.update(bytes);
    digest.update(';');
  }
  return `${TRANSITION_KEY_PREFIX}${digest.digest('hex')}`;
}

function compareTransitions(left: JiraCanonicalTransition, right: JiraCanonicalTransition): number {
  return left.occurredAt.getTime() - right.occurredAt.getTime() || left.sourceRef.localeCompare(right.sourceRef);
}

function compareFacts(left: ProjectionFact, right: ProjectionFact): number {
  return left.occurredAt.getTime() - right.occurredAt.getTime() || left.sourceRef.localeCompare(right.sourceRef);
}

@Injectable()
export class JiraCanonicalProjectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly statusMaps: StatusMapService,
  ) {}

  private async transactionWithConcurrentFirstWriteRetry<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation);
      } catch (error) {
        if (!isUniqueViolation(error) || attempt >= UNIQUE_RACE_RETRY_LIMIT) throw error;
      }
    }
  }

  private async lockConnectorForProjection(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    connectorId: string,
  ): Promise<void> {
    // Serialize with admin policy edits so no projection can commit facts derived
    // from an older status map after the edit has completed.
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "delivery_connectors"
      WHERE "workspace_id" = ${workspaceId}::uuid
        AND "id" = ${connectorId}::uuid
      FOR SHARE
    `;
  }

  async projectIssue(input: JiraCanonicalProjectionInput): Promise<JiraCanonicalProjectionResult> {
    assertValidDate(input.sourceUpdatedAt, 'sourceUpdatedAt');
    assertValidDate(input.observedAt, 'observedAt');
    for (const transition of input.transitions) {
      assertValidDate(transition.occurredAt, 'transition.occurredAt');
      if (transition.sourceRef.length === 0 || transition.toState.length === 0) {
        conflict('TASK_STATE_FACT_CONFLICT', 'Jira transition requires a source identity and destination state');
      }
    }

    return this.transactionWithConcurrentFirstWriteRetry(async (tx) => {
      await this.lockConnectorForProjection(tx, input.workspaceId, input.connectorId);
      const statusMap = await this.statusMaps.getCanonicalMap(input.workspaceId, input.connectorId, tx);
      const { task, ref } = await this.loadExactProjectionTarget(tx, input);
      assertResolvedAuthority(task);
      const establishedFreshness = ref.sourceUpdatedAt?.getTime();
      const incomingFreshness = input.sourceUpdatedAt.getTime();
      if (establishedFreshness !== undefined && incomingFreshness < establishedFreshness) {
        return { stateFacts: 0, lifecycleChanged: false, shipEvidence: 0, reworkSignals: 0 };
      }
      if (establishedFreshness === undefined || incomingFreshness !== establishedFreshness) {
        conflict(
          'TASK_STATE_FACT_CONFLICT',
          'Jira canonical projection must follow the matching external-ref freshness update',
        );
      }

      const facts: ProjectionFact[] = [];
      let stateFacts = 0;
      for (const transition of [...input.transitions].sort(compareTransitions)) {
        const persisted = await this.persistStateFact(tx, input, ref, transition);
        facts.push(persisted.fact);
        if (persisted.created) stateFacts += 1;
      }

      if (task.authorityRefId !== ref.id) {
        return { stateFacts, lifecycleChanged: false, shipEvidence: 0, reworkSignals: 0 };
      }

      await this.stampAuthorityTitle(tx, input.workspaceId, task, input.title);

      const derived = await this.projectAuthoritativeFacts(tx, {
        workspaceId: input.workspaceId,
        task,
        ref,
        currentState: input.currentState,
        facts,
        statusMap,
      });
      return { stateFacts, ...derived };
    });
  }

  async reprojectConnector(
    workspaceId: string,
    connectorId: string,
  ): Promise<{ externalRefs: number; lifecycleChanges: number; shipEvidence: number; reworkSignals: number }> {
    const totals = { externalRefs: 0, lifecycleChanges: 0, shipEvidence: 0, reworkSignals: 0 };
    let afterId: bigint | undefined;

    for (;;) {
      // Keep each replay transaction bounded; the writes are append-only/idempotent,
      // so completed batches remain valid if a later batch has to be retried.
      const batch = await this.transactionWithConcurrentFirstWriteRetry(async (tx) => {
        await this.lockConnectorForProjection(tx, workspaceId, connectorId);
        const statusMap = await this.statusMaps.getCanonicalMap(workspaceId, connectorId, tx);
        const refs = await tx.taskExternalRef.findMany({
          where: {
            workspaceId,
            connectorId,
            provider: JIRA_PROVIDER,
            ...(afterId !== undefined ? { id: { gt: afterId } } : {}),
          },
          orderBy: { id: 'asc' },
          take: REPROJECT_BATCH_SIZE,
          select: {
            id: true,
            deliveryTaskId: true,
            provider: true,
            externalId: true,
            externalState: true,
            connectorId: true,
            sourceUpdatedAt: true,
            lastObservedAt: true,
          },
        });
        let lifecycleChanges = 0;
        let shipEvidence = 0;
        let reworkSignals = 0;

        for (const ref of refs) {
          const task = await tx.deliveryTask.findUnique({
            where: { workspaceId_id: { workspaceId, id: ref.deliveryTaskId } },
            select: { id: true, lifecycle: true, authority: true, authorityRefId: true, title: true },
          });
          if (!task) continue;
          assertResolvedAuthority(task);
          if (task.authorityRefId !== ref.id) continue;

          const facts = await tx.taskExternalRefStateFact.findMany({
            where: { workspaceId, externalRefId: ref.id },
            orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              externalRefId: true,
              sourceRef: true,
              fromState: true,
              toState: true,
              occurredAt: true,
              sourceUpdatedAt: true,
              receivedAt: true,
              actorId: true,
            },
          });
          const derived = await this.projectAuthoritativeFacts(tx, {
            workspaceId,
            task,
            ref,
            currentState: ref.externalState,
            facts,
            statusMap,
          });
          if (derived.lifecycleChanged) lifecycleChanges += 1;
          shipEvidence += derived.shipEvidence;
          reworkSignals += derived.reworkSignals;
        }

        return {
          externalRefs: refs.length,
          lifecycleChanges,
          shipEvidence,
          reworkSignals,
          lastId: refs.at(-1)?.id,
        };
      });

      totals.externalRefs += batch.externalRefs;
      totals.lifecycleChanges += batch.lifecycleChanges;
      totals.shipEvidence += batch.shipEvidence;
      totals.reworkSignals += batch.reworkSignals;
      if (batch.externalRefs < REPROJECT_BATCH_SIZE || batch.lastId === undefined) return totals;
      afterId = batch.lastId;
    }
  }

  private async loadExactProjectionTarget(
    tx: Prisma.TransactionClient,
    input: JiraCanonicalProjectionInput,
  ): Promise<{ task: ProjectionTask; ref: ProjectionRef }> {
    const ref = await tx.taskExternalRef.findFirst({
      where: {
        workspaceId: input.workspaceId,
        id: input.externalRefId,
        deliveryTaskId: input.taskId,
        connectorId: input.connectorId,
        provider: JIRA_PROVIDER,
      },
      select: {
        id: true,
        deliveryTaskId: true,
        provider: true,
        externalId: true,
        externalState: true,
        connectorId: true,
        sourceUpdatedAt: true,
        lastObservedAt: true,
      },
    });
    if (!ref) throw new NotFoundException('Canonical Jira projection target not found');

    const task = await tx.deliveryTask.findUnique({
      where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.taskId } },
      select: { id: true, lifecycle: true, authority: true, authorityRefId: true, title: true },
    });
    if (!task) throw new NotFoundException('Canonical Jira projection target not found');
    return { task, ref };
  }

  private async persistStateFact(
    tx: Prisma.TransactionClient,
    input: JiraCanonicalProjectionInput,
    ref: ProjectionRef,
    transition: JiraCanonicalTransition,
  ): Promise<{ fact: ProjectionFact; created: boolean }> {
    const sourceRef = transitionKey(input.workspaceId, ref.provider, ref.externalId, transition.sourceRef);
    const where = {
      workspaceId_externalRefId_sourceRef: {
        workspaceId: input.workspaceId,
        externalRefId: input.externalRefId,
        sourceRef,
      },
    };
    const established = await tx.taskExternalRefStateFact.findUnique({
      where,
      select: {
        id: true,
        externalRefId: true,
        sourceRef: true,
        fromState: true,
        toState: true,
        occurredAt: true,
        sourceUpdatedAt: true,
        receivedAt: true,
        actorId: true,
      },
    });
    if (established) {
      assertSameFact(established, transition);
      return { fact: established, created: false };
    }

    const fact = await tx.taskExternalRefStateFact.create({
      data: {
        workspaceId: input.workspaceId,
        externalRefId: input.externalRefId,
        sourceRef,
        fromState: transition.fromState,
        toState: transition.toState,
        occurredAt: transition.occurredAt,
        sourceUpdatedAt: transition.occurredAt,
        receivedAt: input.observedAt,
        actorId: transition.actorId,
      },
      select: {
        id: true,
        externalRefId: true,
        sourceRef: true,
        fromState: true,
        toState: true,
        occurredAt: true,
        sourceUpdatedAt: true,
        receivedAt: true,
        actorId: true,
      },
    });
    return { fact, created: true };
  }

  /**
   * Jira is the authority for the task name, so the title is re-stamped on every
   * projection pass over the authority ref: a later summary edit overwrites it, and
   * it wins over a fallback title derived from a pull request. Stamping is
   * forward-only — issues last ingested before the column existed gain a title on
   * their next ingest, never through a renormalize backfill.
   */
  private async stampAuthorityTitle(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    task: ProjectionTask,
    incoming: string | null | undefined,
  ): Promise<void> {
    const title = incoming === null || incoming === undefined ? undefined : truncateTitle(incoming);
    // A pass without a summary carries no authority claim about the name, so an
    // established title survives rather than being blanked.
    if (title === undefined || title.length === 0 || title === task.title) return;

    await tx.deliveryTask.update({
      where: { workspaceId_id: { workspaceId, id: task.id } },
      data: { title },
      select: { id: true },
    });
    task.title = title;
  }

  private async projectAuthoritativeFacts(
    tx: Prisma.TransactionClient,
    input: {
      workspaceId: string;
      task: ProjectionTask;
      ref: ProjectionRef;
      currentState: string | null;
      facts: ProjectionFact[];
      statusMap: Map<string, CanonicalStatusPolicy>;
    },
  ): Promise<Omit<JiraCanonicalProjectionResult, 'stateFacts'>> {
    let lifecycleChanged = false;
    const currentMapping =
      input.currentState === null ? undefined : input.statusMap.get(normalizeState(input.currentState));
    if (currentMapping?.lifecycle && currentMapping.lifecycle !== input.task.lifecycle) {
      await tx.deliveryTask.update({
        where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.task.id } },
        data: { lifecycle: currentMapping.lifecycle },
        select: { id: true },
      });
      input.task.lifecycle = currentMapping.lifecycle;
      lifecycleChanged = true;
    }

    let shipEvidence = 0;
    let reworkSignals = 0;
    for (const fact of [...input.facts].sort(compareFacts)) {
      const fromLifecycle =
        fact.fromState === null ? null : (input.statusMap.get(normalizeState(fact.fromState))?.lifecycle ?? null);
      const toMapping = input.statusMap.get(normalizeState(fact.toState));
      if (toMapping?.createsShipEvidence) {
        if (await this.persistShipEvidence(tx, input.workspaceId, input.task.id, input.ref, fact)) {
          shipEvidence += 1;
        }
      }
      if (fromLifecycle !== null && TERMINAL_LIFECYCLES.has(fromLifecycle) && toMapping?.lifecycle === 'active') {
        if (await this.persistReopenSignal(tx, input.workspaceId, input.task.id, fact)) {
          reworkSignals += 1;
        }
      }
    }
    return { lifecycleChanged, shipEvidence, reworkSignals };
  }

  private async persistShipEvidence(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    taskId: string,
    ref: ProjectionRef,
    fact: ProjectionFact,
  ): Promise<boolean> {
    const where = {
      workspaceId_source_sourceKey: {
        workspaceId,
        source: 'connector_transition',
        sourceKey: fact.sourceRef,
      },
    };
    const established = await tx.deliveryShipEvidence.findUnique({
      where,
      select: {
        deliveryTaskId: true,
        occurredAt: true,
        actorId: true,
        provider: true,
        repoExternalId: true,
        externalId: true,
      },
    });
    if (established) {
      if (
        established.deliveryTaskId !== taskId ||
        !sameInstant(established.occurredAt, fact.occurredAt) ||
        established.actorId !== fact.actorId ||
        established.provider !== JIRA_PROVIDER ||
        established.repoExternalId !== null ||
        established.externalId !== ref.externalId
      ) {
        conflict('SHIP_EVIDENCE_CONFLICT', 'Jira transition contradicts established ship evidence');
      }
      return false;
    }

    await tx.deliveryShipEvidence.create({
      data: {
        workspaceId,
        deliveryTaskId: taskId,
        source: 'connector_transition',
        sourceKey: fact.sourceRef,
        occurredAt: fact.occurredAt,
        receivedAt: fact.receivedAt,
        actorId: fact.actorId,
        provider: JIRA_PROVIDER,
        repoExternalId: null,
        externalId: ref.externalId,
      },
      select: { id: true },
    });
    return true;
  }

  private async persistReopenSignal(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    taskId: string,
    fact: ProjectionFact,
  ): Promise<boolean> {
    const where = {
      workspaceId_kind_sourceKey: {
        workspaceId,
        kind: 'tracker_reopened',
        sourceKey: fact.sourceRef,
      },
    };
    const established = await tx.deliveryReworkSignal.findUnique({
      where,
      select: { deliveryTaskId: true, sourceRef: true, occurredAt: true },
    });
    if (established) {
      if (
        established.deliveryTaskId !== taskId ||
        established.sourceRef !== fact.sourceRef ||
        !sameInstant(established.occurredAt, fact.occurredAt)
      ) {
        conflict('REWORK_SIGNAL_CONFLICT', 'Jira transition contradicts an established reopen signal');
      }
      return false;
    }

    await tx.deliveryReworkSignal.create({
      data: {
        workspaceId,
        deliveryTaskId: taskId,
        kind: 'tracker_reopened',
        sourceKey: fact.sourceRef,
        sourceRef: fact.sourceRef,
        occurredAt: fact.occurredAt,
        observedAt: fact.receivedAt,
      },
      select: { id: true },
    });
    return true;
  }
}
