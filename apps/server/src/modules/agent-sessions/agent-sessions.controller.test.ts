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

  it('GET sessions/summary falls back to 30 days on a bogus days param', async () => {
    const res = await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/sessions/summary?days=bogus`);
    expect(res.status).toBe(200);
    expect(svc.getWorkspaceSessionSummary).toHaveBeenCalledWith(W, 30, undefined);
  });

  it('member → summary is self-scoped to the caller', async () => {
    principal = { user: { id: 'm1', email: 'm1@acme.com' }, userWorkspaceRole: 'member' };
    const scope = { userId: 'm1' };

    await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/sessions/summary?days=7`);
    expect(svc.getWorkspaceSessionSummary).toHaveBeenCalledWith(W, 7, scope);
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
