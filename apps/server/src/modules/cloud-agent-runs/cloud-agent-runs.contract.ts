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
});
export type StartRunInput = z.infer<typeof StartRunSchema>;

export const UpdateSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    /** Record the caller as the run owner Jira-triggered runs act as. */
    takeOverOwnership: z.literal(true).optional(),
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

export const EventsQuerySchema = z.object({
  after: nonNegativeInt('after', 0, 2_147_483_647),
  limit: nonNegativeInt('limit', 200, 500),
});
