import { QuestionsPolicy, ScopeAcceptancePolicy, TurnKind } from '@coredoc/core/agent-runner';
import { z } from 'zod';

/** Upper-cased before matching. */
export const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}-[1-9][0-9]{0,17}$/;

export const StartRunSchema = z.object({
  issueKey: z
    .string({ error: 'issueKey must be a string' })
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(ISSUE_KEY_RE, { error: 'issueKey must look like PROJ-123' })),
  questionsPolicy: z.enum(QuestionsPolicy).optional(),
  scopeAcceptancePolicy: z.enum(ScopeAcceptancePolicy).optional(),
  repositoryKeys: z
    .array(z.string().trim().min(1).max(255), { error: 'repositoryKeys must be an array of repository keys' })
    .max(50)
    .optional(),
});
export type StartRunInput = z.infer<typeof StartRunSchema>;

const intBetween = (field: string, min: number, max: number) =>
  z
    .number({ error: `${field} must be a number` })
    .int({ error: `${field} must be an integer` })
    .min(min, { error: `${field} must be at least ${min}` })
    .max(max, { error: `${field} must be at most ${max}` });

const jiraStatusName = (field: string) =>
  z
    .string({ error: `${field} must be a Jira status name` })
    .trim()
    .min(1, { error: `${field} must be a Jira status name` })
    .max(255, { error: `${field} must be at most 255 characters` })
    .nullable()
    .optional();

export const UpdateSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    takeOverOwnership: z.literal(true).optional(),
    triggerLabel: z
      .string()
      .regex(/^\S{1,255}$/, { error: 'triggerLabel must be a Jira label: 1 to 255 characters, no spaces' })
      .optional(),
    startedStatus: jiraStatusName('startedStatus'),
    doneStatus: jiraStatusName('doneStatus'),
    failedStatus: jiraStatusName('failedStatus'),
    cancelledStatus: jiraStatusName('cancelledStatus'),
    questionsPolicy: z.enum(QuestionsPolicy).optional(),
    scopeAcceptancePolicy: z.enum(ScopeAcceptancePolicy).optional(),
    maxSpendUsd: z
      .number({ error: 'maxSpendUsd must be a number' })
      .positive({ error: 'maxSpendUsd must be positive' })
      .max(10_000, { error: 'maxSpendUsd must be at most 10000' })
      .optional(),
    maxTurnDurationSeconds: intBetween('maxTurnDurationSeconds', 300, 86_400).optional(),
    maxActiveSeconds: intBetween('maxActiveSeconds', 600, 30 * 86_400).optional(),
    waitingLimitSeconds: intBetween('waitingLimitSeconds', 3_600, 90 * 86_400).optional(),
    maxStartedRuns: intBetween('maxStartedRuns', 1, 50).optional(),
    maxRepositories: intBetween('maxRepositories', 1, 20).optional(),
    /** Null means Claude Code's default model. */
    model: z
      .string()
      .regex(/^[A-Za-z0-9._:@[\]-]{1,128}$/, { error: 'model must be a model id' })
      .nullable()
      .optional(),
  })
  .strict();
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsSchema>;

const nonNegativeInt = (field: string, fallback: number, max: number) =>
  z.coerce
    .number({ error: `${field} must be a number` })
    .int({ error: `${field} must be an integer` })
    .min(0, { error: `${field} must not be negative` })
    .max(max)
    .default(fallback);

export const ListRunsQuerySchema = z.object({
  limit: nonNegativeInt('limit', 50, 100),
  offset: nonNegativeInt('offset', 0, 1_000_000),
});

export const RequestScopeChangesSchema = z.object({
  text: z
    .string({ error: 'text must be a string' })
    .trim()
    .min(1, { error: 'Describe the changes you want' })
    .max(20_000, { error: 'text must be at most 20000 characters' }),
});
export type RequestScopeChangesInput = z.infer<typeof RequestScopeChangesSchema>;

/** One answer per question, in question order. */
export const AnswerQuestionSchema = z.object({
  answers: z
    .array(
      z.object({
        labels: z.array(z.string().max(200), { error: 'labels must be an array of option labels' }).max(4).default([]),
        other: z
          .string({ error: 'other must be a string' })
          .trim()
          .max(4_000, { error: 'other must be at most 4000 characters' })
          .optional()
          .transform((value) => value || undefined),
      }),
      { error: 'answers must be an array with one answer per question' },
    )
    .min(1)
    .max(4),
});
export type AnswerQuestionInput = z.output<typeof AnswerQuestionSchema>;
export type QuestionAnswer = AnswerQuestionInput['answers'][number];

export const TranscriptQuerySchema = z.object({
  /** Defaults to the run's latest agent phase. */
  phase: z.enum([TurnKind.Scope, TurnKind.Implement], { error: 'phase must be scope or implement' }).optional(),
});
export type TranscriptQuery = z.infer<typeof TranscriptQuerySchema>;

export const EventsQuerySchema = z.object({
  after: nonNegativeInt('after', 0, 2_147_483_647),
  limit: nonNegativeInt('limit', 200, 500),
});
