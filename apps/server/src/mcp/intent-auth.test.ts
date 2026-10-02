import { describe, it, expect } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { authorizeHumanReviewer, authorizeIntentPermission, INTENT_REVIEWER_ROLES } from './intent-auth.js';
import { McpAuthKind } from './mcp-auth-context.js';
import { TokenPermission } from '../auth/token-permissions.js';
import { WorkspaceMemberRole } from '../modules/members/dto/workspace-role.enum.js';

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';

function req(overrides: Record<string, unknown> = {}): Request {
  return {
    workspaceId: WORKSPACE_ID,
    user: { id: 'user_1', email: 'dev@example.com' },
    userWorkspaceRole: WorkspaceMemberRole.Member,
    mcpAuthKind: McpAuthKind.Jwt,
    ...overrides,
  } as unknown as Request;
}

function serviceReq(permissions: string[], role: string = WorkspaceMemberRole.Owner): Request {
  return req({
    mcpAuthKind: McpAuthKind.ServiceToken,
    userWorkspaceRole: role,
    serviceTokenPermissions: permissions,
  });
}

const ROLES = Object.values(WorkspaceMemberRole);

describe('trusted context', () => {
  it.each([
    ['workspaceId', { workspaceId: undefined }],
    ['user', { user: undefined }],
    ['mcpAuthKind', { mcpAuthKind: undefined }],
  ])('refuses a request missing the server-set %s', (_field, overrides) => {
    expect(() => authorizeIntentPermission(req(overrides), TokenPermission.IntentRead)).toThrow(ForbiddenException);
    expect(() => authorizeHumanReviewer(req(overrides))).toThrow('Trusted MCP workspace identity is required');
  });
});

describe('authorizeIntentPermission', () => {
  it.each(ROLES)('admits a user session with role %s without any token permission', (role) => {
    const auth = authorizeIntentPermission(
      req({ userWorkspaceRole: role, serviceTokenPermissions: undefined }),
      TokenPermission.IntentPropose,
    );
    expect(auth).toEqual({
      workspaceId: WORKSPACE_ID,
      actorId: 'user_1',
      role,
      authKind: McpAuthKind.Jwt,
    });
  });

  it.each([
    TokenPermission.IntentRead,
    TokenPermission.IntentPropose,
  ])('admits a service token carrying %s', (permission) => {
    const auth = authorizeIntentPermission(serviceReq([permission]), permission);
    expect(auth.authKind).toBe(McpAuthKind.ServiceToken);
    expect(auth.workspaceId).toBe(WORKSPACE_ID);
  });

  it('refuses a service token lacking the permission, even one created by an owner', () => {
    expect(() =>
      authorizeIntentPermission(serviceReq([TokenPermission.IntentRead]), TokenPermission.IntentPropose),
    ).toThrow('Service token requires intent:propose');
  });

  it('refuses a service token with no permissions at all', () => {
    expect(() => authorizeIntentPermission(serviceReq([]), TokenPermission.IntentRead)).toThrow(ForbiddenException);
  });

  it("does not honour a '*' permissions array — intent scopes are explicit-grant only", () => {
    // Mirrors PermissionsGuard's wildcard exemption on the REST side.
    expect(() => authorizeIntentPermission(serviceReq(['*']), TokenPermission.IntentRead)).toThrow(ForbiddenException);
  });
});

describe('authorizeHumanReviewer', () => {
  it('accepts every member role as a reviewer role (BR-1)', () => {
    expect(INTENT_REVIEWER_ROLES).toEqual([
      WorkspaceMemberRole.Owner,
      WorkspaceMemberRole.Admin,
      WorkspaceMemberRole.Product,
      WorkspaceMemberRole.Member,
    ]);
  });

  it.each(ROLES)('admits a %s user session', (role) => {
    const auth = authorizeHumanReviewer(req({ userWorkspaceRole: role }));
    expect(auth.role).toBe(role);
    expect(auth.authKind).toBe(McpAuthKind.Jwt);
    expect(auth.actorId).toBe('user_1');
  });

  it('refuses an unrecognised role string rather than passing it through', () => {
    expect(() => authorizeHumanReviewer(req({ userWorkspaceRole: 'maintainer' }))).toThrow(ForbiddenException);
  });

  it('refuses a user session whose role is missing', () => {
    expect(() => authorizeHumanReviewer(req({ userWorkspaceRole: undefined }))).toThrow(ForbiddenException);
  });

  it.each(
    ROLES,
  )('refuses a fully-permissioned service token created by a %s — no machine path to authority', (role) => {
    const request = serviceReq([TokenPermission.IntentRead, TokenPermission.IntentPropose, '*', 'token:manage'], role);
    expect(() => authorizeHumanReviewer(request)).toThrow(ForbiddenException);
    expect(() => authorizeHumanReviewer(request)).toThrow('user session, not a service token');
  });
});
