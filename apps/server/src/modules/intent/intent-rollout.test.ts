import { describe, expect, it } from 'vitest';
import type { IntentConfig } from '../../config/app-config.js';
import { WorkspaceMemberRole } from '../members/dto/workspace-role.enum.js';
import { intentEnabledForActor } from './intent-rollout.js';

const UNSET: IntentConfig = {};
const PRODUCT_FIRST: IntentConfig = {
  rolloutRoles: [WorkspaceMemberRole.Owner, WorkspaceMemberRole.Admin, WorkspaceMemberRole.Product],
};

describe('intentEnabledForActor', () => {
  describe("INTENT_ROLES unset — today's behaviour", () => {
    it.each(Object.values(WorkspaceMemberRole))('follows the workspace flag alone for %s', (role) => {
      expect(intentEnabledForActor(true, role, UNSET)).toBe(true);
      expect(intentEnabledForActor(false, role, UNSET)).toBe(false);
    });

    it('does not need a resolved role', () => {
      expect(intentEnabledForActor(true, undefined, UNSET)).toBe(true);
    });
  });

  describe('INTENT_ROLES set', () => {
    it.each([
      WorkspaceMemberRole.Owner,
      WorkspaceMemberRole.Admin,
      WorkspaceMemberRole.Product,
    ])('lets an in-list %s through when the workspace has intent on', (role) => {
      expect(intentEnabledForActor(true, role, PRODUCT_FIRST)).toBe(true);
    });

    it('keeps intent off for an in-list role when the workspace has it off', () => {
      expect(intentEnabledForActor(false, WorkspaceMemberRole.Product, PRODUCT_FIRST)).toBe(false);
    });

    it('reports intent off for an out-of-list role even when the workspace has it on', () => {
      expect(intentEnabledForActor(true, WorkspaceMemberRole.Member, PRODUCT_FIRST)).toBe(false);
    });

    it('fails closed on an unresolved or unrecognised role', () => {
      expect(intentEnabledForActor(true, undefined, PRODUCT_FIRST)).toBe(false);
      expect(intentEnabledForActor(true, 'viewer', PRODUCT_FIRST)).toBe(false);
      expect(intentEnabledForActor(true, '', PRODUCT_FIRST)).toBe(false);
    });
  });
});
