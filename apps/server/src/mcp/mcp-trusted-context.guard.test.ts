import { describe, it, expect, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { McpTrustedContextGuard } from './mcp-trusted-context.guard.js';
import type { AuthUser } from '../auth/decorators/current-user.decorator.js';

function createMockContext(request: { user?: AuthUser; workspaceId?: string }): {
  context: ExecutionContext;
  setHeader: ReturnType<typeof vi.fn>;
} {
  const setHeader = vi.fn();
  const response = { setHeader };
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
  return { context, setHeader };
}

describe('McpTrustedContextGuard', () => {
  const guard = new McpTrustedContextGuard();

  it('allows a request carrying the trusted context set by the rewrite middleware', () => {
    const user: AuthUser = { id: 'user_1', email: 'test@example.com' };
    const { context } = createMockContext({ user, workspaceId: 'ws_1' });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects a direct root-route request with no context (the auth-bypass attempt)', () => {
    const { context, setHeader } = createMockContext({});
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(setHeader).toHaveBeenCalledWith('WWW-Authenticate', expect.stringContaining('Bearer'));
  });

  it('rejects when workspaceId is present but user is missing (auth not completed)', () => {
    const { context } = createMockContext({ workspaceId: 'ws_1' });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects when user is present but workspaceId is missing', () => {
    const user: AuthUser = { id: 'user_1', email: 'test@example.com' };
    const { context } = createMockContext({ user });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });
});
