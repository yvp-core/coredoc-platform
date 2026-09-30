import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { PermissionsGuard } from '../../auth/permissions.guard.js';
import { FeedbackController } from './feedback.controller.js';
import { FeedbackService } from './feedback.service.js';

function mockService() {
  return {
    getRoadmap: vi.fn().mockResolvedValue({
      feedbackCount: 2,
      topIssues: [{ tool: 'trace_execution_path', issueType: 'incomplete', count: 2, severityScore: 9 }],
      topMissingTools: [{ need: 'find_tests_for_symbol', count: 2 }],
    }),
    getSessionCorrelation: vi.fn().mockResolvedValue([]),
    listRecords: vi.fn().mockResolvedValue({
      items: [],
      page: 1,
      limit: 25,
      total: 0,
      window: { days: 30, since: '2026-08-09T00:00:00.000Z', until: '2026-09-08T00:00:00.000Z' },
    }),
  };
}

describe('FeedbackController (integration)', () => {
  let app: INestApplication;
  let svc: ReturnType<typeof mockService>;
  let principal: Record<string, unknown>;
  const W = 'ws_test';
  beforeAll(async () => {
    svc = mockService();
    const ref = await Test.createTestingModule({
      controllers: [FeedbackController],
      providers: [{ provide: FeedbackService, useValue: svc }],
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
    app.use((r: Request, _res: Response, next: NextFunction) => {
      Object.assign(r, principal);
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
    principal = { user: { id: 'u1', email: 'e' }, userWorkspaceRole: 'admin' };
  });

  it('GET roadmap → 200 with ranked issues', async () => {
    const res = await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/mcp-feedback/roadmap?days=7`);
    expect(res.status).toBe(200);
    expect(res.body.topIssues[0].tool).toBe('trace_execution_path');
    expect(svc.getRoadmap).toHaveBeenCalledWith(W, 7, undefined);
  });

  it('member roadmap and correlation reads are scoped to the authenticated member', async () => {
    principal = { user: { id: 'member-a', email: 'a@example.test' }, userWorkspaceRole: 'member' };
    await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/mcp-feedback/roadmap?days=7`);
    await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/mcp-feedback/correlation?days=14`);

    expect(svc.getRoadmap).toHaveBeenCalledWith(W, 7, { userId: 'member-a' });
    expect(svc.getSessionCorrelation).toHaveBeenCalledWith(W, 14, { userId: 'member-a' });
  });

  describe('GET records', () => {
    const url = (qs = '') => `/api/v1/workspaces/${W}/mcp-feedback/records${qs}`;
    const lastQuery = () => svc.listRecords.mock.calls.at(-1)?.[1];

    it('defaults the window, paging and sort', async () => {
      const res = await request(app.getHttpServer()).get(url());
      expect(res.status).toBe(200);
      const q = lastQuery();
      expect(q.days).toBe(30);
      expect(q.page).toBe(1);
      expect(q.limit).toBe(25);
      expect(q.sort).toBe('createdAt');
      expect(q.order).toBe('desc');
      expect(q.reviewStatus).toBeNull();
      expect(q.area).toBeNull();
      expect(q.tool).toBeNull();
      expect(q.maxRating).toBeNull();
      expect(q.userId).toBeNull();
      expect(q.untilExclusive.getTime() - q.since.getTime()).toBe(30 * 86_400_000);
      expect(svc.listRecords.mock.calls.at(-1)?.[2]).toBeUndefined();
    });

    it('parses filters, sort and paging', async () => {
      const res = await request(app.getHttpServer()).get(
        url(
          '?days=7&page=3&limit=10&sort=userRating&order=asc&reviewStatus=amended&area=task-context&tool=search_symbols&maxRating=2',
        ),
      );
      expect(res.status).toBe(200);
      expect(lastQuery()).toMatchObject({
        days: 7,
        page: 3,
        limit: 10,
        sort: 'userRating',
        order: 'asc',
        reviewStatus: 'amended',
        area: 'task-context',
        tool: 'search_symbols',
        maxRating: 2,
      });
    });

    it('forwards the mcp-transport area, which the service widens to tool-only records', async () => {
      const res = await request(app.getHttpServer()).get(url('?area=mcp-transport'));
      expect(res.status).toBe(200);
      expect(lastQuery().area).toBe('mcp-transport');
    });

    it('a since..until range wins over days and resolves an exclusive end', async () => {
      const res = await request(app.getHttpServer()).get(url('?days=90&since=2026-09-01&until=2026-09-03'));
      expect(res.status).toBe(200);
      const q = lastQuery();
      expect(q.days).toBe(3);
      expect(q.since.toISOString()).toBe('2026-09-01T00:00:00.000Z');
      expect(q.untilExclusive.toISOString()).toBe('2026-09-04T00:00:00.000Z');
    });

    it('caps limit at 100 instead of 400ing', async () => {
      const res = await request(app.getHttpServer()).get(url('?limit=5000'));
      expect(res.status).toBe(200);
      expect(lastQuery().limit).toBe(100);
    });

    it.each([
      '?sort=tokens',
      '?order=sideways',
      '?reviewStatus=pending',
      '?area=nowhere',
      '?maxRating=9',
      '?maxRating=1.5',
      '?page=0',
      '?limit=0',
      '?since=2026-09-01',
      '?mine=yes',
      '?mine=true&userId=u1',
      `?tool=${'t'.repeat(129)}`,
      '?sort=createdAt&sort=userRating',
    ])('400s on malformed %s', async (qs) => {
      const res = await request(app.getHttpServer()).get(url(qs));
      expect(res.status).toBe(400);
    });

    it('admins may filter by another member id', async () => {
      const res = await request(app.getHttpServer()).get(url('?userId=member-b'));
      expect(res.status).toBe(200);
      expect(lastQuery().userId).toBe('member-b');
    });

    it('a member is self-scoped and may only ask for their own id', async () => {
      principal = { user: { id: 'member-a', email: 'a@example.test' }, userWorkspaceRole: 'member' };
      const own = await request(app.getHttpServer()).get(url('?userId=member-a'));
      expect(own.status).toBe(200);
      expect(svc.listRecords.mock.calls.at(-1)?.[2]).toEqual({ userId: 'member-a' });

      const mine = await request(app.getHttpServer()).get(url('?mine=true'));
      expect(mine.status).toBe(200);
      expect(lastQuery().userId).toBe('member-a');

      const other = await request(app.getHttpServer()).get(url('?userId=member-b'));
      expect(other.status).toBe(403);
    });
  });
});
