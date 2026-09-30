import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { PermissionsGuard } from '../../auth/permissions.guard.js';
import { OtelIngestController } from './otel-ingest.controller.js';
import { AgentSessionsController } from './agent-sessions.controller.js';
import { AgentSessionsService } from './agent-sessions.service.js';

function emptyActivity(requestedDays = 30) {
  return {
    priceMap: { version: '2026-08-16', basis: 'standard-global-public-api-5m-cache-writes' },
    fineEventCoverage: {
      requestedDays,
      policyDays: 90,
      status: requestedDays <= 90 ? 'complete' : 'partial',
      purgedThroughReceivedAt: null,
    },
    captureHealth: [],
    sessions: [],
    mcpTools: [],
    capabilities: [],
    workflowRuns: [],
  };
}

function mockService() {
  return {
    applyMetricDeltas: vi.fn().mockResolvedValue(undefined),
    applyLogDeltas: vi.fn().mockResolvedValue(undefined),
    applySessionContext: vi.fn().mockResolvedValue(undefined),
    getWorkspaceSessionSummary: vi.fn().mockResolvedValue({
      sessionCount: 3,
      distinctUserCount: 2,
      medianTokens: 1200,
      medianActiveTimeSec: 40,
      medianCoredocToolCalls: 2,
      coredocHeavy: { sessionCount: 2, medianTokens: 900, medianActiveTimeSec: 30, medianCostUsd: 1 },
      coredocLight: { sessionCount: 1, medianTokens: 2000, medianActiveTimeSec: 60, medianCostUsd: 3 },
    }),
    getWorkspaceSessionsByUser: vi.fn().mockResolvedValue({
      users: [
        {
          userId: 'u1',
          userEmail: 'u1@acme.com',
          sessions: 2,
          tokens: 1500,
          costUsd: 4.5,
          coredocCalls: 6,
          topTool: 'search_symbols',
          lastActiveAt: '2026-07-01T10:00:00.000Z',
        },
      ],
    }),
    getWorkspaceActivity: vi.fn().mockImplementation(async (_workspaceId: string, days: number) => emptyActivity(days)),
  };
}

