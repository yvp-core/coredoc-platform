import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { canonicalIntentJson } from '@coredoc/core';
import type { AuthUser } from '../../auth/decorators/current-user.decorator.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  lockWorkspaceRepositoryIdentity,
  WORKSPACE_REPOSITORY_TRANSACTION_OPTIONS,
} from '../../database/workspace-repository-lock.js';
import { Prisma, type WorkflowStageOccurrence } from '../../generated/prisma/client.js';
import {
  captureBatchItems,
  type CaptureHealthCode,
  type CaptureProvisioningRecordV1,
  type CaptureProvisioningReportV1,
  type CaptureProvisioningState,
  type CaptureRepositoryBindingV1,
  type CaptureEvent,
  type CaptureReceiptV1,
  type DeclaredStageV2,
  rejectionEventId,
  UnsupportedCaptureSchemaVersionError,
  validateCaptureRepositoryBinding,
  validateCaptureProvisioningReport,
  validateCaptureEvent,
} from './capture-contract.js';
import { isUniqueViolation } from '../../libs/coerce.js';

class ContradictingFactError extends Error {}
class OutOfWorkspaceRepositoryError extends Error {}

const UNIQUE_RACE_RETRY_LIMIT = 1;
const GIT_PROTOCOLS = new Set(['http:', 'https:', 'ssh:', 'git:', 'git+ssh:']);

type CaptureProvisioningRow = {
  actorId: string;
  host: string;
  targetKey: string;
  repositoryKey: string | null;
  state: string;
  pendingCount: number;
  errorCode: string | null;
  attributionPendingCount: number;
  attributionRejectedCount: number;
  attributionLastClaimAt: Date | null;
  configuredAt: Date | null;
  disabledAt: Date | null;
  reportedAt: Date;
};

/** Normalize only server-trusted Git URLs to the existing host-free capture key. */
function normalizeTrustedRepositoryUrl(origin: string): string | null {
  const input = origin.trim();
  if (!input) return null;

  let candidate = input;
  const scp = !/^[a-z+]+:\/\//i.test(input) && input.match(/^[^@]+@[^:]+:(.+)$/);
  if (scp) {
    candidate = scp[1];
  } else if (/^[a-z+]+:\/\//i.test(input)) {
    try {
      const parsed = new URL(input);
      if (!GIT_PROTOCOLS.has(parsed.protocol) || !parsed.hostname || parsed.password || parsed.search || parsed.hash) {
        return null;
      }
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.username) return null;
      candidate = parsed.pathname.replace(/^\/+/, '');
    } catch {
      // intentional: an unparseable remote is simply not a repository key —
      // the caller records the capture without one and reports it.
      return null;
    }
  }

  candidate = candidate.replace(/\.git$/, '');
  try {
    return validateCaptureRepositoryBinding({ repositoryKey: candidate }).repositoryKey;
  } catch {
    // intentional: a remote that fails the binding contract yields no key. The
    // validator's message describes the caller's input, not a server fault.
    return null;
  }
}

function assertSame(label: string, established: unknown, incoming: unknown): void {
  if (established === null || established === undefined || incoming === undefined) return;
  const left = established instanceof Date ? established.toISOString() : established;
  const right = incoming instanceof Date ? incoming.toISOString() : incoming;
  if (left !== right) throw new ContradictingFactError(`${label} contradicts an established fact`);
}

function assertSameJson(label: string, established: unknown, incoming: unknown): void {
  if (established === null || established === undefined || incoming === undefined) return;
  if (canonicalIntentJson(established) !== canonicalIntentJson(incoming)) {
    throw new ContradictingFactError(`${label} contradicts an established fact`);
  }
}

@Injectable()
export class CaptureService {
  constructor(private readonly prisma: PrismaService) {}

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

