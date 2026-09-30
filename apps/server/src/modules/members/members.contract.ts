/**
 * Request bodies for workspace membership: invitations and role changes.
 */
import { z } from 'zod';
import { emailField, oneOfField } from '../../common/validators/field.js';
import { ASSIGNABLE_ROLES } from './dto/workspace-role.enum.js';

export const InviteMemberSchema = z.object({
  email: emailField('email'),
  role: oneOfField('role', ASSIGNABLE_ROLES).optional(),
});

export const UpdateMemberRoleSchema = z.object({
  // The bespoke message the decorator carried: shorter than the default enum phrasing.
  role: z.custom<(typeof ASSIGNABLE_ROLES)[number]>(
    (value) => (ASSIGNABLE_ROLES as readonly unknown[]).includes(value),
    `role must be one of: ${ASSIGNABLE_ROLES.join(', ')}`,
  ),
});

export type InviteMemberInput = z.infer<typeof InviteMemberSchema>;
export type UpdateMemberRoleInput = z.infer<typeof UpdateMemberRoleSchema>;