describe('agent-sessions endpoints (integration)', () => {
  let app: INestApplication;
  let svc: ReturnType<typeof mockService>;
  let principal: Record<string, unknown>;
  const W = 'ws_test';

  beforeAll(async () => {
    svc = mockService();
    const ref = await Test.createTestingModule({
      controllers: [OtelIngestController, AgentSessionsController],
      providers: [{ provide: AgentSessionsService, useValue: svc }],
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
    // Guards are stubbed, so this middleware supplies the request state they
    // would set. Default: an admin (workspace-wide) named u1 — the ingest tests
    // rely on that user identity for server-derived attribution.
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
    principal = { user: { id: 'u1', email: 'u1@acme.com' }, userWorkspaceRole: 'admin' };
    svc.getWorkspaceActivity
      .mockReset()
      .mockImplementation(async (_workspaceId: string, days: number) => emptyActivity(days));
  });

  it('POST otel/v1/metrics → 200 and calls applyMetricDeltas', async () => {
    const body = {
      resourceMetrics: [
        { resource: { attributes: [{ key: 'session.id', value: { stringValue: 's1' } }] }, scopeMetrics: [] },
      ],
    };
    const res = await request(app.getHttpServer()).post(`/api/v1/workspaces/${W}/otel/v1/metrics`).send(body);
    expect(res.status).toBe(200);
    expect(svc.applyMetricDeltas).toHaveBeenCalledWith(W, expect.any(Array));
  });

  it('POST otel/v1/logs → 200 and calls applyLogDeltas', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${W}/otel/v1/logs`)
      .send({ resourceLogs: [] });
    expect(res.status).toBe(200);
    expect(svc.applyLogDeltas).toHaveBeenCalledWith(W, expect.any(Array));
  });

  it('ingest attribution is server-derived — payload user.* attrs cannot spoof identity', async () => {
    const body = {
      resourceMetrics: [
        {
          resource: {
            attributes: [
              { key: 'session.id', value: { stringValue: 's-spoof' } },
              { key: 'user.id', value: { stringValue: 'attacker' } },
              { key: 'user.email', value: { stringValue: 'attacker@evil.example' } },
            ],
          },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'claude_code.token.usage',
                  sum: {
                    dataPoints: [{ asInt: '10', attributes: [{ key: 'type', value: { stringValue: 'input' } }] }],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const res = await request(app.getHttpServer()).post(`/api/v1/workspaces/${W}/otel/v1/metrics`).send(body);
    expect(res.status).toBe(200);
    const deltas = (svc.applyMetricDeltas as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    // Identity comes from the authenticated request (test middleware sets u1), never the payload.
    expect(deltas[0].userId).toBe('u1');
    expect(deltas[0].userEmail).toBe('u1@acme.com');
  });

  it('GET sessions/summary → 200 with the summary (admin → workspace-wide)', async () => {
    const res = await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/sessions/summary?days=7`);
    expect(res.status).toBe(200);
    expect(res.body.sessionCount).toBe(3);
    expect(svc.getWorkspaceSessionSummary).toHaveBeenCalledWith(W, 7, undefined);
  });

  it('GET sessions/by-user → 200 with the per-user rollup and parsed days', async () => {
    const res = await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/sessions/by-user?days=14`);
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0]).toMatchObject({
      userId: 'u1',
      userEmail: 'u1@acme.com',
      sessions: 2,
      topTool: 'search_symbols',
      lastActiveAt: '2026-07-01T10:00:00.000Z',
    });
    expect(svc.getWorkspaceSessionsByUser).toHaveBeenCalledWith(W, 14, undefined);
  });

  it('GET sessions/by-user falls back to 30 days on a bogus days param', async () => {
    const res = await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/sessions/by-user?days=bogus`);
    expect(res.status).toBe(200);
    expect(svc.getWorkspaceSessionsByUser).toHaveBeenCalledWith(W, 30, undefined);
  });

  it('member → summary and by-user are self-scoped to the caller', async () => {
    principal = { user: { id: 'm1', email: 'm1@acme.com' }, userWorkspaceRole: 'member' };
    const scope = { userId: 'm1' };

    await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/sessions/summary?days=7`);
    expect(svc.getWorkspaceSessionSummary).toHaveBeenCalledWith(W, 7, scope);

    await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/sessions/by-user?days=7`);
    expect(svc.getWorkspaceSessionsByUser).toHaveBeenCalledWith(W, 7, scope);
  });

  it('service token → workspace-wide even though its role resolves to member', async () => {
    principal = {
      user: { id: 'creator', email: 'service-token:ci' },
      userWorkspaceRole: 'member',
      serviceTokenWorkspaceId: W,
    };
    await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/sessions/summary?days=7`);
    expect(svc.getWorkspaceSessionSummary).toHaveBeenCalledWith(W, 7, undefined);
  });

  it('GET sessions/activity returns the provisioning-backed read model and self-scopes members', async () => {
    principal = { user: { id: 'm1', email: 'm1@acme.com' }, userWorkspaceRole: 'member' };
    const res = await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/sessions/activity?days=7`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      priceMap: { version: '2026-08-16', basis: 'standard-global-public-api-5m-cache-writes' },
      fineEventCoverage: {
        requestedDays: 7,
        policyDays: 90,
        status: 'complete',
        purgedThroughReceivedAt: null,
      },
      captureHealth: [],
      sessions: [],
      mcpTools: [],
      capabilities: [],
      workflowRuns: [],
    });
    expect(svc.getWorkspaceActivity).toHaveBeenCalledWith(W, 7, { userId: 'm1' });
  });

  it.each(['admin', 'owner'] as const)('GET sessions/activity remains workspace-wide for %ss', async (role) => {
    principal = { user: { id: role, email: `${role}@acme.com` }, userWorkspaceRole: role };
    await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/sessions/activity?days=14`);
    expect(svc.getWorkspaceActivity).toHaveBeenCalledWith(W, 14, undefined);
  });

  it('returns member A/member B/admin isolation in raw activity response bodies', async () => {
    const facts = [
      {
        userId: 'member-a',
        email: 'a@example.test',
        sessionId: 'session-a',
        capabilityId: 'skill-a',
        runId: 'cdr-20260816-aaaaaa',
        targetKey: 'repo:graph-a',
      },
      {
        userId: 'member-b',
        email: 'b@example.test',
        sessionId: 'session-b',
        capabilityId: 'skill-b',
        runId: 'cdr-20260816-bbbbbb',
        targetKey: 'profile:pilot',
      },
    ];
    svc.getWorkspaceActivity.mockImplementation(async (_workspaceId, _days, scope) => {
      const visible = scope ? facts.filter((fact) => fact.userId === scope.userId) : facts;
      return {
        ...emptyActivity(),
        captureHealth: visible.map((fact) => ({
          actorId: fact.userId,
          host: fact.userId === 'member-a' ? 'claude-code' : 'codex',
          targetKey: fact.targetKey,
        })),
        sessions: visible.map((fact) => ({ sessionId: fact.sessionId, userEmail: fact.email })),
        capabilities: visible.map((fact) => ({ capabilityId: fact.capabilityId })),
        workflowRuns: visible.map((fact) => ({ runId: fact.runId, actorId: fact.userId })),
      };
    });

    principal = { user: { id: 'member-a', email: 'a@example.test' }, userWorkspaceRole: 'member' };
    const memberA = await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/sessions/activity`);
    expect(memberA.body.captureHealth).toEqual([
      { actorId: 'member-a', host: 'claude-code', targetKey: 'repo:graph-a' },
    ]);
    expect(memberA.body.sessions).toEqual([{ sessionId: 'session-a', userEmail: 'a@example.test' }]);
    expect(memberA.body.capabilities).toEqual([{ capabilityId: 'skill-a' }]);
    expect(memberA.body.workflowRuns).toEqual([{ runId: 'cdr-20260816-aaaaaa', actorId: 'member-a' }]);
    expect(JSON.stringify(memberA.body)).not.toContain('member-b');

    principal = { user: { id: 'member-b', email: 'b@example.test' }, userWorkspaceRole: 'member' };
    const memberB = await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/sessions/activity`);
    expect(memberB.body.captureHealth).toEqual([{ actorId: 'member-b', host: 'codex', targetKey: 'profile:pilot' }]);
    expect(memberB.body.sessions).toEqual([{ sessionId: 'session-b', userEmail: 'b@example.test' }]);
    expect(JSON.stringify(memberB.body)).not.toContain('member-a');

    principal = { user: { id: 'admin', email: 'admin@example.test' }, userWorkspaceRole: 'admin' };
    const admin = await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/sessions/activity`);
    expect(admin.body.captureHealth).toHaveLength(2);
    expect(admin.body.sessions).toHaveLength(2);
    expect(admin.body.workflowRuns).toHaveLength(2);
  });

  it('POST sessions/:sessionId/context → 204 and forwards sanitized fields', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${W}/sessions/sess-9/context`)
      .send({
        branch: 'feat/ABC-123-x',
        issueKey: 'abc-123',
        prNumber: '17',
        headShaStart: 'a'.repeat(80),
        headShaEnd: 'beefcafe',
        junk: 'ignored',
      });
    expect(res.status).toBe(204);
    expect(svc.applySessionContext).toHaveBeenCalledWith(W, 'sess-9', {
      repoKey: undefined,
      branch: 'feat/ABC-123-x',
      issueKey: 'abc-123',
      prNumber: 17,
      specId: undefined,
      headShaStart: 'a'.repeat(64),
      headShaEnd: 'beefcafe',
    });
  });
});
