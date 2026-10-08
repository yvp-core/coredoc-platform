/**
 * Request bodies of the human cloud agent runs API. The runner API's bodies
 * come from the shared contract, `@coredoc/core/agent-runner`.
 */
import { QUESTIONS_POLICIES, SCOPE_ACCEPTANCE_POLICIES } from '@coredoc/core/agent-runner';
import { z } from 'zod';

/** A Jira issue key: project key, dash, number. Upper-cased before matching. */
export const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}-[1-9][0-9]{0,17}$/;

export const StartRunSchema = z.object({
  issueKey: z
    .string({ error: 'issueKey must be a string' })
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(ISSUE_KEY_RE, { error: 'issueKey must look like PROJ-123' })),
  questionsPolicy: z.enum(QUESTIONS_POLICIES).optional(),
  scopeAcceptancePolicy: z.enum(SCOPE_ACCEPTANCE_POLICIES).optional(),
  /** Repository keys that become the run's seeds. */
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

export const UpdateSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    /** Record the caller as the run owner Jira-triggered runs act as. */
    takeOverOwnership: z.literal(true).optional(),
    triggerLabel: z
      .string()
      .regex(/^\S{1,255}$/, { error: 'triggerLabel must be a Jira label: 1 to 255 characters, no spaces' })
      .optional(),
    /** The Jira status the done transition moves to; null for none. */
    doneStatus: z
      .object({ id: z.string().trim().min(1).max(64), name: z.string().trim().min(1).max(255) })
      .strict()
      .nullable()
      .optional(),
    questionsPolicy: z.enum(QUESTIONS_POLICIES).optional(),
    scopeAcceptancePolicy: z.enum(SCOPE_ACCEPTANCE_POLICIES).optional(),
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

export const EventsQuerySchema = z.object({
  after: nonNegativeInt('after', 0, 2_147_483_647),
  limit: nonNegativeInt('limit', 200, 500),
});
