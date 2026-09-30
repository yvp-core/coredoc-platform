import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { MetricsController } from './metrics.controller.js';
import { MetricsService } from './metrics.service.js';

function mockService() {
  return {
    getMcpQueryCount: vi.fn().mockResolvedValue(7),
    getMcpQueryBreakdown: vi.fn().mockResolvedValue([]),
    getMcpEmptyResultBreakdown: vi.fn().mockResolvedValue([]),
    getTimeseries: vi.fn().mockResolvedValue({ metric: 'mcp_calls', days: 30, points: [] }),
  };
}

// The real WorkspaceRoleGuard/AuthGuard are stubbed out (they hit the control
// plane); this middleware sets the exact request state those guards would leave
// so `@CurrentUser` / `@WorkspaceRoleValue` resolve against real values.
const MEMBER = { user: { id: 'u1', email: 'u1@acme.com' }, userWorkspaceRole: 'member' };
const ADMIN = { user: { id: 'u2', email: 'u2@acme.com' }, userWorkspaceRole: 'admin' };
const OWNER = { user: { id: 'u3', email: 'u3@acme.com' }, userWorkspaceRole: 'owner' };
// A service token authenticates as its creator (here a plain member) but also
// carries serviceTokenWorkspaceId — it must never be self-scoped.
const SERVICE_TOKEN = {
  user: { id: 'creator', email: 'service-token:ci' },
  userWorkspaceRole: 'member',
  serviceTokenWorkspaceId: 'ws_test',
};

describe('MetricsController self-scoping (integration)', () => {
  let app: INestApplication;
  let svc: ReturnType<typeof mockService>;
  let principal: Record<string, unknown>;
  const W = 'ws_test';

  beforeAll(async () => {
    svc = mockService();
    const ref = await Test.createTestingModule({
      controllers: [MetricsController],
      providers: [{ provide: MetricsService, useValue: svc }],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(WorkspaceRoleGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = ref.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use((req: Request, _res: Response, next: NextFunction) => {
      Object.assign(req, principal);
      next();
    });
    await app.init();
    // Bind IPv4 loopback: supertest's ephemeral '::' bind can collide with a 127.0.0.1-only local listener on macOS.
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('member → mcp/count called with a self-scope of the caller', async () => {
    principal = MEMBER;
    const res = await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/metrics/mcp/count`);
    expect(res.status).toBe(200);
    expect(svc.getMcpQueryCount).toHaveBeenCalledWith(W, { userId: 'u1' });
  });

  it('admin → mcp/count called workspace-wide (undefined scope)', async () => {
    principal = ADMIN;
    await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/metrics/mcp/count`);
    expect(svc.getMcpQueryCount).toHaveBeenCalledWith(W, undefined);
  });

  it('owner → mcp/count called workspace-wide (undefined scope)', async () => {
    principal = OWNER;
    await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/metrics/mcp/count`);
    expect(svc.getMcpQueryCount).toHaveBeenCalledWith(W, undefined);
  });

  it('service token → workspace-wide even though its role resolves to member', async () => {
    principal = SERVICE_TOKEN;
    await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/metrics/mcp/count`);
    expect(svc.getMcpQueryCount).toHaveBeenCalledWith(W, undefined);
  });

  it('member → breakdown and timeseries also forward the self-scope', async () => {
    principal = MEMBER;
    const scope = { userId: 'u1' };

    await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/metrics/mcp/breakdown?days=14`);
    expect(svc.getMcpQueryBreakdown).toHaveBeenCalledWith(W, 14, scope);

    await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/metrics/timeseries?metric=sessions&days=7`);
    expect(svc.getTimeseries).toHaveBeenCalledWith(W, 'sessions', 7, scope);
  });

  describe('mcp/empty-results (C3)', () => {
    it('member → forwards the self-scope and parsed days, same guards as mcp/breakdown', async () => {
      principal = MEMBER;
      const res = await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/metrics/mcp/empty-results?days=14`);

      expect(res.status).toBe(200);
      expect(svc.getMcpEmptyResultBreakdown).toHaveBeenCalledWith(W, 14, { userId: 'u1' });
    });

    it('admin → workspace-wide (undefined scope), default days when omitted', async () => {
      principal = ADMIN;
      await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/metrics/mcp/empty-results`);

      expect(svc.getMcpEmptyResultBreakdown).toHaveBeenCalledWith(W, 30, undefined);
    });

    it('returns the service rows verbatim', async () => {
      principal = OWNER;
      svc.getMcpEmptyResultBreakdown.mockResolvedValue([
        { toolName: 'search_symbols', total: 10, empty: 4, emptyRate: 0.4 },
      ]);

      const res = await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/metrics/mcp/empty-results`);

      expect(res.body).toEqual([{ toolName: 'search_symbols', total: 10, empty: 4, emptyRate: 0.4 }]);
    });
  });
});
