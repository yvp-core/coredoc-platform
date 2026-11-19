/**
 * Request body for creating or replacing an access area. An area is saved whole:
 * the body is its complete member and repo list, not a patch.
 */
import { z } from 'zod';
import { arrayField, stringField } from '../../common/validators/field.js';

export const SaveAccessAreaSchema = z.object({
  name: stringField('name', { notEmpty: true, max: 100 }),
  memberUserIds: arrayField('memberUserIds', stringField('memberUserIds[]', { notEmpty: true }), { max: 1000 }),
  repoKeys: arrayField('repoKeys', stringField('repoKeys[]', { notEmpty: true }), { max: 500 }),
});

export type SaveAccessAreaInput = z.infer<typeof SaveAccessAreaSchema>;
