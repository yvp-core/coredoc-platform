import { BadRequestException, HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import type { AskedQuestion, ReportQuestion, ReportQuestionResponse } from '@coredoc/core/agent-runner';
import { PrismaService } from '../../database/prisma.service.js';
import type { CloudAgentRun, CloudAgentRunQuestion, Prisma } from '../../generated/prisma/client.js';
import {
  applyRepositoryDecision,
  repositoryAnswerProblem,
  repositoryDecisionText,
} from './cloud-agent-run-repository-requests.service.js';
import type { QuestionAnswer } from './cloud-agent-runs.contract.js';
import {
  CloudAgentRunErrorCode,
  cloudAgentRunError,
  isTerminalRunStatus,
  QuestionKind,
  QuestionState,
  RunPhase,
  RunStatus,
  ServerEventType,
} from './run-states.js';
import { appendRunEvents, CLOUD_AGENT_RUNS_CLOCK, type Clock, systemClock, type Tx } from './run-store.js';
import { lockRun, queueTurn, setRunStatus } from './run-transitions.js';

/** What the assume policy answers every question with. */
export const ASSUME_ANSWER =
  'No one is available to answer. Choose the option you judge best, continue, and list this decision in the assumptions of your next propose_scope or submit_result call.';

const ACTIVE_STATUS_OF_PHASE: Record<string, string> = {
  [RunPhase.Scope]: RunStatus.Scoping,
  [RunPhase.Implement]: RunStatus.Implementing,
};

const asQuestions = (row: CloudAgentRunQuestion) => row.questions as unknown as AskedQuestion[];
const asAnswers = (row: CloudAgentRunQuestion) => (row.answers ?? null) as unknown as QuestionAnswer[] | null;

/** One answer as AskUserQuestion takes it: the chosen labels and any free text, comma-separated. */
function answerText(answer: QuestionAnswer): string {
  return [...answer.labels, ...(answer.other ? [answer.other] : [])].join(', ');
}

/** The answers keyed by question text, the shape the resumed AskUserQuestion call receives. */
export function sdkAnswers(row: CloudAgentRunQuestion): Record<string, string> {
  const answers = asAnswers(row) ?? [];
  return Object.fromEntries(asQuestions(row).map((q, index) => [q.question, answerText(answers[index]!)]));
}

/** The resume turn's input: the answers again, in case the deferred call is not re-run. */
function resumeText(row: CloudAgentRunQuestion): string {
  if (row.kind === QuestionKind.RepositoryRequest) return repositoryDecisionText(row);
  const lines = Object.entries(sdkAnswers(row)).map(([question, answer]) => `- ${question} ${answer}`);
  return ['A person answered your question in Coredoc:', ...lines, '', 'Continue where you stopped.'].join('\n');
}

function questionEvent(row: CloudAgentRunQuestion) {
  return {
    type: ServerEventType.Question,
    payload: {
      requestId: row.requestId,
      kind: row.kind,
      state: row.state,
      headers: asQuestions(row).map((question) => question.header),
    },
  };
}

/**
 * Records an AskUserQuestion call the live turn reported. Under assume it is
 * answered at once; under pause it is parked and the run waits for a person.
 * The caller holds the fenced turn and the locked run.
 */
export async function recordQuestion(
  tx: Tx,
  run: CloudAgentRun,
  turnId: string,
  report: ReportQuestion,
  at: Date,
): Promise<ReportQuestionResponse> {
  const base = {
    workspaceId: run.workspaceId,
    runId: run.id,
    kind: QuestionKind.Clarification,
    phase: run.phase,
    toolUseId: report.toolUseId,
    questions: report.questions as unknown as Prisma.InputJsonArray,
    askedInTurnId: turnId,
    askedAt: at,
  };
  if (run.questionsPolicy === 'assume') {
    const row = await tx.cloudAgentRunQuestion.create({
      data: {
        ...base,
        state: QuestionState.AutoAnswered,
        answers: report.questions.map(() => ({ labels: [], other: ASSUME_ANSWER })) as Prisma.InputJsonArray,
        answeredAt: at,
      },
    });
    await appendRunEvents(tx, { workspaceId: run.workspaceId, runId: run.id, turnId }, [questionEvent(row)], at);
    return { state: 'auto_answered', requestId: row.requestId, answers: sdkAnswers(row), stop: false };
  }

  if (!ACTIVE_STATUS_OF_PHASE[run.phase] || run.status !== ACTIVE_STATUS_OF_PHASE[run.phase]) {
    return { state: 'refused', reason: 'A question is already waiting for a person; end your turn.', stop: false };
  }
  const row = await tx.cloudAgentRunQuestion.create({ data: { ...base, state: QuestionState.Open } });
  await setRunStatus(tx, run, RunStatus.AwaitingAnswer, at, {}, [questionEvent(row)]);
  return { state: 'open', requestId: row.requestId, stop: false };
}

/**
 * At the end of a turn (completion, or lease expiry): whether the turn ended
 * with a question parked for a person. An answer that arrived while the turn
 * was still running is turned into the resume turn here. Either way the
 * outcome-less count resets.
 */
export async function settleTurnQuestions(tx: Tx, run: CloudAgentRun, turnId: string, at: Date): Promise<boolean> {
  const asked = await tx.cloudAgentRunQuestion.findMany({
    where: {
      workspaceId: run.workspaceId,
      runId: run.id,
      askedInTurnId: turnId,
      kind: QuestionKind.Clarification,
      state: { in: [QuestionState.Open, QuestionState.Answered] },
    },
  });
  if (asked.length === 0) return false;
  await tx.cloudAgentRun.update({ where: { id: run.id }, data: { outcomeLessCount: 0 } });
  const waiting = asked.find((row) => row.state === QuestionState.Answered && row.resumeTurnId === null);
  if (waiting) await queueResumeTurn(tx, run, waiting, at);
  return true;
}

async function queueResumeTurn(tx: Tx, run: CloudAgentRun, row: CloudAgentRunQuestion, at: Date): Promise<void> {
  const turnId = await queueTurn(tx, run, row.phase, resumeText(row), at);
  if (turnId) await tx.cloudAgentRunQuestion.update({ where: { id: row.id }, data: { resumeTurnId: turnId } });
}

/** The answered question a resume turn delivers, for its assignment. */
export async function answerForTurn(tx: Tx, workspaceId: string, turnId: string) {
  const row = await tx.cloudAgentRunQuestion.findFirst({
    where: { workspaceId, resumeTurnId: turnId, kind: QuestionKind.Clarification, state: QuestionState.Answered },
  });
  return row ? { requestId: row.requestId, toolUseId: row.toolUseId ?? '', answers: sdkAnswers(row) } : null;
}

export function projectQuestion(row: CloudAgentRunQuestion) {
  return {
    requestId: row.requestId,
    kind: row.kind,
    phase: row.phase,
    state: row.state,
    questions: asQuestions(row),
    answers: asAnswers(row),
    askedAt: row.askedAt.toISOString(),
    answeredAt: row.answeredAt?.toISOString() ?? null,
    answeredBy: row.answeredBy,
    /** The turn that asked, whose trace shows the question. */
    askedInTurnId: row.askedInTurnId,
  };
}

/** Why these answers do not answer these questions, or null when they do. */
function answerProblem(questions: AskedQuestion[], answers: QuestionAnswer[]): string | null {
  if (answers.length !== questions.length) {
    return `Answer each of the ${questions.length} questions, in order.`;
  }
  for (const [index, question] of questions.entries()) {
    const answer = answers[index]!;
    const labels = new Set(question.options.map((option) => option.label));
    const unknown = answer.labels.find((label) => !labels.has(label));
    if (unknown) return `"${unknown}" is not an option of "${question.header}".`;
    if (new Set(answer.labels).size !== answer.labels.length) return `Choose each option of "${question.header}" once.`;
    const chosen = answer.labels.length + (answer.other ? 1 : 0);
    if (chosen === 0) return `"${question.header}" has no answer.`;
    if (!question.multiSelect && chosen > 1) return `"${question.header}" takes one answer.`;
  }
  return null;
}

/** A person's answer: one compare-and-set from open; the next turn is queued under the usual rule. */
@Injectable()
export class CloudAgentRunQuestionService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(CLOUD_AGENT_RUNS_CLOCK) private readonly now: Clock = systemClock,
  ) {}

  async answer(workspaceId: string, runId: string, requestId: string, actorId: string, answers: QuestionAnswer[]) {
    await this.prisma.$transaction(async (tx) => {
      const run = await lockRun(tx, workspaceId, runId);
      if (!run) {
        throw cloudAgentRunError(CloudAgentRunErrorCode.RunNotFound, 'Agent run not found', HttpStatus.NOT_FOUND);
      }
      const row = await tx.cloudAgentRunQuestion.findFirst({ where: { workspaceId, runId, requestId } });
      if (!row) {
        throw cloudAgentRunError(CloudAgentRunErrorCode.QuestionNotFound, 'Question not found', HttpStatus.NOT_FOUND);
      }
      if (isTerminalRunStatus(run.status)) {
        throw cloudAgentRunError(CloudAgentRunErrorCode.RunTerminal, 'The run has already ended');
      }
      if (row.state !== QuestionState.Open) throw alreadyAnswered();
      const problem =
        row.kind === QuestionKind.RepositoryRequest
          ? repositoryAnswerProblem(answers)
          : answerProblem(asQuestions(row), answers);
      if (problem) throw new BadRequestException(problem);

      const at = this.now();
      const claimed = await tx.cloudAgentRunQuestion.updateMany({
        where: { id: row.id, state: QuestionState.Open },
        data: {
          state: QuestionState.Answered,
          answers: answers as unknown as Prisma.InputJsonArray,
          answeredAt: at,
          answeredBy: actorId,
        },
      });
      if (claimed.count !== 1) throw alreadyAnswered();
      const answered = await tx.cloudAgentRunQuestion.findUniqueOrThrow({ where: { id: row.id } });

      const resumed = await setRunStatus(tx, run, ACTIVE_STATUS_OF_PHASE[row.phase] ?? run.status, at, {}, [
        {
          type: ServerEventType.QuestionResolved,
          payload: { requestId, state: QuestionState.Answered, answeredBy: actorId },
        },
      ]);
      if (row.kind === QuestionKind.RepositoryRequest) await applyRepositoryDecision(tx, resumed, answered, at);
      // While the asking turn is still completing, its completion queues the resume turn instead.
      await queueResumeTurn(tx, resumed, answered, at);
    });
  }

  /** Every question of a run, oldest first. */
  async forRun(workspaceId: string, runId: string) {
    const rows = await this.prisma.cloudAgentRunQuestion.findMany({
      where: { workspaceId, runId },
      orderBy: [{ askedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(projectQuestion);
  }
}

function alreadyAnswered() {
  return cloudAgentRunError(CloudAgentRunErrorCode.QuestionAlreadyAnswered, 'This question has already been answered');
}
