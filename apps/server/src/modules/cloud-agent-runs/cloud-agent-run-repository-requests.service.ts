import { Injectable } from '@nestjs/common';
import type { AskedQuestion, RequestRepo, RequestRepoResponse, TurnAssignment } from '@coredoc/core/agent-runner';
import type { CloudAgentRun, CloudAgentRunQuestion, Prisma } from '../../generated/prisma/client.js';
import { CloudAgentRunImplementService, runRepositories } from './cloud-agent-run-implement.service.js';
import type { RunRepository } from './cloud-agent-run-scope.service.js';
import type { QuestionAnswer } from './cloud-agent-runs.contract.js';
import { QuestionKind, QuestionState, RunEventCode, RunPhase, RunStatus, ServerEventType } from './run-states.js';
import { appendRunEvents, type NewRunEvent, type Tx } from './run-store.js';
import { setRunStatus } from './run-transitions.js';

/** The fixed options of a repository-request question. */
export const ADD_REPOSITORY = 'Add';
export const DECLINE_REPOSITORY = "Don't add";

/** A `request_repo` call stored on its turn under required acceptance. */
interface RepositoryRequest {
  key: string;
  reason: string;
}

function rejected(errors: string[], stop = false): RequestRepoResponse {
  return { state: 'rejected', errors, stop };
}

function repositoryEvent(code: string, key: string, text: string): NewRunEvent {
  return { type: ServerEventType.RunEvent, payload: { code, text, repository: key } };
}

/**
 * Appends a requested repository to the run: origin `request`, the agent's
 * reason, merge order last. The caller holds the locked run.
 */
async function appendRequestedRepository(
  tx: Tx,
  run: CloudAgentRun,
  request: RepositoryRequest,
  at: Date,
): Promise<RunRepository> {
  const repositories = runRepositories(run);
  const repository: RunRepository = {
    key: request.key,
    reason: request.reason,
    mergeOrder: Math.max(-1, ...repositories.map((candidate) => candidate.mergeOrder)) + 1,
    origin: 'request',
    eligible: true,
    branchCreated: false,
    touched: false,
    lastPushedHead: null,
    notBuiltOrTested: null,
  };
  await tx.cloudAgentRun.update({
    where: { id: run.id },
    data: { repositories: [...repositories, repository] as unknown as Prisma.InputJsonArray },
  });
  await appendRunEvents(
    tx,
    { workspaceId: run.workspaceId, runId: run.id },
    [
      repositoryEvent(
        RunEventCode.RepositoryAdded,
        request.key,
        `Repository ${request.key} added at the agent's request`,
      ),
    ],
    at,
  );
  return repository;
}

/** Whether a person declined this repository for the run; asking again is then a tool error. */
async function isDeclined(tx: Tx, run: CloudAgentRun, key: string): Promise<boolean> {
  const decided = await tx.cloudAgentRunQuestion.findMany({
    where: {
      workspaceId: run.workspaceId,
      runId: run.id,
      kind: QuestionKind.RepositoryRequest,
      repositoryKey: key,
      state: QuestionState.Answered,
    },
  });
  return decided.some((row) => !isAdded(row));
}

function isAdded(row: CloudAgentRunQuestion): boolean {
  const answers = (row.answers ?? []) as unknown as QuestionAnswer[];
  return answers[0]?.labels[0] === ADD_REPOSITORY;
}

/** The question a person answers; the agent's reason is part of what they decide on. */
function repositoryQuestion(request: RepositoryRequest): AskedQuestion {
  return {
    question: `The agent asks to add repository \`${request.key}\` to this run. Add it?`,
    header: 'Repository',
    options: [
      {
        label: ADD_REPOSITORY,
        description: `Clone it into the run and continue with it. The agent's reason: ${request.reason}`.slice(
          0,
          2_000,
        ),
      },
      { label: DECLINE_REPOSITORY, description: 'The agent continues without it and notes the gap in its result.' },
    ],
    multiSelect: false,
  };
}

/**
 * At implement-turn completion: a `request_repo` stored under required
 * acceptance opens its repository-request question and the run waits for a
 * person. False when the turn requested nothing.
 */
export async function openRepositoryRequest(tx: Tx, run: CloudAgentRun, turnId: string, at: Date): Promise<boolean> {
  const turn = await tx.cloudAgentRunTurn.findUniqueOrThrow({ where: { id: turnId }, select: { repoRequest: true } });
  const request = turn.repoRequest as unknown as RepositoryRequest | null;
  if (!request) return false;
  const question = repositoryQuestion(request);
  const row = await tx.cloudAgentRunQuestion.create({
    data: {
      workspaceId: run.workspaceId,
      runId: run.id,
      kind: QuestionKind.RepositoryRequest,
      phase: RunPhase.Implement,
      state: QuestionState.Open,
      repositoryKey: request.key,
      questions: [question] as unknown as Prisma.InputJsonArray,
      askedInTurnId: turnId,
      askedAt: at,
    },
  });
  await setRunStatus(tx, run, RunStatus.AwaitingAnswer, at, { outcomeLessCount: 0 }, [
    {
      type: ServerEventType.Question,
      payload: { requestId: row.requestId, kind: row.kind, state: row.state, headers: [question.header] },
    },
  ]);
  return true;
}

/** Why these answers do not decide a repository request, or null: exactly one fixed option, no free text. */
export function repositoryAnswerProblem(answers: QuestionAnswer[]): string | null {
  const [answer] = answers;
  const labels = answer?.labels ?? [];
  const decided =
    answers.length === 1 &&
    !answer?.other &&
    labels.length === 1 &&
    (labels[0] === ADD_REPOSITORY || labels[0] === DECLINE_REPOSITORY);
  return decided ? null : `Choose "${ADD_REPOSITORY}" or "${DECLINE_REPOSITORY}".`;
}

