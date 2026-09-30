import { describe, it, expect } from 'vitest';
import { InternalServerErrorException } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import type { ExecutionContext } from '@nestjs/common';
import { WorkspaceRoleValue } from './workspace-role-value.decorator.js';
import { WorkspaceMemberRole } from '../../modules/members/dto/workspace-role.enum.js';

type ParamFactory = (data: unknown, ctx: ExecutionContext) => unknown;

/** Extract the factory NestJS registered for a `createParamDecorator` decorator. */
function factoryOf(decorator: () => ParameterDecorator): ParamFactory {
  class Probe {
    // biome-ignore lint/correctness/noUnusedFunctionParameters: decorator target only
    run(@decorator() _value: unknown): void {}
  }
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, 'run');
  return args[Object.keys(args)[0]].factory;
}

function mockContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const factory = factoryOf(WorkspaceRoleValue);

describe('@WorkspaceRoleValue', () => {
  it('returns the role WorkspaceRoleGuard set on the request', () => {
    expect(factory(null, mockContext({ userWorkspaceRole: 'member' }))).toBe(WorkspaceMemberRole.Member);
    expect(factory(null, mockContext({ userWorkspaceRole: 'admin' }))).toBe(WorkspaceMemberRole.Admin);
    expect(factory(null, mockContext({ userWorkspaceRole: 'owner' }))).toBe(WorkspaceMemberRole.Owner);
  });

  it('returns undefined for a service-token request, even when a role is present', () => {
    // A service token resolves userWorkspaceRole from the token *creator's*
    // membership, so that role must never drive self-scoping.
    const request = { userWorkspaceRole: 'member', serviceTokenWorkspaceId: 'ws_1' };
    expect(factory(null, mockContext(request))).toBeUndefined();
  });

  it('throws when the guard did not run (no role, no service token)', () => {
    expect(() => factory(null, mockContext({}))).toThrow(InternalServerErrorException);
  });
});
