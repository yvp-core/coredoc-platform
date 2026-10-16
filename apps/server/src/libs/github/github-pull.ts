import { z } from 'zod';

const sha = z.string().regex(/^[a-f0-9]{40}$/);

/** GitHub's pull request read, parsed strictly: what the intent handoff relies on. */
export const strictPullSchema = z.object({
  number: z.number().int().positive(),
  state: z.enum(['open', 'closed']),
  merged: z.boolean(),
  draft: z.boolean(),
  head: z.object({ sha }),
  base: z.object({ ref: z.string().min(1), repo: z.object({ full_name: z.string(), default_branch: z.string() }) }),
  merge_commit_sha: sha.nullable(),
  merged_at: z.iso.datetime({ offset: true }).nullable(),
});

export const strictPullWithHeadSchema = strictPullSchema.extend({
  head: z.object({ sha, ref: z.string().min(1), repo: z.object({ full_name: z.string() }).nullable() }),
});