/**
 * A person's decision, inside the answer transaction: "Add" appends the
 * repository, "Don't add" records the decline. The caller holds the locked
 * run and queues the resume turn.
 */
export async function applyRepositoryDecision(
  tx: Tx,
  run: CloudAgentRun,
  row: CloudAgentRunQuestion,
  at: Date,
): Promise<void> {
  const key = row.repositoryKey!;
  if (!isAdded(row)) {
    await appendRunEvents(
      tx,
      { workspaceId: run.workspaceId, runId: run.id },
      [repositoryEvent(RunEventCode.RepositoryDeclined, key, `Repository ${key} declined`)],
      at,
    );
    return;
  }
  if (runRepositories(run).some((repository) => repository.key === key)) return;
  const asking = row.askedInTurnId
    ? await tx.cloudAgentRunTurn.findUnique({ where: { id: row.askedInTurnId }, select: { repoRequest: true } })
    : null;
  const request = asking?.repoRequest as unknown as RepositoryRequest | null;
  await appendRequestedRepository(tx, run, { key, reason: request?.reason ?? 'Requested by the agent' }, at);
}

/** The resume turn's input after a decision. */
export function repositoryDecisionText(row: CloudAgentRunQuestion): string {
  const key = row.repositoryKey!;
  return isAdded(row)
    ? `Repository \`${key}\` was added to this run and is cloned in your working directory. Continue where you stopped.`
    : `Repository \`${key}\` was declined; continue without it or call submit_result noting the gap.`;
}

/** The decision a resume turn delivers, for its assignment. */
export async function repositoryDecisionForTurn(
  tx: Tx,
  workspaceId: string,
  turnId: string,
): Promise<TurnAssignment['repositoryDecision']> {
  const row = await tx.cloudAgentRunQuestion.findFirst({
    where: { workspaceId, resumeTurnId: turnId, kind: QuestionKind.RepositoryRequest, state: QuestionState.Answered },
  });
  return row?.repositoryKey ? { key: row.repositoryKey, added: isAdded(row) } : null;
}

/**
 * `request_repo` and its decision: validated like proposal repositories and
 * against the cap; appended mid-turn under automatic acceptance, or stored on
 * the turn and decided by a person under required acceptance.
 */
@Injectable()
export class CloudAgentRunRepositoryRequestService {
  constructor(private readonly implement: CloudAgentRunImplementService) {}

  /**
   * The live implement turn's request. The caller holds the fenced turn and
   * the locked run; `eligibility` maps every workspace repository key to why
   * it is not eligible, or null.
   */
  async request(
    tx: Tx,
    run: CloudAgentRun,
    turnId: string,
    request: RequestRepo,
    eligibility: Map<string, string | null>,
    at: Date,
  ): Promise<RequestRepoResponse> {
    if (run.status !== RunStatus.Implementing) {
      return rejected(['A question is waiting for a person; end your turn.']);
    }
    const repositories = runRepositories(run);
    // A retried attempt may repeat its request: a repository the run has is returned as it is.
    const existing = repositories.find((repository) => repository.key === request.key);
    if (existing) return this.added(run, existing);

    const errors: string[] = [];
    if (await isDeclined(tx, run, request.key)) {
      errors.push(
        `A person declined repository "${request.key}" for this run. Continue without it, or call submit_result noting the gap.`,
      );
    } else if (!eligibility.has(request.key)) {
      errors.push(
        `Repository "${request.key}" is not a repository key of this workspace. Use the durable keys the Coredoc MCP reports.`,
      );
    } else if (eligibility.get(request.key)) {
      errors.push(`Repository "${request.key}" is not eligible for agent runs (${eligibility.get(request.key)}).`);
    }
    if (repositories.length + 1 > run.maxRepositories) {
      errors.push(
        `This run allows at most ${run.maxRepositories} repositories and already has ${repositories.length}; continue without "${request.key}", or call submit_result noting the gap.`,
      );
    }
    if (errors.length) return rejected(errors);

    if (run.scopeAcceptancePolicy === 'automatic') {
      return this.added(run, await appendRequestedRepository(tx, run, request, at));
    }
    // Required acceptance: a person widens an accepted scope, whatever the questions policy.
    const turn = await tx.cloudAgentRunTurn.findUniqueOrThrow({ where: { id: turnId }, select: { repoRequest: true } });
    const pending = turn.repoRequest as unknown as RepositoryRequest | null;
    if (pending && pending.key !== request.key) {
      return rejected([`Repository "${pending.key}" is already waiting for a person's decision; end your turn.`]);
    }
    await tx.cloudAgentRunTurn.update({
      where: { id: turnId },
      data: { repoRequest: { key: request.key, reason: request.reason } },
    });
    return { state: 'requested', stop: false };
  }

  private async added(run: CloudAgentRun, repository: RunRepository): Promise<RequestRepoResponse> {
    const resolved = await this.implement.resolve(run.workspaceId, repository.key);
    if (typeof resolved === 'string') {
      return rejected([`Repository "${repository.key}" can no longer be used (${resolved}).`]);
    }
    return {
      state: 'added',
      repository: {
        key: repository.key,
        reason: repository.reason,
        mergeOrder: repository.mergeOrder,
        ...resolved,
        branchCreated: repository.branchCreated,
        withheldPaths: repository.withheldPaths ?? [],
      },
      stop: false,
    };
  }
}
