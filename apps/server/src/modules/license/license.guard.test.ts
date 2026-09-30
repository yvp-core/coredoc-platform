import { describe, it, expect, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { LicenseState, type LicenseStatus } from './license-state.js';
import { LicenseGuard, isLicenseGatedRequest } from './license.guard.js';
import type { LicenseService } from './license.service.js';

function makeContext(method: string, path: string): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ method, path, url: path }) }),
  } as unknown as ExecutionContext;
}

function makeGuard(status: LicenseStatus): LicenseGuard {
  const service = {
    getStatus: vi.fn(() => status),
    isExpired: vi.fn(() => status.state === LicenseState.Expired),
  } as unknown as LicenseService;
  return new LicenseGuard(service);
}

const EXPIRED: LicenseStatus = {
  state: LicenseState.Expired,
  customer: 'acme-corp',
  expiresAt: '2026-01-01',
  graceDays: 30,
};

describe('LicenseGuard — no license configured', () => {
  it.each([
    ['POST', '/api/v1/workspaces/w1/push'],
    ['DELETE', '/api/v1/workspaces/w1'],
    ['GET', '/api/v1/workspaces'],
  ])('lets %s %s through (guard is a no-op without a license)', (method, path) => {
    const guard = makeGuard({ state: LicenseState.Absent });

    expect(guard.canActivate(makeContext(method, path))).toBe(true);
  });
});

describe('LicenseGuard — valid and grace states never block', () => {
  it.each([LicenseState.Valid, LicenseState.Grace])('%s allows mutating requests', (state) => {
    const guard = makeGuard({ ...EXPIRED, state });

    expect(guard.canActivate(makeContext('POST', '/api/v1/workspaces/w1/push'))).toBe(true);
  });
});

describe('LicenseGuard — expired past grace', () => {
  it('refuses a mutating /api/v1 request with LICENSE_EXPIRED', () => {
    const guard = makeGuard(EXPIRED);

    try {
      guard.canActivate(makeContext('POST', '/api/v1/workspaces/w1/push'));
      expect.unreachable('expected a ForbiddenException');
    } catch (error) {
      const response = (
        error as { getResponse: () => { code: string; message: string }; getStatus: () => number }
      ).getResponse();
      expect((error as { getStatus: () => number }).getStatus()).toBe(403);
      expect(response.code).toBe('LICENSE_EXPIRED');
      expect(response.message).toContain('2026-01-01');
    }
  });

  it.each([
    // Reads keep working — the graph stays queryable.
    ['GET', '/api/v1/workspaces/w1/graph'],
    ['HEAD', '/api/v1/workspaces'],
    // Probes must never be gated: an expired license must not take pods out of rotation.
    ['POST', '/api/v1/health'],
    // The status route itself has to answer so an operator can see why writes fail.
    ['POST', '/api/v1/license'],
    // ROOT_ROUTES (OAuth + MCP transport) are served outside the /api/v1 prefix.
    ['POST', '/token'],
    ['POST', '/register'],
    ['POST', '/mcp'],
    ['POST', '/messages'],
  ])('still allows %s %s', (method, path) => {
    const guard = makeGuard(EXPIRED);

    expect(guard.canActivate(makeContext(method, path))).toBe(true);
  });
});

describe('LicenseGuard — case-insensitive Express routing', () => {
  it.each([
    ['/API/v1/workspaces/w1/push'],
    ['/Api/V1/workspaces/w1/push'],
    ['/api/V1/workspaces/w1'],
  ])('still refuses a mutating request spelled %s', (path) => {
    const guard = makeGuard(EXPIRED);

    expect(() => guard.canActivate(makeContext('POST', path))).toThrow();
  });

  it('keeps the always-allowed routes reachable in any casing', () => {
    const guard = makeGuard(EXPIRED);

    expect(guard.canActivate(makeContext('POST', '/API/V1/HEALTH'))).toBe(true);
    expect(guard.canActivate(makeContext('POST', '/API/V1/License'))).toBe(true);
  });
});

describe('isLicenseGatedRequest', () => {
  it('matches on whole path segments, not string prefixes', () => {
    expect(isLicenseGatedRequest('POST', '/api/v1/licenses/foo')).toBe(true);
    expect(isLicenseGatedRequest('POST', '/api/v1/healthcheck')).toBe(true);
    expect(isLicenseGatedRequest('POST', '/api/v1/health/reset')).toBe(false);
    expect(isLicenseGatedRequest('POST', '/api/v2/anything')).toBe(false);
  });
});
