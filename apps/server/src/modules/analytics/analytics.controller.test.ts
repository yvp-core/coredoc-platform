import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { PermissionsGuard } from '../../auth/permissions.guard.js';
import { AnalyticsController } from './analytics.controller.js';
import { MAX_ANALYTICS_DAYS, UsageAnalyticsService } from './usage-analytics.service.js';

function mockService() {
  return { getWorkspaceUsage: vi.fn().mockResolvedValue({ window: { days: 30 } }) };
}

// The real guards hit the control plane; this middleware sets the exact request
// state they would leave so `@CurrentUser` / `@WorkspaceRoleValue` resolve.
const MEMBER = { user: { id: 'u1', email: 'u1@acme.com' }, userWorkspaceRole: 'member' };
const ADMIN = { user: { id: 'u2', email: 'u2@acme.com' }, userWorkspaceRole: 'admin' };
const OWNER = { user: { id: 'u3', email: 'u3@acme.com' }, userWorkspaceRole: 'owner' };
// A service token authenticates as its creator but arrives without a workspace
// role value, so it is workspace-wide — never self-scoped.
const SERVICE_TOKEN = {
  user: { id: 'creator', email: 'service-token:ci' },
  userWorkspaceRole: 'member',
  serviceTokenWorkspaceId: 'ws_test',
};

describe('AnalyticsController (integration)', () => {
  let app: INestApplication;
  let svc: ReturnType<typeof mockService>;
  let principal: Record<string, unknown>;
  const W = 'ws_test';

  beforeAll(async () => {
    svc = mockService();
    const ref = await Test.createTestingModule({
      controllers: [AnalyticsController],
      providers: [{ provide: UsageAnalyticsService, useValue: svc }],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(WorkspaceRoleGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionsGuard)
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

  it('member → usage read is self-scoped to the caller', async () => {
    principal = MEMBER;
    const res = await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/analytics/usage?days=7`);
    expect(res.status).toBe(200);
    expect(svc.getWorkspaceUsage).toHaveBeenCalledWith(W, 7, { userId: 'u1' }, null);
  });

  it('admin and owner → workspace-wide (undefined scope)', async () => {
    principal = ADMIN;
    await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/analytics/usage?days=7`);
    principal = OWNER;
    await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/analytics/usage?days=7`);
    expect(svc.getWorkspaceUsage).toHaveBeenNthCalledWith(1, W, 7, undefined, null);
    expect(svc.getWorkspaceUsage).toHaveBeenNthCalledWith(2, W, 7, undefined, null);
  });

  it('service token → workspace-wide (undefined scope)', async () => {
    principal = SERVICE_TOKEN;
    await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/analytics/usage`);
    expect(svc.getWorkspaceUsage).toHaveBeenCalledWith(W, 30, undefined, null);
  });

  it('days above the ceiling clamps to the analytics maximum (LIM-4)', async () => {
    principal = ADMIN;
    await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/analytics/usage?days=500`);
    expect(svc.getWorkspaceUsage).toHaveBeenCalledWith(W, MAX_ANALYTICS_DAYS, undefined, null);
  });

  it('a custom since..until range wins over days and reaches the service as UTC bounds', async () => {
    principal = ADMIN;
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${W}/analytics/usage?days=7&since=2026-08-01&until=2026-08-31`)
      .expect(200);
    expect(svc.getWorkspaceUsage).toHaveBeenCalledWith(W, 7, undefined, {
      days: 31,
      since: new Date('2026-08-01T00:00:00.000Z'),
      untilExclusive: new Date('2026-09-01T00:00:00.000Z'),
    });
  });

  it('answers 400 for a half-specified, malformed, inverted or oversized range', async () => {
    principal = ADMIN;
    for (const query of [
      'since=2026-08-01',
      'until=2026-08-31',
      'since=2026-8-1&until=2026-08-31',
      'since=2026-02-30&until=2026-03-01',
      'since=2026-08-31&until=2026-08-01',
      'since=2026-01-01&until=2026-08-01',
    ]) {
      await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/analytics/usage?${query}`).expect(400);
    }
    expect(svc.getWorkspaceUsage).not.toHaveBeenCalled();
  });

  it('answers 400 for an `until` later than today (UTC), and accepts today itself', async () => {
    principal = ADMIN;
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${W}/analytics/usage?since=${day(-1)}&until=${day(1)}`)
      .expect(400);
    expect(svc.getWorkspaceUsage).not.toHaveBeenCalled();

    // The current, still-incomplete UTC day is a legitimate end.
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${W}/analytics/usage?since=${day(-1)}&until=${day(0)}`)
      .expect(200);
    expect(svc.getWorkspaceUsage).toHaveBeenCalledTimes(1);
  });

  it('missing or non-numeric days falls back to the default window', async () => {
    principal = ADMIN;
    await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/analytics/usage?days=foo`);
    await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/analytics/usage`);
    expect(svc.getWorkspaceUsage).toHaveBeenNthCalledWith(1, W, 30, undefined, null);
    expect(svc.getWorkspaceUsage).toHaveBeenNthCalledWith(2, W, 30, undefined, null);
  });
});
