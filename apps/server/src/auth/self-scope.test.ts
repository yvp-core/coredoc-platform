import { describe, expect, it } from 'vitest';
import { WorkspaceMemberRole } from '../modules/members/dto/workspace-role.enum.js';
import type { AuthUser } from './decorators/current-user.decorator.js';
import { selfScopeFor } from './self-scope.js';

const user = { id: 'user_1' } as AuthUser;

describe('selfScopeFor', () => {
  it('scopes every member role below admin to its own data', () => {
    expect(selfScopeFor(user, WorkspaceMemberRole.Member)).toEqual({ userId: 'user_1' });
    expect(selfScopeFor(user, WorkspaceMemberRole.Product)).toEqual({ userId: 'user_1' });
    expect(selfScopeFor(user, 'something-new' as WorkspaceMemberRole)).toEqual({ userId: 'user_1' });
  });

  it('leaves admins, owners and service tokens workspace-wide', () => {
    expect(selfScopeFor(user, WorkspaceMemberRole.Admin)).toBeUndefined();
    expect(selfScopeFor(user, WorkspaceMemberRole.Owner)).toBeUndefined();
    expect(selfScopeFor(user, undefined)).toBeUndefined();
  });
});
