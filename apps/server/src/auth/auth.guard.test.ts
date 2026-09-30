import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from './auth.guard.js';
import { SESSION_COOKIE, CSRF_HEADER, CSRF_HEADER_VALUE } from './web/web-auth.constants.js';
import type { AuthService } from './auth.service.js';
import type { ControlPlaneService } from '../database/control-plane.service.js';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthUser } from './decorators/current-user.decorator.js';

function createMockContext(
  headers: Record<string, string | undefined> = {},
  options: { method?: string; cookies?: Record<string, string> } = {},
): {
  context: ExecutionContext;
  request: {
    headers: Record<string, string | undefined>;
    method: string;
    cookies?: Record<string, string>;
    user?: AuthUser;
    serviceTokenId?: string;
    serviceTokenWorkspaceId?: string;
    authVia?: string;
  };
} {
  const request = {
    headers,
    method: options.method ?? 'GET',
    cookies: options.cookies,
    user: undefined as AuthUser | undefined,
    serviceTokenWorkspaceId: undefined as string | undefined,
    authVia: undefined as string | undefined,
  };
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('AuthGuard', () => {
  let guard: AuthGuard;
  let authService: { verifyAccessToken: ReturnType<typeof vi.fn> };
  let controlPlane: { getServiceTokenByHash: ReturnType<typeof vi.fn>; getMember: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    authService = {
      verifyAccessToken: vi.fn(),
    };
    controlPlane = {
      getServiceTokenByHash: vi.fn(),
      getMember: vi.fn(),
    };
    guard = new AuthGuard(
      authService as unknown as AuthService,
      controlPlane as unknown as ControlPlaneService,
      new Reflector(),
    );
  });

  it('throws UnauthorizedException when no Authorization header', async () => {
    const { context } = createMockContext({});
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when Authorization header lacks Bearer prefix', async () => {
    const { context } = createMockContext({ authorization: 'Basic abc' });
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('verifies JWT token and attaches user to request', async () => {
    const mockUser: AuthUser = { id: 'user_1', email: 'test@example.com' };
    authService.verifyAccessToken.mockResolvedValue(mockUser);

    const { context, request } = createMockContext({ authorization: 'Bearer valid.jwt.token' });
    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(authService.verifyAccessToken).toHaveBeenCalledWith('valid.jwt.token');
    expect(request.user).toEqual(mockUser);
    expect(request.authVia).toBe('bearer');
  });

  it('throws UnauthorizedException when JWT verification fails', async () => {
    authService.verifyAccessToken.mockRejectedValue(new Error('invalid'));

    const { context } = createMockContext({ authorization: 'Bearer bad.jwt.token' });
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('resolves service tokens via SHA-256 hash lookup and stamps the creator real email', async () => {
    controlPlane.getServiceTokenByHash.mockResolvedValue({
      id: 'tok_1',
      workspaceId: 'ws_1',
      name: 'ci-push',
      createdBy: 'user_1',
      permissions: [],
    });
    // The creating member's real email is resolved from their membership so
    // OTel attribution shows the person, not `service-token:ci-push`.
    controlPlane.getMember.mockResolvedValue({ workspaceId: 'ws_1', userId: 'user_1', email: 'creator@acme.com' });

    const { context, request } = createMockContext({ authorization: 'Bearer cdt_some_token' });
    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(controlPlane.getServiceTokenByHash).toHaveBeenCalled();
    expect(controlPlane.getMember).toHaveBeenCalledWith('ws_1', 'user_1');
    expect(request.user).toBeDefined();
    expect(request.user!.id).toBe('user_1');
    expect(request.user!.email).toBe('creator@acme.com');
    expect(request.serviceTokenWorkspaceId).toBe('ws_1');
    expect(request.serviceTokenId).toBe('tok_1');
  });

  it('falls back to service-token:<name> when the creating member has no membership row', async () => {
    controlPlane.getServiceTokenByHash.mockResolvedValue({
      id: 'tok_1',
      workspaceId: 'ws_1',
      name: 'otel',
      createdBy: 'deleted_user',
      permissions: [],
    });
    // Member was removed → no email persists → keep the identifiable marker.
    controlPlane.getMember.mockResolvedValue(null);

    const { context, request } = createMockContext({ authorization: 'Bearer cdt_some_token' });
    await guard.canActivate(context);

    expect(request.user!.id).toBe('deleted_user');
    expect(request.user!.email).toBe('service-token:otel');
  });

  it('throws UnauthorizedException for invalid service tokens', async () => {
    controlPlane.getServiceTokenByHash.mockResolvedValue(null);

    const { context } = createMockContext({ authorization: 'Bearer cdt_invalid_token' });
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('allows a GET request authenticated by the session cookie', async () => {
    const mockUser: AuthUser = { id: 'user_1', email: 'test@example.com' };
    authService.verifyAccessToken.mockResolvedValue(mockUser);

    const { context, request } = createMockContext(
      {},
      { method: 'GET', cookies: { [SESSION_COOKIE]: 'valid.jwt.token' } },
    );
    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(authService.verifyAccessToken).toHaveBeenCalledWith('valid.jwt.token');
    expect(request.user).toEqual(mockUser);
    expect(request.authVia).toBe('cookie');
  });

  it('throws ForbiddenException for a cookie-authenticated POST without the CSRF header', async () => {
    const mockUser: AuthUser = { id: 'user_1', email: 'test@example.com' };
    authService.verifyAccessToken.mockResolvedValue(mockUser);

    const { context } = createMockContext({}, { method: 'POST', cookies: { [SESSION_COOKIE]: 'valid.jwt.token' } });

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('allows a cookie-authenticated POST with the correct CSRF header', async () => {
    const mockUser: AuthUser = { id: 'user_1', email: 'test@example.com' };
    authService.verifyAccessToken.mockResolvedValue(mockUser);

    const { context, request } = createMockContext(
      { [CSRF_HEADER]: CSRF_HEADER_VALUE },
      { method: 'POST', cookies: { [SESSION_COOKIE]: 'valid.jwt.token' } },
    );
    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(request.user).toEqual(mockUser);
    expect(request.authVia).toBe('cookie');
  });

  it('throws ForbiddenException for a cookie-authenticated POST with the wrong CSRF value', async () => {
    const mockUser: AuthUser = { id: 'user_1', email: 'test@example.com' };
    authService.verifyAccessToken.mockResolvedValue(mockUser);

    const { context } = createMockContext(
      { [CSRF_HEADER]: 'true' },
      { method: 'POST', cookies: { [SESSION_COOKIE]: 'valid.jwt.token' } },
    );

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('throws UnauthorizedException for an invalid or expired session cookie without evaluating CSRF', async () => {
    authService.verifyAccessToken.mockRejectedValue(new Error('invalid'));

    const { context } = createMockContext({}, { method: 'POST', cookies: { [SESSION_COOKIE]: 'bad.jwt.token' } });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('prefers the Bearer header over a session cookie when both are present', async () => {
    const mockUser: AuthUser = { id: 'user_1', email: 'test@example.com' };
    authService.verifyAccessToken.mockResolvedValue(mockUser);

    const { context, request } = createMockContext(
      { authorization: 'Bearer bearer.jwt.token' },
      { method: 'POST', cookies: { [SESSION_COOKIE]: 'cookie.jwt.token' } },
    );
    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(authService.verifyAccessToken).toHaveBeenCalledWith('bearer.jwt.token');
    expect(request.authVia).toBe('bearer');
  });

  it('throws UnauthorizedException when neither a Bearer header nor a session cookie is present', async () => {
    const { context } = createMockContext({}, { method: 'GET', cookies: {} });
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });
});
