/**
 * Request bodies of the access administration API. A group and a repo's access
 * are each saved whole: the body is the complete list, not a patch.
 */
import { z } from 'zod';
import { REPO_ROLES } from '../../auth/iam.js';
import { arrayField, stringField } from '../../common/validators/field.js';

export const SaveGroupSchema = z.object({
  name: stringField('name', { notEmpty: true, max: 100 }),
  memberUserIds: arrayField('memberUserIds', stringField('memberUserIds[]', { notEmpty: true }), { max: 1000 }),
});
export type SaveGroupInput = z.infer<typeof SaveGroupSchema>;

const RepoBindingSchema = z
  .object({
    userId: z.string().min(1).optional(),
    groupId: z.string().uuid().optional(),
    role: z.enum(REPO_ROLES),
  })
  .refine((binding) => (binding.userId === undefined) !== (binding.groupId === undefined), {
    message: 'each binding names exactly one of userId and groupId',
  });

export const SaveRepoAccessSchema = z.object({
  restricted: z.boolean(),
  bindings: z.array(RepoBindingSchema).max(1000),
});
export type SaveRepoAccessInput = z.infer<typeof SaveRepoAccessSchema>;
