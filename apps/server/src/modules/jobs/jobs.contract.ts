/**
 * Query contract for the workspace job list.
 */
import { z } from 'zod';
import { intField, oneOfField } from '../../common/validators/field.js';
import { PushJobStatus } from '../../generated/prisma/client.js';

export const JobListQuerySchema = z.object({
  // Constrained to the Prisma-generated enum so an arbitrary `?status=foo` is rejected with 400
  // instead of bubbling up as a Prisma enum-violation 500 from the downstream query.
  status: oneOfField('status', Object.values(PushJobStatus)).optional(),
  // A query string is text on the wire; the old `@Type(() => Number)` conversion is this coercion.
  limit: z
    .preprocess(
      (value) => (typeof value === 'string' && value !== '' ? Number(value) : value),
      intField('limit', {
        min: 1,
        max: 200,
      }),
    )
    .optional(),
});

export type JobListQueryInput = z.infer<typeof JobListQuerySchema>;
