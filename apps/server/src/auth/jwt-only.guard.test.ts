import { describe, it, expect } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { JwtOnlyGuard } from './jwt-only.guard.js';

function ctx(request: Record<string, unknown>) {
  return { switchToHttp: () => ({ getRequest: () => request }) } as any;
}

describe('JwtOnlyGuard', () => {
  const guard = new JwtOnlyGuard();

  it('allows a JWT principal (no serviceTokenWorkspaceId)', () => {
    expect(guard.canActivate(ctx({ user: { id: 'u1' } }))).toBe(true);
  });

  it('rejects a service-token principal', () => {
    expect(() => guard.canActivate(ctx({ user: { id: 'u1' }, serviceTokenWorkspaceId: 'ws_1' }))).toThrow(
      ForbiddenException,
    );
  });
});
