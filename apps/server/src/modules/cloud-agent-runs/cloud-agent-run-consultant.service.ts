import { HttpStatus, Injectable } from '@nestjs/common';
import { RepositoryMode } from '@coredoc/core/agent-runner';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { projectQuestion } from './cloud-agent-run-questions.service.js';
import { cloudAgentRunError, CloudAgentRunErrorCode, QuestionKind, QuestionState } from './run-states.js';

/** Only runs whose workflow works on no repository; the shape is the run's copy from its start. */
const NO_REPOSITORY: Prisma.CloudAgentRunWhereInput = {
  workflowShape: { path: ['repositories'], equals: RepositoryMode.None },
};

const RUN_FIELDS = { id: true, issueTitle: true, createdAt: true, updatedAt: true } as const;

type ConsultantRunRow = { id: string; issueTitle: string | null; createdAt: Date; updatedAt: Date };

/** What a consultant may see of a run: its name and times, never its issue, repositories or spend. */
function projectRun(run: ConsultantRunRow) {
  return {
    id: run.id,
    name: run.issueTitle,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

@Injectable()
export class CloudAgentRunConsultantService {
  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string, limit: number, offset: number) {
    const rows = await this.prisma.cloudAgentRun.findMany({
      where: { workspaceId, ...NO_REPOSITORY },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      skip: offset,
      select: RUN_FIELDS,
    });
    const page = rows.slice(0, limit);
    const counts = await this.prisma.cloudAgentRunQuestion.groupBy({
      by: ['runId', 'state'],
      where: {
        workspaceId,
        runId: { in: page.map((run) => run.id) },
        kind: QuestionKind.Clarification,
        state: { in: [QuestionState.Open, QuestionState.Cancelled] },
      },
      _count: { _all: true },
    });
    const count = (runId: string, state: QuestionState) =>
      counts.find((row) => row.runId === runId && row.state === state)?._count._all ?? 0;
    return {
      runs: page.map((run) => ({
        ...projectRun(run),
        openQuestions: count(run.id, QuestionState.Open),
        unansweredQuestions: count(run.id, QuestionState.Cancelled),
      })),
      nextOffset: rows.length > limit ? offset + limit : null,
    };
  }

  async questions(workspaceId: string, runId: string) {
    const run = await this.prisma.cloudAgentRun.findFirst({
      where: { id: runId, workspaceId, ...NO_REPOSITORY },
      select: RUN_FIELDS,
    });
    if (!run) throw runNotFound();
    const rows = await this.prisma.cloudAgentRunQuestion.findMany({
      where: {
        workspaceId,
        runId,
        kind: QuestionKind.Clarification,
        state: { in: [QuestionState.Open, QuestionState.Answered, QuestionState.Cancelled] },
      },
      orderBy: [{ askedAt: 'desc' }, { id: 'desc' }],
    });
    return {
      run: projectRun(run),
      records: rows.map((row) => {
        const { requestId, state, questions, answers, askedAt, answeredAt } = projectQuestion(row);
        return { requestId, state, questions, answers, askedAt, answeredAt };
      }),
    };
  }
}

function runNotFound() {
  return cloudAgentRunError(CloudAgentRunErrorCode.RunNotFound, 'Agent run not found', HttpStatus.NOT_FOUND);
}
