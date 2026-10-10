import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { AgentSessionsController } from '../modules/agent-sessions/agent-sessions.controller.js';
import { CloudAgentRunnerController } from '../modules/cloud-agent-runs/cloud-agent-runner.controller.js';
import { TokensController } from '../modules/tokens/tokens.controller.js';
import { AuthGuard } from './auth.guard.js';
import type { AuthService } from './auth.service.js';
import type { ControlPlaneService } from '../database/control-plane.service.js';
import { TokenPermission } from './token-permissions.js';

type Handler = (...args: never[]) => unknown;

function contextFor(handler: Handler): ExecutionContext {
  const request = { headers: { authorization: 'Bearer cdt_machine' }, method: 'POST' };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => Object,
  } as unknown as ExecutionContext;
}

function guard(token: { permissions: string[]; owningTurnId?: string | null }): AuthGuard {
  const controlPlane = {
    getServiceTokenByHash: vi.fn().mockResolvedValue({
      id: 'token-1',
      workspaceId: 'workspace-1',
      createdBy: 'admin-1',
      name: 'runner',
      owningTurnId: null,
      ...token,
    }),
    getMember: vi.fn().mockResolvedValue({ email: 'admin@example.com', role: 'admin' }),
  };
  return new AuthGuard(
    { verifyAccessToken: vi.fn() } as unknown as AuthService,
    controlPlane as unknown as ControlPlaneService,
    new Reflector(),
  );
}

const runner = { permissions: [TokenPermission.AgentRunnerRun] };

describe('exact agent-runner token fence', () => {
  it('admits a runner token on the runner API', async () => {
    await expect(
      guard(runner).canActivate(contextFor(CloudAgentRunnerController.prototype.claim as Handler)),
    ).resolves.toBe(true);
  });

  it.each([
    ['an existing permission-less member route', AgentSessionsController.prototype.summary],
    ['token administration', TokensController.prototype.listTokens],
  ])('refuses a runner token on %s', async (_name, handler) => {
    await expect(guard(runner).canActivate(contextFor(handler as Handler))).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('per-turn MCP tokens', () => {
  it('are refused on every REST route, including the runner API', async () => {
    const perTurn = { permissions: [TokenPermission.IntentRead], owningTurnId: 'turn-1' };
    for (const handler of [AgentSessionsController.prototype.summary, CloudAgentRunnerController.prototype.claim]) {
      await expect(guard(perTurn).canActivate(contextFor(handler as Handler))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    }
  });
});
