import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { TokenPermission } from './token-permissions.js';
import { ExactTelemetryTokenGuard } from './exact-telemetry-token.guard.js';

function contextFor(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('ExactTelemetryTokenGuard', () => {
  const guard = new ExactTelemetryTokenGuard();

  it('allows only a service-token principal with the exact telemetry purpose', () => {
    expect(
      guard.canActivate(
        contextFor({
          serviceTokenWorkspaceId: 'workspace-1',
          serviceTokenPermissions: [TokenPermission.TelemetryWrite],
        }),
      ),
    ).toBe(true);
  });

  it.each([
    ['JWT principal', {}],
    ['wildcard service token', { serviceTokenWorkspaceId: 'workspace-1', serviceTokenPermissions: ['*'] }],
    [
      'permission-superset service token',
      {
        serviceTokenWorkspaceId: 'workspace-1',
        serviceTokenPermissions: [TokenPermission.TelemetryWrite, TokenPermission.ResultRead],
      },
    ],
  ])('rejects a %s', (_name, request) => {
    expect(() => guard.canActivate(contextFor(request))).toThrow(ForbiddenException);
  });
});