  async bindRepository(
    workspaceId: string,
    repoKey: string,
    body: unknown,
  ): Promise<{ repoKey: string; captureRepositoryKey: string | null }> {
    let binding: CaptureRepositoryBindingV1;
    try {
      binding = validateCaptureRepositoryBinding(body);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid capture repository binding');
    }

    try {
      const [bound] = await this.prisma.workspaceRepo.updateManyAndReturn({
        where: {
          workspaceId,
          repoKey,
          OR: [{ captureRepositoryKey: null }, { captureRepositoryKey: binding.repositoryKey }],
        },
        data: { captureRepositoryKey: binding.repositoryKey },
        select: { repoKey: true, captureRepositoryKey: true },
      });
      if (bound) return bound;

      const established = await this.prisma.workspaceRepo.findUnique({
        where: { workspaceId_repoKey: { workspaceId, repoKey } },
        select: { repoKey: true, captureRepositoryKey: true },
      });
      if (!established) throw new NotFoundException('Repository is not connected to this workspace');
      if (established.captureRepositoryKey === binding.repositoryKey) return established;
      throw new ConflictException('Capture repository binding conflicts with the established repository identity');
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ConflictException) throw error;
      if (isUniqueViolation(error)) {
        throw new ConflictException('Capture repository key is already bound in this workspace');
      }
      throw error;
    }
  }

  async resolveRepository(
    workspaceId: string,
    body: unknown,
  ): Promise<{ status: 'resolved'; repositoryKey: string } | { status: 'unregistered' }> {
    let repositoryKey: string;
    try {
      repositoryKey = validateCaptureRepositoryBinding(body).repositoryKey;
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid capture repository identity');
    }

    try {
      return await this.prisma.$transaction(async (transaction) => {
        await lockWorkspaceRepositoryIdentity(transaction, workspaceId);

        // Re-read the complete trusted match set only after acquiring the same
        // lock used by repository connect/update/disconnect.
        const repositories = await transaction.workspaceRepo.findMany({
          where: { workspaceId, gitUrl: { not: null } },
          select: { id: true, gitUrl: true, captureRepositoryKey: true },
        });
        const matches = repositories.filter(
          (repository) =>
            typeof repository.gitUrl === 'string' && normalizeTrustedRepositoryUrl(repository.gitUrl) === repositoryKey,
        );
        if (matches.length === 0) return { status: 'unregistered' as const };
        if (matches.length > 1) {
          throw new ConflictException('Repository identity is ambiguous in this workspace');
        }

        const repository = matches[0];
        if (repository.captureRepositoryKey !== null && repository.captureRepositoryKey !== repositoryKey) {
          throw new ConflictException('Repository identity conflicts with the established capture binding');
        }
        if (repository.captureRepositoryKey === repositoryKey) {
          return { status: 'resolved' as const, repositoryKey };
        }

        const [bound] = await transaction.workspaceRepo.updateManyAndReturn({
          where: {
            id: repository.id,
            workspaceId,
            gitUrl: repository.gitUrl,
            OR: [{ captureRepositoryKey: null }, { captureRepositoryKey: repositoryKey }],
          },
          data: { captureRepositoryKey: repositoryKey },
          select: { captureRepositoryKey: true },
        });
        if (bound?.captureRepositoryKey === repositoryKey) {
          return { status: 'resolved' as const, repositoryKey };
        }

        const established = await transaction.workspaceRepo.findUnique({
          where: { id: repository.id },
          select: { gitUrl: true, captureRepositoryKey: true },
        });
        if (established?.gitUrl === repository.gitUrl && established.captureRepositoryKey === repositoryKey) {
          return { status: 'resolved' as const, repositoryKey };
        }
        throw new ConflictException('Repository identity conflicts with the established capture binding');
      }, WORKSPACE_REPOSITORY_TRANSACTION_OPTIONS);
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      if (isUniqueViolation(error)) {
        throw new ConflictException('Repository identity is already bound in this workspace');
      }
      throw error;
    }
  }

  async reportProvisioning(workspaceId: string, actorId: string, body: unknown): Promise<CaptureProvisioningRecordV1> {
    let report: CaptureProvisioningReportV1;
    try {
      report = validateCaptureProvisioningReport(body);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid capture provisioning report');
    }

    const targetKey =
      report.host === 'codex'
        ? `repo:${report.target.repoKey}:profile:${'profileName' in report.target ? (report.target.profileName ?? 'base') : 'base'}`
        : `repo:${report.target.repoKey}`;
    if (targetKey.length > 256) throw new BadRequestException('Capture provisioning target is too long');
    const repositoryKey = report.target.repositoryKey;

    const repository = await this.prisma.workspaceRepo.findFirst({
      where: {
        workspaceId,
        repoKey: report.target.repoKey,
        captureRepositoryKey: report.target.repositoryKey,
      },
      select: { id: true },
    });
    if (!repository) throw new BadRequestException('Capture repository binding does not match this workspace');

    const reportedAt = new Date();
    // Timestamp transitions must share the row lock acquired by ON CONFLICT; a
    // read followed by an upsert can reset the first transition under overlap.
    const rows = await this.prisma.$queryRaw<CaptureProvisioningRow[]>`
      INSERT INTO capture_provisioning (
        workspace_id,
        actor_id,
        host,
        target_key,
        repository_key,
        state,
        configured_at,
        disabled_at,
        reported_at,
        pending_count,
        error_code
        , attribution_pending_count
        , attribution_rejected_count
        , attribution_last_claim_at
      ) VALUES (
        ${workspaceId}::uuid,
        ${actorId},
        ${report.host},
        ${targetKey},
        ${repositoryKey},
        ${report.state},
        CASE WHEN ${report.state} = 'configured' THEN ${reportedAt}::timestamptz ELSE NULL END,
        CASE WHEN ${report.state} = 'disabled' THEN ${reportedAt}::timestamptz ELSE NULL END,
        ${reportedAt},
        ${report.pendingCount},
        ${report.errorCode}
        , ${report.attributionPendingCount}
        , ${report.attributionRejectedCount}
        , ${report.attributionLastClaimAt ? new Date(report.attributionLastClaimAt) : null}::timestamptz
      )
      ON CONFLICT (workspace_id, actor_id, host, target_key) DO UPDATE SET
        repository_key = EXCLUDED.repository_key,
        state = EXCLUDED.state,
        configured_at = CASE
          WHEN EXCLUDED.state = 'configured' AND capture_provisioning.state <> 'configured'
            THEN EXCLUDED.reported_at
          WHEN EXCLUDED.state = 'configured'
            THEN COALESCE(capture_provisioning.configured_at, EXCLUDED.reported_at)
          ELSE capture_provisioning.configured_at
        END,
        disabled_at = CASE
          WHEN EXCLUDED.state = 'disabled' AND capture_provisioning.state <> 'disabled'
            THEN EXCLUDED.reported_at
          WHEN EXCLUDED.state = 'disabled'
            THEN COALESCE(capture_provisioning.disabled_at, EXCLUDED.reported_at)
          ELSE NULL
        END,
        reported_at = EXCLUDED.reported_at,
        pending_count = EXCLUDED.pending_count,
        error_code = EXCLUDED.error_code
        , attribution_pending_count = EXCLUDED.attribution_pending_count
        , attribution_rejected_count = EXCLUDED.attribution_rejected_count
        , attribution_last_claim_at = EXCLUDED.attribution_last_claim_at
      RETURNING
        actor_id AS "actorId",
        host,
        target_key AS "targetKey",
        repository_key AS "repositoryKey",
        state,
        pending_count AS "pendingCount",
        error_code AS "errorCode",
        attribution_pending_count AS "attributionPendingCount",
        attribution_rejected_count AS "attributionRejectedCount",
        attribution_last_claim_at AS "attributionLastClaimAt",
        configured_at AS "configuredAt",
        disabled_at AS "disabledAt",
        reported_at AS "reportedAt"
    `;
    const row = rows[0];
    if (!row) throw new Error('Capture provisioning transition returned no row');

    return {
      actorId: row.actorId,
      host: report.host,
      targetKey: row.targetKey,
      repositoryKey: row.repositoryKey,
      state: row.state as CaptureProvisioningState,
      pendingCount: row.pendingCount,
      errorCode: row.errorCode as CaptureHealthCode | null,
      attributionPendingCount: row.attributionPendingCount ?? 0,
      attributionRejectedCount: row.attributionRejectedCount ?? 0,
      attributionLastClaimAt: row.attributionLastClaimAt?.toISOString() ?? null,
      configuredAt: row.configuredAt?.toISOString() ?? null,
      disabledAt: row.disabledAt?.toISOString() ?? null,
      reportedAt: row.reportedAt.toISOString(),
    };
  }

  async ingest(workspaceId: string, actor: Pick<AuthUser, 'id' | 'email'>, body: unknown): Promise<CaptureReceiptV1> {
    let attempted: unknown[];
    try {
      attempted = captureBatchItems(body);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid capture batch');
    }

    const receipt: CaptureReceiptV1 = {
      acceptedEventIds: [],
      duplicateEventIds: [],
      rejected: [],
    };
    const categorized = new Set<string>();

    for (const rawEvent of attempted) {
      let event: CaptureEvent;
      try {
        event = validateCaptureEvent(rawEvent);
      } catch (error) {
        const eventId = rejectionEventId(rawEvent);
        if (eventId !== null && !categorized.has(eventId)) {
          const duplicate = await this.prisma.captureEvent.findUnique({
            where: { workspaceId_eventId: { workspaceId, eventId } },
            select: { id: true },
          });
          if (duplicate) {
            receipt.duplicateEventIds.push(eventId);
            categorized.add(eventId);
            continue;
          }
        }
        if (eventId === null || !categorized.has(eventId)) {
          receipt.rejected.push({
            eventId,
            code:
              error instanceof UnsupportedCaptureSchemaVersionError ? 'UNSUPPORTED_SCHEMA_VERSION' : 'INVALID_EVENT',
          });
          if (eventId !== null) categorized.add(eventId);
        }
        continue;
      }

      if (categorized.has(event.eventId)) continue;
      try {
        const result = await this.persistEvent(workspaceId, actor, event);
        if (result === 'duplicate') receipt.duplicateEventIds.push(event.eventId);
        else receipt.acceptedEventIds.push(event.eventId);
      } catch (error) {
        if (error instanceof OutOfWorkspaceRepositoryError) {
          receipt.rejected.push({ eventId: event.eventId, code: 'OUT_OF_WORKSPACE_REPOSITORY' });
        } else if (error instanceof ContradictingFactError) {
          receipt.rejected.push({ eventId: event.eventId, code: 'CONTRADICTING_FACT' });
        } else if (isUniqueViolation(error)) {
          const duplicate = await this.prisma.captureEvent.findUnique({
            where: { workspaceId_eventId: { workspaceId, eventId: event.eventId } },
            select: { id: true },
          });
          if (!duplicate) throw error;
          receipt.duplicateEventIds.push(event.eventId);
        } else {
          throw error;
        }
      }
      categorized.add(event.eventId);
    }

    return receipt;
  }

  private persistEvent(
    workspaceId: string,
    actor: Pick<AuthUser, 'id' | 'email'>,
    event: CaptureEvent,
  ): Promise<'accepted' | 'duplicate'> {
    return this.transactionWithConcurrentFirstWriteRetry(async (tx) => {
      const duplicate = await tx.captureEvent.findUnique({
        where: { workspaceId_eventId: { workspaceId, eventId: event.eventId } },
        select: { id: true },
      });
      if (duplicate) return 'duplicate';

      if (event.repositoryKey !== undefined) {
        const repository = await tx.workspaceRepo.findFirst({
          where: { workspaceId, captureRepositoryKey: event.repositoryKey },
          select: { id: true },
        });
        if (!repository) throw new OutOfWorkspaceRepositoryError();
      }

      const acceptedEvent = await tx.captureEvent.create({
        data: {
          workspaceId,
          eventId: event.eventId,
          schemaVersion: event.schemaVersion,
          type: event.type,
          occurredAt: new Date(event.occurredAt),
          host: event.host,
          sessionId: event.sessionId,
          runId: event.runId ?? null,
          repositoryKey: event.repositoryKey ?? null,
          taskId: 'taskId' in event ? (event.taskId ?? null) : null,
          data: event.data as unknown as Prisma.InputJsonValue,
          actorId: actor.id,
        },
        select: { receivedAt: true },
      });

      // A session id already claimed by ANOTHER provider is an established fact this event
      // contradicts (observed live: plugin hooks running under Codex mislabeled events as
      // claude-code while telemetry had created the session as codex). Without this check the
      // provider-scoped upsert below CREATEs and hits the legacy (workspace_id, session_id)
      // unique — a deterministic P2002 that no retry can resolve, poisoning the batch forever.
      const claimedByOtherProvider = await tx.agentSession.findUnique({
        where: { workspaceId_sessionId: { workspaceId, sessionId: event.sessionId } },
        select: { provider: true },
      });
      if (claimedByOtherProvider && claimedByOtherProvider.provider !== event.host) {
        throw new ContradictingFactError('session provider contradicts an established fact');
      }

      const session = await tx.agentSession.upsert({
        where: {
          workspaceId_provider_sessionId: {
            workspaceId,
            provider: event.host,
            sessionId: event.sessionId,
          },
        },
        create: {
          workspaceId,
          provider: event.host,
          sessionId: event.sessionId,
          userId: actor.id,
          userEmail: actor.email || null,
        },
        update: {},
      });
      if (session.userId !== null && session.userId !== actor.id) {
        throw new ContradictingFactError('session actor contradicts an established fact');
      }
      if (session.userId === null) {
        await tx.agentSession.update({
          where: { id: session.id },
          data: { userId: actor.id, userEmail: actor.email || undefined },
        });
      }

      if (event.type === 'workflow.stage.started' || event.type === 'workflow.stage.finished') {
        await this.projectWorkflowStage(tx, workspaceId, actor.id, session.id, event);
      } else if (event.type !== 'capability.used' && event.type !== 'workflow.question.answered') {
        await this.projectWorkflowRun(tx, workspaceId, actor.id, session.id, event);
      }
      await this.updateAcceptedWatermark(tx, workspaceId, actor.id, event, acceptedEvent.receivedAt);
      return 'accepted';
    });
  }

  private async updateAcceptedWatermark(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    actorId: string,
    event: CaptureEvent,
    receivedAt: Date,
  ): Promise<void> {
    if (event.repositoryKey === undefined) return;
    const scopeKey = `repo:${event.repositoryKey}`;
    const repositoryKey = event.repositoryKey;
    // Session-scoped evidence (a capability use, an answered question) is not
    // workflow progress; only run and stage events advance that watermark.
    const workflowLastAcceptedAt =
      event.type === 'capability.used' || event.type === 'workflow.question.answered' ? null : receivedAt;

    await tx.$executeRaw(
      Prisma.sql`
        INSERT INTO capture_accepted_watermarks (
          workspace_id,
          actor_id,
          host,
          scope_key,
          repository_key,
          first_accepted_at,
          last_accepted_at,
          workflow_last_accepted_at
        )
        VALUES (
          ${workspaceId},
          ${actorId},
          ${event.host},
          ${scopeKey},
          ${repositoryKey},
          ${receivedAt},
          ${receivedAt},
          ${workflowLastAcceptedAt}
        )
        ON CONFLICT (workspace_id, actor_id, host, scope_key) DO UPDATE SET
          first_accepted_at = LEAST(
            capture_accepted_watermarks.first_accepted_at,
            EXCLUDED.first_accepted_at
          ),
          last_accepted_at = GREATEST(
            capture_accepted_watermarks.last_accepted_at,
            EXCLUDED.last_accepted_at
          ),
          workflow_last_accepted_at = GREATEST(
            capture_accepted_watermarks.workflow_last_accepted_at,
            EXCLUDED.workflow_last_accepted_at
          )
      `,
    );
  }

  private async projectWorkflowRun(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    actorId: string,
    agentSessionId: string,
    event: Extract<CaptureEvent, { type: 'workflow.run.started' | 'workflow.run.finished' }>,
  ): Promise<void> {
    const incomingTaskId = 'taskId' in event ? event.taskId : undefined;
    const deliveryTaskId =
      event.schemaVersion === 2 && event.type === 'workflow.run.started' && event.taskId !== undefined
        ? await this.ensureDeliveryTask(tx, workspaceId, actorId, event.taskId, event.repositoryKey)
        : undefined;
    const hasDeclaredStages = event.type === 'workflow.run.started' && event.schemaVersion !== 1;
    const startData =
      event.type === 'workflow.run.started'
        ? {
            workflowId: event.data.workflowId,
            intent: event.data.intent,
            risk: event.data.risk,
            scale: event.data.scale,
            repositoryKey: event.repositoryKey ?? null,
            taskId: incomingTaskId ?? null,
            ...(hasDeclaredStages
              ? {
                  deliveryTaskId: deliveryTaskId ?? null,
                  declaredStages: event.data.stages as unknown as Prisma.InputJsonValue,
                }
              : {}),
            startedAt: new Date(event.occurredAt),
          }
        : {};
    const finishData =
      event.type === 'workflow.run.finished'
        ? {
            finishedAt: new Date(event.occurredAt),
            outcome: event.data.outcome,
            ...(event.data.counters === undefined
              ? {}
              : { counters: event.data.counters as unknown as Prisma.InputJsonValue }),
          }
        : {};

    let run = await tx.workflowRun.upsert({
      where: { workspaceId_runId: { workspaceId, runId: event.runId } },
      create: {
        workspaceId,
        runId: event.runId,
        agentSessionId,
        actorId,
        ...startData,
        ...finishData,
      },
      update: {},
    });

    let establishedWorkItems: Array<{ provider: string; externalId: string }> = [];
    if (event.type === 'workflow.run.started' && event.schemaVersion !== 1) {
      await tx.$queryRaw`
        SELECT "id"
        FROM "workflow_runs"
        WHERE "workspace_id" = ${workspaceId}::uuid
          AND "run_id" = ${event.runId}
        FOR UPDATE
      `;
      const lockedRun = await tx.workflowRun.findUnique({
        where: { workspaceId_runId: { workspaceId, runId: event.runId } },
      });
      if (!lockedRun) throw new Error('Locked workflow run disappeared');
      run = lockedRun;
      establishedWorkItems = await tx.workflowRunWorkItem.findMany({
        where: { workspaceId, workflowRunId: run.id },
        select: { provider: true, externalId: true },
        orderBy: [{ provider: 'asc' }, { externalId: 'asc' }],
      });

      if (event.schemaVersion === 3) {
        if (run.deliveryTaskId !== null && run.deliveryTaskId !== undefined) {
          throw new ContradictingFactError('work items contradict an established canonical task attribution');
        }
        this.assertSameWorkItemSet(establishedWorkItems, event.data.workItems);
        if (establishedWorkItems.length === 0) {
          await tx.workflowRunWorkItem.createMany({
            data: event.data.workItems.map((workItem) => ({
              workspaceId,
              workflowRunId: run.id,
              provider: workItem.provider,
              externalId: workItem.externalId,
              externalKey: workItem.externalKey ?? null,
            })),
          });
        }
      } else if (deliveryTaskId !== undefined && establishedWorkItems.length > 0) {
        throw new ContradictingFactError('canonical task attribution contradicts established work items');
      }
    }

    assertSame('run session', run.agentSessionId, agentSessionId);
    assertSame('run actor', run.actorId, actorId);

    if (event.type === 'workflow.run.started') {
      assertSame('workflowId', run.workflowId, event.data.workflowId);
      assertSame('intent', run.intent, event.data.intent);
      assertSame('risk', run.risk, event.data.risk);
      assertSame('scale', run.scale, event.data.scale);
      assertSame('repositoryKey', run.repositoryKey, event.repositoryKey);
      assertSame('taskId', run.taskId, incomingTaskId);
      assertSame('startedAt', run.startedAt, new Date(event.occurredAt));
      let occurrences: WorkflowStageOccurrence[] = [];
      if (hasDeclaredStages) {
        assertSame('deliveryTaskId', run.deliveryTaskId, deliveryTaskId);
        assertSameJson('declaredStages', run.declaredStages, event.data.stages);
        occurrences = await tx.workflowStageOccurrence.findMany({
          where: { workflowRunId: run.id },
          orderBy: [{ stageId: 'asc' }, { attempt: 'asc' }],
        });
        this.assertValidStageFacts(event.data.stages, occurrences);
      }
      await tx.workflowRun.update({
        where: { id: run.id },
        data: {
          workflowId: run.workflowId ?? event.data.workflowId,
          intent: run.intent ?? event.data.intent,
          risk: run.risk ?? event.data.risk,
          scale: run.scale ?? event.data.scale,
          repositoryKey: run.repositoryKey ?? event.repositoryKey,
          taskId: run.taskId ?? incomingTaskId,
          ...(hasDeclaredStages
            ? {
                deliveryTaskId: run.deliveryTaskId ?? deliveryTaskId,
                ...(run.declaredStages !== null && run.declaredStages !== undefined
                  ? {}
                  : { declaredStages: event.data.stages as unknown as Prisma.InputJsonValue }),
              }
            : {}),
          startedAt: run.startedAt ?? new Date(event.occurredAt),
        },
      });
      return;
    }

    assertSame('finishedAt', run.finishedAt, new Date(event.occurredAt));
    assertSame('outcome', run.outcome, event.data.outcome);
    assertSameJson('counters', run.counters, event.data.counters);
    await tx.workflowRun.update({
      where: { id: run.id },
      data: {
        finishedAt: run.finishedAt ?? new Date(event.occurredAt),
        outcome: run.outcome ?? event.data.outcome,
        ...(run.counters != null || event.data.counters === undefined
          ? {}
          : { counters: event.data.counters as unknown as Prisma.InputJsonValue }),
      },
    });
  }

  private assertSameWorkItemSet(
    established: Array<{ provider: string; externalId: string }>,
    incoming: Array<{ provider: string; externalId: string }>,
  ): void {
    if (established.length === 0) return;
    const establishedIdentities = new Set(
      established.map((workItem) => `${workItem.provider}\u0000${workItem.externalId}`),
    );
    if (
      established.length !== incoming.length ||
      incoming.some((workItem) => !establishedIdentities.has(`${workItem.provider}\u0000${workItem.externalId}`))
    ) {
      throw new ContradictingFactError('work items contradict an established relation set');
    }
  }

  private async ensureDeliveryTask(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    actorId: string,
    taskId: string,
    repositoryKey: string | undefined,
  ): Promise<string> {
    const where = { workspaceId_id: { workspaceId, id: taskId } };
    const task = await tx.deliveryTask.upsert({
      where,
      create: {
        workspaceId,
        id: taskId,
        repositoryKey: repositoryKey ?? null,
        lifecycle: 'active',
        authority: 'coredoc',
        createdBy: actorId,
      },
      update: {},
      select: { id: true, repositoryKey: true },
    });

    if (task.repositoryKey !== null && repositoryKey !== undefined && task.repositoryKey !== repositoryKey) {
      throw new ContradictingFactError('task repositoryKey contradicts an established identity');
    }
    return task.id;
  }

  private async projectWorkflowStage(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    actorId: string,
    agentSessionId: string,
    event: Extract<CaptureEvent, { type: 'workflow.stage.started' | 'workflow.stage.finished' }>,
  ): Promise<void> {
    const run = await tx.workflowRun.upsert({
      where: { workspaceId_runId: { workspaceId, runId: event.runId } },
      create: { workspaceId, runId: event.runId, agentSessionId, actorId },
      update: {},
    });
    assertSame('run session', run.agentSessionId, agentSessionId);
    assertSame('run actor', run.actorId, actorId);
    assertSame('run repositoryKey', run.repositoryKey, event.repositoryKey);

    const declaration = this.declaredStages(run.declaredStages);
    const occurredAt = new Date(event.occurredAt);
    let established = await tx.workflowStageOccurrence.findUnique({
      where: {
        workflowRunId_stageId_attempt: {
          workflowRunId: run.id,
          stageId: event.data.stageId,
          attempt: event.data.attempt,
        },
      },
    });
    if (established === null) {
      established = await tx.workflowStageOccurrence.findUnique({
        where: { id: event.data.occurrenceId },
      });
      if (established === null) {
        established = await tx.workflowStageOccurrence.create({
          data: {
            id: event.data.occurrenceId,
            workflowRunId: run.id,
            stageId: event.data.stageId,
            attempt: event.data.attempt,
            ...(event.type === 'workflow.stage.started'
              ? { startedAt: occurredAt }
              : { finishedAt: occurredAt, outcome: event.data.outcome }),
          },
        });
      }
    }
    assertSame('occurrence id', established.id, event.data.occurrenceId);
    assertSame('occurrence run', established.workflowRunId, run.id);
    assertSame('occurrence stageId', established.stageId, event.data.stageId);
    assertSame('occurrence attempt', established.attempt, event.data.attempt);
    if (event.type === 'workflow.stage.started') {
      assertSame('occurrence startedAt', established.startedAt, occurredAt);
    } else {
      assertSame('occurrence finishedAt', established.finishedAt, occurredAt);
      assertSame('occurrence outcome', established.outcome, event.data.outcome);
    }
    const projected = {
      id: event.data.occurrenceId,
      workflowRunId: run.id,
      stageId: event.data.stageId,
      attempt: event.data.attempt,
      startedAt: event.type === 'workflow.stage.started' ? occurredAt : established.startedAt,
      finishedAt: event.type === 'workflow.stage.finished' ? occurredAt : established.finishedAt,
      outcome: event.type === 'workflow.stage.finished' ? event.data.outcome : established.outcome,
    };
    const occurrences = await tx.workflowStageOccurrence.findMany({
      where: { workflowRunId: run.id },
      orderBy: [{ stageId: 'asc' }, { attempt: 'asc' }],
    });
    const proposed = occurrences.map((occurrence) => (occurrence.id === established.id ? projected : occurrence));
    this.assertValidStageFacts(declaration, proposed);

    if (event.type === 'workflow.stage.started' && established.startedAt === null) {
      await tx.workflowStageOccurrence.update({ where: { id: established.id }, data: { startedAt: occurredAt } });
    }
    if (event.type === 'workflow.stage.finished' && established.finishedAt === null) {
      await tx.workflowStageOccurrence.update({
        where: { id: established.id },
        data: { finishedAt: occurredAt, outcome: event.data.outcome },
      });
    }
  }

  private declaredStages(value: unknown): DeclaredStageV2[] | null {
    if (value === null || value === undefined) return null;
    if (!Array.isArray(value)) throw new ContradictingFactError('stored stage declaration is invalid');
    return value as unknown as DeclaredStageV2[];
  }

  private assertValidStageFacts(
    declaration: DeclaredStageV2[] | null,
    occurrences: Array<{
      id: string;
      workflowRunId: string;
      stageId: string;
      attempt: number;
      startedAt: Date | null;
      finishedAt: Date | null;
      outcome: string | null;
    }>,
  ): void {
    const declaredById = new Map(declaration?.map((stage) => [stage.stageId, stage]) ?? []);
    const byStage = new Map<string, typeof occurrences>();
    const earliestFinishByStage = new Map<string, number>();
    for (const occurrence of occurrences) {
      if (declaration !== null && !declaredById.has(occurrence.stageId)) {
        throw new ContradictingFactError('stage occurrence is not present in the run declaration');
      }
      if (
        occurrence.startedAt !== null &&
        occurrence.finishedAt !== null &&
        occurrence.startedAt.getTime() > occurrence.finishedAt.getTime()
      ) {
        throw new ContradictingFactError('stage start occurs after its finish');
      }
      const rows = byStage.get(occurrence.stageId) ?? [];
      rows.push(occurrence);
      byStage.set(occurrence.stageId, rows);
      if (occurrence.finishedAt !== null) {
        const finishedAt = occurrence.finishedAt.getTime();
        const earliest = earliestFinishByStage.get(occurrence.stageId);
        if (earliest === undefined || finishedAt < earliest) {
          earliestFinishByStage.set(occurrence.stageId, finishedAt);
        }
      }
    }

    for (const [stageId, rows] of byStage) {
      rows.sort((left, right) => left.attempt - right.attempt);
      for (const [index, occurrence] of rows.entries()) {
        if (occurrence.attempt !== index + 1) {
          throw new ContradictingFactError('stage attempts must start at one and remain contiguous');
        }
        if (index > 0) {
          const prior = rows[index - 1];
          const boundary = occurrence.startedAt ?? occurrence.finishedAt;
          if (prior.finishedAt === null || (boundary !== null && prior.finishedAt.getTime() > boundary.getTime())) {
            throw new ContradictingFactError('stage re-entry requires the prior attempt to finish first');
          }
        }
      }

      const stage = declaredById.get(stageId);
      if (!stage) continue;
      for (const occurrence of rows) {
        const boundary = occurrence.startedAt ?? occurrence.finishedAt;
        if (boundary === null) continue;
        for (const dependency of stage.after) {
          const earliestFinish = earliestFinishByStage.get(dependency);
          if (earliestFinish === undefined || earliestFinish > boundary.getTime()) {
            throw new ContradictingFactError('stage dependency was not finished before the attempt');
          }
        }
      }
    }
  }
}
