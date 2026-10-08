import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  type ClaimRequest,
  type CompleteTurn,
  type CompleteTurnResponse,
  type EventBatch,
  type EventBatchResponse,
  type HeartbeatResponse,
  MAX_STATE_ARCHIVE_BYTES,
  type ProposeScope,
  type ProposeScopeResponse,
  type ReportQuestion,
  type ReportQuestionResponse,
  type ReserveBranchResponse,
  type RunnerVersions,
  type SubmitResult,
  type SubmitResultResponse,
  SUPPORTED_RUNNER_PROTOCOL_VERSIONS,
  type TurnAssignment,
} from '@coredoc/core/agent-runner';
import { TokenPermission } from '../../auth/token-permissions.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { CloudAgentRun, Prisma } from '../../generated/prisma/client.js';
import {
  CLOUD_AGENT_RUN_ARCHIVE_STORE,
  type CloudAgentRunArchiveStore,
  stateArchiveKey,
} from './cloud-agent-run-archive.store.js';
import { CloudAgentRunIssueReader, JiraReadFailure } from './cloud-agent-run-issue-reader.js';
import { answerForTurn, recordQuestion, settleTurnQuestions } from './cloud-agent-run-questions.service.js';
import { CloudAgentRunDeliveryService } from './cloud-agent-run-delivery.service.js';
import { CloudAgentRunImplementService, RunCheckFailure } from './cloud-agent-run-implement.service.js';
import { CloudAgentRunScopeService } from './cloud-agent-run-scope.service.js';
import {
  CloudAgentRunErrorCode,
  cloudAgentRunError,
  isTerminalRunStatus,
  RunFailureCode,
  RunPhase,
  ServerEventType,
  TERMINAL_RUN_STATUSES,
  TurnOutcome,
  TurnState,
} from './run-states.js';
import { appendRunEvents, CLOUD_AGENT_RUNS_CLOCK, type Clock, systemClock, type Tx } from './run-store.js';
import { deleteTurnTokens, failRun, lockRun, queueTurn } from './run-transitions.js';

/** A claim's lease; the runner heartbeats every 20 s, so this tolerates several missed beats. */
export const LEASE_MS = 2 * 60_000;
/** The per-turn MCP token outlives the longest turn by this margin. */
const MCP_TOKEN_GRACE_MS = 15 * 60_000;
/** Claim attempts per request when a claimed turn's run fails its run-level re-check. */
const MAX_CLAIM_ATTEMPTS = 5;

/** The calling runner: its token and the workspace that token belongs to. */
export interface RunnerPrincipal {
  workspaceId: string;
  tokenId: string;
}

interface ClaimedRow {
  id: string;
  run_id: string;
  kind: string;
  ordinal: number;
  attempts: number;
  input_text: string | null;
  lease_token: string;
  lease_expires_at: Date;
}

interface FencedTurn {
  id: string;
  run_id: string;
  workspace_id: string;
  state: string;
  lease_token: string | null;
  lease_expires_at: Date | null;
  run_status: string;
}

/**
 * Where a lease-fenced request stands:
 * - `live`: the lease is this runner's and current;
 * - `stopped`: the turn was abandoned because the run became terminal — the
 *   runner records the turn's own facts and stops;
 * - `completed`: the turn already completed (a repeated completion is a no-op).
 */
type FenceResult = { turn: FencedTurn; standing: 'live' | 'stopped' | 'completed' };

interface ClaimedTurn {
  assignment: TurnAssignment;
  run: CloudAgentRun;
}

/** The continuation after a checkpoint (duration limit or SDK turn cap). */
const CONTINUE_WHERE_YOU_STOPPED = 'Continue where you stopped.';

