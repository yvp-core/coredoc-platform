import { queryOptions } from '@tanstack/react-query';
import type { AskedQuestion, QuestionAnswer } from '../../features/agent-runs/types.js';
import { request } from '../client.js';

const base = (wsId: string) => `/api/v1/workspaces/${wsId}/consultant-runs`;

export const CONSULTANT_RUN_LIST_LIMIT = 50;

export interface ConsultantRun {
  id: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  openQuestions: number;
  unansweredQuestions: number;
}

export interface ConsultantRunList {
  runs: ConsultantRun[];
  nextOffset: number | null;
}

export interface ConsultantQuestionRecord {
  requestId: string;
  state: 'open' | 'answered' | 'cancelled';
  questions: AskedQuestion[];
  answers: QuestionAnswer[] | null;
  askedAt: string;
  answeredAt: string | null;
}

export interface ConsultantRunQuestions {
  run: Omit<ConsultantRun, 'openQuestions' | 'unansweredQuestions'>;
  records: ConsultantQuestionRecord[];
}

export const consultantRunsQueryOptions = (wsId: string, offset: number) =>
  queryOptions({
    queryKey: ['ws', wsId, 'consultant-runs', offset] as const,
    queryFn: () => request<ConsultantRunList>(`${base(wsId)}?limit=${CONSULTANT_RUN_LIST_LIMIT}&offset=${offset}`),
    refetchInterval: 10_000,
  });

export const consultantRunQuestionsQueryOptions = (wsId: string, runId: string) =>
  queryOptions({
    queryKey: ['ws', wsId, 'consultant-runs', runId, 'questions'] as const,
    queryFn: () => request<ConsultantRunQuestions>(`${base(wsId)}/${runId}/questions`),
    refetchInterval: 10_000,
  });
