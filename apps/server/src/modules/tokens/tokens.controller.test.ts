import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TokensController } from './tokens.controller.js';
import type { TokensService } from './tokens.service.js';
import { CreateTokenSchema, TokenScope, type CreateTokenInput } from './tokens.contract.js';
import type { AuthUser } from '../../auth/decorators/current-user.decorator.js';

const CI_PERMS = [
  'parser:read',
  'parser:write',
  'result:read',
  'result:write',
  'repo:push',
  'intent:release',
  'intent:bindings',
];
const user: AuthUser = { id: 'user_1', email: 'a@b.com' };

/** A JWT/session request: `AuthGuard` sets no `serviceTokenWorkspaceId` on one. */
const userSession = {} as Request;
/** The legacy grant-all service token the wildcard exemption exists to hold back. */
const wildcardServiceToken = { serviceTokenWorkspaceId: 'ws_1', serviceTokenPermissions: ['*'] } as unknown as Request;

function mockService() {
  return {
    createToken: vi.fn().mockResolvedValue({
      id: 't',
      name: 'n',
      token: 'cdt_x',
      permissions: [],
      expiresAt: null,
      createdAt: new Date('2026-01-01'),
    }),
    listTokens: vi.fn().mockResolvedValue([]),
    getTokenValue: vi.fn().mockResolvedValue('cdt_secret'),
  };
}

describe('TokensController.createToken — scope → curated permissions', () => {
  let svc: ReturnType<typeof mockService>;
  let controller: TokensController;

  beforeEach(() => {
    svc = mockService();
    controller = new TokensController(svc as unknown as TokensService);
  });

  it('defaults to CI permissions when no scope is given', async () => {
    await controller.createToken('ws_1', { name: 'ci' } as CreateTokenInput, user, userSession);
    expect(svc.createToken.mock.calls[0][4]).toEqual(CI_PERMS);
  });

  it('maps scope=ci to CI permissions', async () => {
    await controller.createToken('ws_1', { name: 'ci', scope: 'ci' } as CreateTokenInput, user, userSession);
    expect(svc.createToken.mock.calls[0][4]).toEqual(CI_PERMS);
  });

  it('maps scope=intent-agent to intent read + propose only', async () => {
    await controller.createToken(
      'ws_1',
      { name: 'agent', scope: TokenScope.IntentAgent } as CreateTokenInput,
      user,
      userSession,
    );
    expect(svc.createToken.mock.calls[0][4]).toEqual(['intent:read', 'intent:propose']);
  });

  it('rejects the removed intent-release mint scope', () => {
    const parsed = CreateTokenSchema.safeParse({ name: 'old-release', scope: 'intent-release' });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]).toMatchObject({ path: ['scope'] });
  });

  it('keeps intent read and propose out of the CI scope', async () => {
    await controller.createToken('ws_1', { name: 'ci' } as CreateTokenInput, user, userSession);
    const minted = svc.createToken.mock.calls[0][4] as string[];
    expect(minted).not.toContain('intent:read');
    expect(minted).not.toContain('intent:propose');
  });

  it('refuses telemetry scope so the member self-mint route stays the only cloud-token mint path', async () => {
    await expect(
      controller.createToken('ws_1', { name: 'tel', scope: 'telemetry' } as CreateTokenInput, user, userSession),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(svc.createToken).not.toHaveBeenCalled();
  });
});

describe('TokensController — intent-agent scope needs a user session', () => {
  let svc: ReturnType<typeof mockService>;
  let controller: TokensController;

  beforeEach(() => {
    svc = mockService();
    controller = new TokensController(svc as unknown as TokensService);
  });

  it('refuses a service token minting intent-agent, closing the wildcard delegation path', async () => {
    await expect(
      controller.createToken(
        'ws_1',
        { name: 'agent', scope: TokenScope.IntentAgent } as CreateTokenInput,
        user,
        wildcardServiceToken,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(svc.createToken).not.toHaveBeenCalled();
  });

  it.each([undefined, TokenScope.Ci])('refuses service-token minting of CI scope %s', async (scope) => {
    await expect(
      controller.createToken('ws_1', { name: 'ci', scope }, user, wildcardServiceToken),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(svc.createToken).not.toHaveBeenCalled();
  });

  it('refuses a service token revealing an intent-release token value', async () => {
    svc.listTokens.mockResolvedValue([{ id: 'tok_release', permissions: ['intent:release'] }]);
    await expect(controller.getTokenValue('ws_1', 'tok_release', wildcardServiceToken)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(svc.getTokenValue).not.toHaveBeenCalled();
  });

  it('lets a user session mint intent-agent', async () => {
    await controller.createToken(
      'ws_1',
      { name: 'agent', scope: TokenScope.IntentAgent } as CreateTokenInput,
      user,
      userSession,
    );
    expect(svc.createToken.mock.calls[0]?.[4]).toEqual(['intent:read', 'intent:propose']);
  });

  it('refuses a service token revealing an intent-agent token value', async () => {
    svc.listTokens.mockResolvedValue([{ id: 'tok_intent', permissions: ['intent:read', 'intent:propose'] }]);
    await expect(controller.getTokenValue('ws_1', 'tok_intent', wildcardServiceToken)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(svc.getTokenValue).not.toHaveBeenCalled();
  });

  it('refuses service-token reveal of a CI token with intent writes', async () => {
    svc.listTokens.mockResolvedValue([{ id: 'tok_ci', permissions: CI_PERMS }]);
    await expect(controller.getTokenValue('ws_1', 'tok_ci', wildcardServiceToken)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('does not spend a list query when a human admin reveals a value', async () => {
    await expect(controller.getTokenValue('ws_1', 'tok_ci', userSession)).resolves.toEqual({ token: 'cdt_secret' });
    expect(svc.listTokens).not.toHaveBeenCalled();
  });
});