@Injectable()
export class CloudAgentTurnService {
  private readonly logger = new Logger(CloudAgentTurnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jira: CloudAgentRunIssueReader,
    private readonly scope: CloudAgentRunScopeService,
    private readonly implement: CloudAgentRunImplementService,
    private readonly delivery: CloudAgentRunDeliveryService,
    @Inject(CLOUD_AGENT_RUN_ARCHIVE_STORE) private readonly archives: CloudAgentRunArchiveStore,
    @Optional() @Inject(CLOUD_AGENT_RUNS_CLOCK) private readonly now: Clock = systemClock,
  ) {}

  /**
   * Oldest queued turn of a non-terminal run in the runner's workspace, or
   * null. Before a scope turn is handed out its run is re-checked by reading
   * the PRD from Jira; a run that fails the re-check is failed, and the next
   * queued turn is tried instead.
   */
  async claim(runner: RunnerPrincipal, request: ClaimRequest): Promise<TurnAssignment | null> {
    if (!SUPPORTED_RUNNER_PROTOCOL_VERSIONS.includes(request.protocolVersion)) {
      const reason = `Protocol version ${request.protocolVersion} is not supported; this server supports ${SUPPORTED_RUNNER_PROTOCOL_VERSIONS.join(', ')}`;
      await this.recordSeen(runner, 'claim', request.protocolVersion, request.versions, reason);
      throw cloudAgentRunError(CloudAgentRunErrorCode.RunnerIncompatible, reason);
    }

    let assignment: TurnAssignment | null = null;
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS && !assignment; attempt += 1) {
      const claimed = await this.claimNext(runner, request);
      if (!claimed) break;
      assignment = await this.withRunChecks(claimed);
    }
    await this.recordSeen(runner, 'claim', request.protocolVersion, request.versions, null);
    return assignment;
  }

  /**
   * Scope turns get their PRD, read fresh from Jira, and their seeds for the
   * runner's bot check; implement turns get clone URLs and the accepted spec.
   * A run whose issue is unreadable or whose repository stopped resolving
   * fails here.
   */
  private async withRunChecks(claimed: ClaimedTurn): Promise<TurnAssignment | null> {
    const { assignment, run } = claimed;
    try {
      if (assignment.turn.kind === RunPhase.Delivery) return { ...assignment, ...(await this.delivery.assignment(run)) };
      const repositories = await this.implement.repositoriesFor(run, assignment.turn.kind);
      if (assignment.turn.kind === RunPhase.Implement) {
        return { ...assignment, repositories, acceptedSpec: await this.implement.acceptedSpec(run) };
      }
      if (assignment.turn.kind !== RunPhase.Scope) return assignment;
      const prd = await this.jira.readPrd(run.workspaceId, run.jiraIssueId);
      if (prd.issueKey !== assignment.run.issueKey) {
        // The key changes when an issue moves between projects; the id is the identity.
        await this.prisma.cloudAgentRun.updateMany({
          where: { id: assignment.run.id, workspaceId: run.workspaceId },
          data: { issueKey: prd.issueKey },
        });
      }
      return {
        ...assignment,
        run: { ...assignment.run, issueKey: prd.issueKey },
        prd: { markdown: prd.markdown },
        repositories,
      };
    } catch (error) {
      if (!(error instanceof JiraReadFailure) && !(error instanceof RunCheckFailure)) throw error;
      await this.prisma.$transaction(async (tx) => {
        const locked = await lockRun(tx, run.workspaceId, assignment.run.id);
        if (locked) {
          await failRun(tx, locked, error.code, error instanceof RunCheckFailure ? error.message : null, this.now());
        }
      });
      return null;
    }
  }

  private async claimNext(runner: RunnerPrincipal, request: ClaimRequest): Promise<ClaimedTurn | null> {
    const at = this.now();
    return this.prisma.$transaction(async (tx) => {
      // One statement: a skip-locked pick plus the lease, so two runners never
      // claim the same turn and neither waits on the other's row.
      const rows = await tx.$queryRaw<ClaimedRow[]>`
        WITH next AS (
          SELECT t.id
          FROM cloud_agent_run_turns t
          JOIN cloud_agent_runs r ON r.id = t.run_id
          WHERE t.workspace_id = ${runner.workspaceId}::uuid
            AND t.state = ${TurnState.Queued}
            AND r.status <> ALL(${[...TERMINAL_RUN_STATUSES]}::text[])
          ORDER BY t.created_at, t.id
          LIMIT 1
          FOR UPDATE OF t SKIP LOCKED
        )
        UPDATE cloud_agent_run_turns t
        SET state = ${TurnState.Claimed},
            attempts = t.attempts + 1,
            lease_token = gen_random_uuid(),
            lease_expires_at = ${new Date(at.getTime() + LEASE_MS)},
            claimed_by_token_id = ${runner.tokenId}::uuid,
            claimed_at = ${at},
            runner_versions = ${JSON.stringify(request.versions)}::jsonb
        FROM next
        WHERE t.id = next.id
        RETURNING t.id, t.run_id, t.kind, t.ordinal, t.attempts, t.input_text, t.lease_token::text AS lease_token,
                  t.lease_expires_at`;
      const claimed = rows[0];
      if (!claimed) return null;

      const run = await tx.cloudAgentRun.findFirstOrThrow({
        where: { id: claimed.run_id, workspaceId: runner.workspaceId },
      });
      const mcpToken =
        claimed.kind === RunPhase.Delivery ? null : await this.mintMcpToken(tx, run, claimed.id, claimed.kind, at);
      // The pinned SDK reports a resumed session's cost cumulatively; the
      // runner subtracts what this phase's session already reported.
      const prior = await tx.cloudAgentRunTurn.aggregate({
        where: { runId: run.id, kind: claimed.kind, state: TurnState.Completed },
        _sum: { spendUsd: true },
      });
      await appendRunEvents(
        tx,
        { workspaceId: runner.workspaceId, runId: run.id, turnId: claimed.id },
        [
          {
            type: ServerEventType.TurnStarted,
            payload: { kind: claimed.kind, attempt: claimed.attempts, versions: request.versions },
          },
        ],
        at,
      );
      const assignment: TurnAssignment = {
        turn: {
          id: claimed.id,
          kind: claimed.kind as TurnAssignment['turn']['kind'],
          ordinal: claimed.ordinal,
          attempt: claimed.attempts,
          inputText: claimed.input_text,
        },
        lease: { token: claimed.lease_token, expiresAt: claimed.lease_expires_at.toISOString() },
        run: {
          id: run.id,
          issueKey: run.issueKey,
          questionsPolicy: run.questionsPolicy as TurnAssignment['run']['questionsPolicy'],
          scopeAcceptancePolicy: run.scopeAcceptancePolicy as TurnAssignment['run']['scopeAcceptancePolicy'],
          model: run.model,
          sessionId: run.phase === RunPhase.Implement ? run.implementSessionId : run.scopeSessionId,
          remainingSpendUsd: Math.max(0, run.maxSpendUsd - run.spendUsd),
          priorSessionSpendUsd: prior._sum.spendUsd ?? 0,
          maxTurnDurationSeconds: run.maxTurnDurationSeconds,
          seeds: run.seeds,
          branch: run.branch,
        },
        prd: null,
        // Repositories and the accepted spec are resolved after the claim commits (withRunChecks).
        acceptedSpec: null,
        repositories: [],
        delivery: null,
        mcp: mcpToken ? { token: mcpToken, path: `/api/v1/workspaces/${run.workspaceId}/mcp` } : null,
        hasStateArchive: run.stateArchiveKey !== null,
        answer: await answerForTurn(tx, run.workspaceId, claimed.id),
      };
      return { assignment, run };
    });
  }

  /**
   * The turn's MCP-only credential, acting as the run owner: intent read in
   * scope turns (proposing could overwrite the PRD tooling's candidates),
   * read and propose in implement turns. Hash-only; returned once.
   */
  private async mintMcpToken(tx: Tx, run: CloudAgentRun, turnId: string, kind: string, at: Date): Promise<string> {
    // A re-claimed turn replaces the token its lost attempt held.
    await deleteTurnTokens(tx, [turnId]);
    const plaintext = `cdt_${randomBytes(32).toString('hex')}`;
    await tx.serviceToken.create({
      data: {
        workspaceId: run.workspaceId,
        name: `agent-turn:${turnId}`,
        tokenHash: createHash('sha256').update(plaintext).digest('hex'),
        tokenPrefix: plaintext.slice(0, 12),
        tokenEncrypted: null,
        permissions:
          kind === RunPhase.Implement
            ? [TokenPermission.IntentRead, TokenPermission.IntentPropose]
            : [TokenPermission.IntentRead],
        expiresAt: new Date(at.getTime() + run.maxTurnDurationSeconds * 1000 + MCP_TOKEN_GRACE_MS),
        createdBy: run.runOwnerId,
        owningTurnId: turnId,
      },
    });
    return plaintext;
  }

  async heartbeat(
    runner: RunnerPrincipal,
    turnId: string,
    leaseToken: string,
    versions: RunnerVersions,
  ): Promise<HeartbeatResponse> {
    const result = await this.prisma.$transaction(async (tx) => {
      const { turn, standing } = await this.fence(tx, runner, turnId, leaseToken);
      if (standing !== 'live') {
        return { stop: true, leaseExpiresAt: (turn.lease_expires_at ?? this.now()).toISOString() };
      }
      const expiresAt = new Date(this.now().getTime() + LEASE_MS);
      await tx.cloudAgentRunTurn.update({ where: { id: turn.id }, data: { leaseExpiresAt: expiresAt } });
      return { stop: false, leaseExpiresAt: expiresAt.toISOString() };
    });
    if (!result.stop) await this.recordSeen(runner, 'heartbeat', null, versions, null);
    return result;
  }

  async recordEvents(
    runner: RunnerPrincipal,
    turnId: string,
    leaseToken: string,
    batch: EventBatch,
  ): Promise<EventBatchResponse> {
    return this.prisma.$transaction(async (tx) => {
      const { turn, standing } = await this.fence(tx, runner, turnId, leaseToken);
      if (standing === 'completed') throw leaseLost();
      // Events are the turn's own facts, so a stopped turn still records them.
      const seqs = await appendRunEvents(
        tx,
        { workspaceId: runner.workspaceId, runId: turn.run_id, turnId: turn.id },
        batch.events.map(({ type, ...payload }) => ({ type, payload })),
        this.now(),
      );
      return { seqs, stop: standing === 'stopped' };
    });
  }

  /**
   * `propose_scope`: validated against the run; a valid proposal becomes this
   * turn's draft version, published when the turn completes. Broken rules go
   * back to the agent as a tool error.
   */
  async proposeScope(
    runner: RunnerPrincipal,
    turnId: string,
    leaseToken: string,
    proposal: ProposeScope,
  ): Promise<ProposeScopeResponse> {
    const eligibility = await this.scope.eligibility(runner.workspaceId);
    return this.prisma.$transaction(async (tx) => {
      const { turn, standing } = await this.fence(tx, runner, turnId, leaseToken);
      if (standing === 'completed') throw leaseLost();
      if (standing === 'stopped') return { accepted: false, errors: ['The run has ended; stop.'], stop: true };
      const row = await tx.cloudAgentRunTurn.findUniqueOrThrow({ where: { id: turn.id }, select: { kind: true } });
      if (row.kind !== RunPhase.Scope) {
        return { accepted: false, errors: ['propose_scope is available only while scoping.'], stop: false };
      }
      // The fenced turn's own run, in the runner's workspace: a draft is never written for another run.
      const run = await tx.cloudAgentRun.findFirstOrThrow({
        where: { id: turn.run_id, workspaceId: runner.workspaceId },
      });
      const errors = this.scope.validate(proposal, {
        eligibility,
        seeds: run.seeds,
        maxRepositories: run.maxRepositories,
      });
      if (errors.length) return { accepted: false, errors, stop: false };
      const version = await this.scope.saveDraft(tx, run, turn.id, proposal, this.now());
      return { accepted: true, version, stop: false };
    });
  }

  /**
   * `submit_result`: validated against the run; a valid result is stored on
   * the turn and adopted when the turn completes. Broken rules go back to
   * the agent as a tool error.
   */
  async submitResult(
    runner: RunnerPrincipal,
    turnId: string,
    leaseToken: string,
    result: SubmitResult,
  ): Promise<SubmitResultResponse> {
    return this.prisma.$transaction(async (tx) => {
      const { turn, standing } = await this.fence(tx, runner, turnId, leaseToken);
      if (standing === 'completed') throw leaseLost();
      if (standing === 'stopped') return { accepted: false, errors: ['The run has ended; stop.'], stop: true };
      const row = await tx.cloudAgentRunTurn.findUniqueOrThrow({ where: { id: turn.id }, select: { kind: true } });
      if (row.kind !== RunPhase.Implement) {
        return { accepted: false, errors: ['submit_result is available only while implementing.'], stop: false };
      }
      const run = await tx.cloudAgentRun.findFirstOrThrow({
        where: { id: turn.run_id, workspaceId: runner.workspaceId },
      });
      const errors = this.implement.validateResult(run, result);
      if (errors.length) return { accepted: false, errors, stop: false };
      await this.implement.saveResult(tx, turn.id, result);
      return { accepted: true, stop: false };
    });
  }

  /**
   * Before the runner's first push of the run branch to a repository: records
   * that this run created it there, so a retried attempt that finds the
   * branch on the remote continues on it.
   */
  async reserveBranch(
    runner: RunnerPrincipal,
    turnId: string,
    leaseToken: string,
    repository: string,
  ): Promise<ReserveBranchResponse> {
    return this.prisma.$transaction(async (tx) => {
      const { turn, standing } = await this.fence(tx, runner, turnId, leaseToken);
      if (standing !== 'live') throw leaseLost();
      const row = await tx.cloudAgentRunTurn.findUniqueOrThrow({ where: { id: turn.id }, select: { kind: true } });
      if (row.kind !== RunPhase.Implement) {
        throw cloudAgentRunError(
          CloudAgentRunErrorCode.RunStateConflict,
          'Run branches are reserved only in implement turns',
          HttpStatus.CONFLICT,
        );
      }
      const run = (await lockRun(tx, runner.workspaceId, turn.run_id))!;
      await this.implement.reserveBranch(tx, run, repository);
      return { reserved: true, branch: run.branch };
    });
  }

  /**
   * An AskUserQuestion call from the live turn: answered at once under the
   * assume policy, parked for a person under pause (the run moves to
   * `awaiting_answer` and the runner ends the session).
   */
  async reportQuestion(
    runner: RunnerPrincipal,
    turnId: string,
    leaseToken: string,
    report: ReportQuestion,
  ): Promise<ReportQuestionResponse> {
    return this.prisma.$transaction(async (tx) => {
      const { turn, standing } = await this.fence(tx, runner, turnId, leaseToken);
      if (standing === 'completed') throw leaseLost();
      if (standing === 'stopped') return { state: 'refused', reason: 'The run has ended; stop.', stop: true };
      const row = await tx.cloudAgentRunTurn.findUniqueOrThrow({ where: { id: turn.id }, select: { kind: true } });
      if (row.kind !== RunPhase.Scope && row.kind !== RunPhase.Implement) {
        return { state: 'refused', reason: 'Questions are asked only while scoping or implementing.', stop: false };
      }
      const run = (await lockRun(tx, runner.workspaceId, turn.run_id))!;
      return recordQuestion(tx, run, turn.id, report, this.now());
    });
  }

  /**
   * Stores the turn's state archive under a new key, create-only; the run
   * adopts it when the turn completes. An archive over the cap fails the run.
   */
  async uploadArchive(
    runner: RunnerPrincipal,
    turnId: string,
    leaseToken: string,
    body: Buffer,
  ): Promise<{ stored: true }> {
    if (body.length > MAX_STATE_ARCHIVE_BYTES) {
      await this.prisma.$transaction(async (tx) => {
        const { turn, standing } = await this.fence(tx, runner, turnId, leaseToken);
        const run = standing === 'live' ? await lockRun(tx, runner.workspaceId, turn.run_id) : null;
        if (run) await failRun(tx, run, RunFailureCode.ArchiveTooLarge, null, this.now());
      });
      throw cloudAgentRunError(
        CloudAgentRunErrorCode.ArchiveTooLarge,
        `The state archive is larger than ${MAX_STATE_ARCHIVE_BYTES} bytes`,
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }
    const turn = await this.liveTurn(runner, turnId, leaseToken);
    const key = stateArchiveKey(runner.workspaceId, turn.run_id, turn.id, randomUUID());
    await this.archives.put(key, body);
    let replaced: string | null;
    try {
      replaced = await this.prisma.$transaction(async (tx) => {
        const fenced = await this.fence(tx, runner, turnId, leaseToken);
        if (fenced.standing !== 'live') throw leaseLost();
        const row = await tx.cloudAgentRunTurn.findUniqueOrThrow({
          where: { id: turn.id },
          select: { stateArchiveKey: true },
        });
        await tx.cloudAgentRunTurn.update({ where: { id: turn.id }, data: { stateArchiveKey: key } });
        return row.stateArchiveKey;
      });
    } catch (error) {
      await this.archives.delete(key).catch(() => undefined);
      throw error;
    }
    // An earlier upload of the same turn, which the run never adopted.
    if (replaced) await this.archives.delete(replaced).catch(() => undefined);
    return { stored: true };
  }

  /** The run's latest state archive, for the live lease only. */
  async downloadArchive(runner: RunnerPrincipal, turnId: string, leaseToken: string): Promise<Buffer> {
    const turn = await this.liveTurn(runner, turnId, leaseToken);
    const run = await this.prisma.cloudAgentRun.findFirstOrThrow({
      where: { id: turn.run_id, workspaceId: runner.workspaceId },
      select: { stateArchiveKey: true },
    });
    const archive = run.stateArchiveKey ? await this.archives.get(run.stateArchiveKey) : null;
    if (!archive) {
      throw cloudAgentRunError(
        CloudAgentRunErrorCode.ArchiveNotFound,
        'This run has no state archive',
        HttpStatus.NOT_FOUND,
      );
    }
    return archive;
  }

  /**
   * The completion transaction: records the turn's facts (spend, versions,
   * the uploaded archive), deletes its MCP token and advances the run from
   * what the turn reported. A failure outcome fails the run; a scope turn
   * publishes its draft proposal. A repeated completion is a no-op.
   */
  async complete(
    runner: RunnerPrincipal,
    turnId: string,
    leaseToken: string,
    request: CompleteTurn,
  ): Promise<CompleteTurnResponse> {
    const eligibility = await this.scope.eligibility(runner.workspaceId);
    // Delivery turns: reported pull requests are read back from GitHub before the transaction.
    const delivered = await this.delivery.verify(runner.workspaceId, turnId, request.deliveries);
    const replacedArchive = await this.prisma.$transaction(async (tx) => {
      const { turn, standing } = await this.fence(tx, runner, turnId, leaseToken);
      if (standing === 'completed') return null;

      const at = this.now();
      const spend = request.spend;
      const row = await tx.cloudAgentRunTurn.findUniqueOrThrow({ where: { id: turn.id } });
      const run = (await lockRun(tx, runner.workspaceId, turn.run_id))!;
      const live = standing === 'live';
      // Untrusted: refused before anything is written, so the runner can correct and complete again.
      if (row.kind === RunPhase.Implement) this.implement.validateReports(run, request.repositories);

      let outcome: string = TurnOutcome.NoOutcome;
      if (request.outcome.kind === 'failed') outcome = request.outcome.code;

      // The turn is completed before any next turn is queued (one pending turn per run).
      await tx.cloudAgentRunTurn.update({
        where: { id: turn.id },
        data: {
          // A stopped (abandoned) turn keeps its state; it only gains its facts.
          ...(live ? { state: TurnState.Completed } : {}),
          spendUsd: spend?.costUsd ?? null,
          runnerVersions: request.versions as Prisma.InputJsonObject,
          completedAt: at,
        },
      });
      await deleteTurnTokens(tx, [turn.id]);
      const adoptArchive = live && row.stateArchiveKey !== null;
      const charged = await tx.cloudAgentRun.update({
        where: { id: run.id },
        data: {
          ...(spend
            ? { spendUsd: { increment: spend.costUsd }, agentTurns: { increment: spend.sdkTurns ?? 0 } }
            : { unknownSpendTurns: { increment: 1 } }),
          ...(adoptArchive ? { stateArchiveKey: row.stateArchiveKey } : {}),
          lastTurnEndedAt: at,
        },
      });
      // Pushes are facts of the turn: recorded even when it failed or was stopped.
      // So are verified pull requests, including those a cancelled delivery already opened.
      const updated =
        row.kind === RunPhase.Implement
          ? await this.implement.recordReports(tx, charged, turn.id, request.repositories, at)
          : row.kind === RunPhase.Delivery
            ? await this.delivery.record(tx, charged, turn.id, delivered, at)
            : charged;

      if (live && request.outcome.kind === 'failed') {
        await failRun(tx, updated, request.outcome.code, request.outcome.reason || null, at);
      } else if (live && (row.kind === RunPhase.Scope || row.kind === RunPhase.Implement)) {
        outcome = await this.advanceAfterAgentTurn(tx, updated, row.kind, turn.id, request, eligibility, at);
      } else if (live && row.kind === RunPhase.Delivery) {
        outcome = await this.delivery.settle(tx, updated, delivered, at);
      }

      await tx.cloudAgentRunTurn.update({ where: { id: turn.id }, data: { outcome } });
      await appendRunEvents(
        tx,
        { workspaceId: runner.workspaceId, runId: run.id, turnId: turn.id },
        [{ type: ServerEventType.TurnEnded, payload: { outcome, spendUsd: spend?.costUsd ?? null } }],
        at,
      );
      return adoptArchive && run.stateArchiveKey && run.stateArchiveKey !== row.stateArchiveKey
        ? run.stateArchiveKey
        : null;
    });
    // The previous archive goes only after the run points at the new one.
    if (replacedArchive) {
      await this.archives.delete(replacedArchive).catch((error: unknown) => {
        this.logger.warn(
          `could not delete a replaced state archive: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    return { completed: true };
  }

  /**
   * What an agent turn that ended normally achieved: a parked question, a
   * published proposal, or nothing. An outcome-less turn is resumed once with
   * a nudge; the second in a row fails the run with the agent's last message.
   */
  private async advanceAfterAgentTurn(
    tx: Tx,
    run: CloudAgentRun,
    kind: string,
    turnId: string,
    request: CompleteTurn,
    eligibility: Map<string, string | null>,
    at: Date,
  ): Promise<string> {
    if (await settleTurnQuestions(tx, run, turnId, at)) return TurnOutcome.QuestionAsked;
    if (kind === RunPhase.Scope && (await this.scope.publishDraft(tx, run, turnId, eligibility, at))) {
      return TurnOutcome.ScopeProposed;
    }
    if (kind === RunPhase.Implement) {
      const settled = await this.implement.settleResult(tx, run, turnId, at);
      if (settled) return settled;
    }
    // A checkpoint continues the same session; it neither counts toward nor resets the nudge rule.
    if (request.outcome.kind === 'checkpoint') {
      await queueTurn(tx, run, kind, CONTINUE_WHERE_YOU_STOPPED, at);
      return TurnOutcome.Checkpoint;
    }
    const count = run.outcomeLessCount + 1;
    if (count >= MAX_OUTCOME_LESS_TURNS) {
      await failRun(tx, run, RunFailureCode.NoOutcome, request.lastMessage?.trim() || null, at);
    } else {
      const nudged = await tx.cloudAgentRun.update({ where: { id: run.id }, data: { outcomeLessCount: count } });
      await queueTurn(tx, nudged, kind, nudge(run.questionsPolicy, kind), at);
    }
    return TurnOutcome.NoOutcome;
  }

  private async liveTurn(runner: RunnerPrincipal, turnId: string, leaseToken: string): Promise<FencedTurn> {
    return this.prisma.$transaction(async (tx) => {
      const { turn, standing } = await this.fence(tx, runner, turnId, leaseToken);
      if (standing !== 'live') throw leaseLost();
      return turn;
    });
  }

  /**
   * Every runner request about a turn is checked against the turn row locked
   * for update: unknown turn, another lease, an expired lease or a re-queued
   * turn all get `LEASE_LOST`.
   */
  private async fence(tx: Tx, runner: RunnerPrincipal, turnId: string, leaseToken: string): Promise<FenceResult> {
    const rows = await tx.$queryRaw<FencedTurn[]>`
      SELECT t.id, t.run_id, t.workspace_id, t.state, t.lease_token::text AS lease_token, t.lease_expires_at,
             r.status AS run_status
      FROM cloud_agent_run_turns t
      JOIN cloud_agent_runs r ON r.id = t.run_id
      WHERE t.id = ${turnId}::uuid AND t.workspace_id = ${runner.workspaceId}::uuid
      FOR UPDATE OF t`;
    const turn = rows[0];
    if (!turn || turn.lease_token !== leaseToken) throw leaseLost();
    if (turn.state === TurnState.Completed) return { turn, standing: 'completed' };
    if (turn.state === TurnState.Abandoned || isTerminalRunStatus(turn.run_status)) {
      return { turn, standing: 'stopped' };
    }
    if (turn.state !== TurnState.Claimed || !turn.lease_expires_at || turn.lease_expires_at <= this.now()) {
      throw leaseLost();
    }
    return { turn, standing: 'live' };
  }

  /**
   * Settings show each runner token's last successful claim or heartbeat with
   * its versions, or why it was refused.
   */
  private async recordSeen(
    runner: RunnerPrincipal,
    action: 'claim' | 'heartbeat',
    protocolVersion: number | null,
    versions: RunnerVersions,
    refusedReason: string | null,
  ): Promise<void> {
    const at = this.now();
    const data = {
      lastSeenAt: at,
      lastAction: action,
      versions: versions as Prisma.InputJsonObject,
      refusedReason,
      ...(protocolVersion === null ? {} : { protocolVersion }),
    };
    await this.prisma.agentRunnerSeen.upsert({
      where: { serviceTokenId: runner.tokenId },
      create: {
        serviceTokenId: runner.tokenId,
        workspaceId: runner.workspaceId,
        protocolVersion: protocolVersion ?? 0,
        ...data,
      },
      update: data,
    });
  }
}

/** The second outcome-less turn in a row fails the run. */
const MAX_OUTCOME_LESS_TURNS = 2;

/** The resume message after an outcome-less turn, by questions policy. */
function nudge(questionsPolicy: string, kind: string): string {
  const tool = kind === RunPhase.Scope ? 'propose_scope' : 'submit_result';
  return questionsPolicy === 'assume'
    ? `Your last turn ended without an outcome. Finish on stated assumptions: call ${tool} and list every assumption you made in it.`
    : `Your last turn ended without an outcome. Finish with ${tool}, or ask a person through AskUserQuestion.`;
}

function leaseLost() {
  return cloudAgentRunError(
    CloudAgentRunErrorCode.LeaseLost,
    'The lease on this turn is no longer yours; stop the turn',
    HttpStatus.CONFLICT,
  );
}
