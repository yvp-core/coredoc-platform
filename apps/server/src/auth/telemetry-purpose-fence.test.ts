import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { CaptureController } from '../modules/capture/capture.controller.js';
import { AgentSessionsController } from '../modules/agent-sessions/agent-sessions.controller.js';
import { OtelIngestController } from '../modules/agent-sessions/otel-ingest.controller.js';
import { WorkspacesController } from '../modules/workspaces/workspaces.controller.js';
import { AuthGuard } from './auth.guard.js';
import type { AuthService } from './auth.service.js';
import type { ControlPlaneService } from '../database/control-plane.service.js';
import { TokenPermission } from './token-permissions.js';

function contextFor(handler: (...args: never[]) => unknown): ExecutionContext {
  const request = {
    headers: { authorization: 'Bearer cdt_telemetry' },
    method: 'POST',
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => Object,
  } as unknown as ExecutionContext;
}

function guard(): AuthGuard {
  const controlPlane = {
    getServiceTokenByHash: vi.fn().mockResolvedValue({
      workspaceId: 'workspace-1',
      createdBy: 'owner-1',
      name: 'capture-owner-1',
      permissions: [TokenPermission.TelemetryWrite],
    }),
    getMember: vi.fn().mockResolvedValue({ email: 'owner@example.com', role: 'owner' }),
  };
  return new AuthGuard(
    { verifyAccessToken: vi.fn() } as unknown as AuthService,
    controlPlane as unknown as ControlPlaneService,
    new Reflector(),
  );
}

describe('exact telemetry-purpose token fence', () => {
  it.each([
    ['dedicated capture ingest', CaptureController.prototype.ingest],
    ['native OTLP metrics ingest', OtelIngestController.prototype.metrics],
  ])('allows %s', async (_name, handler) => {
    await expect(guard().canActivate(contextFor(handler as (...args: never[]) => unknown))).resolves.toBe(true);
  });

  it.each([
    ['representative session read', AgentSessionsController.prototype.summary],
    ['workspace deletion', WorkspacesController.prototype.deleteWorkspace],
  ])('returns 403 for %s', async (_name, handler) => {
    await expect(guard().canActivate(contextFor(handler as (...args: never[]) => unknown))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
