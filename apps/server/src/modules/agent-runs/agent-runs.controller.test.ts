import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { PermissionsGuard } from '../../auth/permissions.guard.js';
import { AgentRunsController } from './agent-runs.controller.js';
import { AgentRunsService } from './agent-runs.service.js';

function mockService() {
  return {
    record: vi.fn().mockResolvedValue(undefined),
    getWorkspaceAgentRuns: vi.fn().mockResolvedValue({
      totals: { runs: 2, costUsd: 1.5, tokensIn: 300, tokensOut: 600, turns: 5, toolCalls: 8, interventions: 1 },
      runs: [{ id: 'row-1' }, { id: 'row-2' }],
    }),
  };
}

const validSummary = {
  runId: 'run-1',
  kind: 'author-profile',
  tokensIn: 100,
  tokensOut: 200,
  costUsd: 0.42,
  turns: 3,
  toolCalls: 5,
  interventions: 1,
  outcome: 'success',
  durationMs: 12000,
};

describe('agent-runs endpoints (integration)', () => {
  let app: INestApplication;
  let svc: ReturnType<typeof mockService>;
  const W = 'ws_test';

  beforeAll(async () => {
    svc = mockService();
    const ref = await Test.createTestingModule({
      controllers: [AgentRunsController],
      providers: [{ provide: AgentRunsService, useValue: svc }],
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
    // Mirror main.ts so the DTO whitelist actually runs in the test.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    // Simulate AuthGuard's output: every request is an authenticated member, and
    // a `x-service-token: 1` header marks the principal as a service token
    // (AuthGuard sets serviceTokenWorkspaceId for cdt_ tokens). UserSessionGuard is
    // NOT overridden below, so the real guard runs against this shape.
    app.use(
      (req: Request & { user?: unknown; serviceTokenWorkspaceId?: string }, _res: Response, next: NextFunction) => {
        req.user = { id: 'u1', email: 'u1@acme.com' };
        if (req.headers['x-service-token'] === '1') {
          req.serviceTokenWorkspaceId = W;
        }
        next();
      },
    );
    await app.init();
    // Bind IPv4 loopback: supertest's ephemeral '::' bind can collide with a 127.0.0.1-only local listener on macOS.
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    await app.close();
  });

  it('POST agent-runs → 200 and records the run with server-derived identity', async () => {
    const res = await request(app.getHttpServer()).post(`/api/v1/workspaces/${W}/agent-runs`).send(validSummary);
    expect(res.status).toBe(200);
    expect(svc.record).toHaveBeenCalledWith(W, expect.objectContaining({ runId: 'run-1', costUsd: 0.42 }), {
      userId: 'u1',
      userEmail: 'u1@acme.com',
    });
  });

  it('POST strips non-DTO base props (install_id, session_id) and any payload user.*', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${W}/agent-runs`)
      .send({
        ...validSummary,
        install_id: 'inst-x',
        session_id: 'sess-x',
        userId: 'attacker',
        userEmail: 'attacker@evil.example',
      });
    expect(res.status).toBe(200);
    const forwarded = svc.record.mock.calls.at(-1)?.[1];
    expect(forwarded).not.toHaveProperty('install_id');
    expect(forwarded).not.toHaveProperty('session_id');
    expect(forwarded).not.toHaveProperty('userId');
    expect(forwarded).not.toHaveProperty('userEmail');
    // Identity is the authenticated principal, never the spoofed body values.
    const identity = svc.record.mock.calls.at(-1)?.[2];
    expect(identity).toEqual({ userId: 'u1', userEmail: 'u1@acme.com' });
  });

  it('POST rejects a negative economics value with 400', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${W}/agent-runs`)
      .send({ ...validSummary, costUsd: -1 });
    expect(res.status).toBe(400);
  });

  it('POST accepts optional appVersion and surface', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${W}/agent-runs`)
      .send({ ...validSummary, appVersion: '1.2.3', surface: 'desktop' });
    expect(res.status).toBe(200);
    const forwarded = svc.record.mock.calls.at(-1)?.[1];
    expect(forwarded).toMatchObject({ appVersion: '1.2.3', surface: 'desktop' });
  });

  it('GET agent-runs → 200 with totals and runs for a JWT member', async () => {
    const res = await request(app.getHttpServer()).get(`/api/v1/workspaces/${W}/agent-runs`);
    expect(res.status).toBe(200);
    expect(res.body.totals.runs).toBe(2);
    expect(res.body.runs).toHaveLength(2);
    expect(svc.getWorkspaceAgentRuns).toHaveBeenCalledWith(W);
  });

  it('GET agent-runs → 403 for a service-token principal (leaked telemetry-write token cannot read history)', async () => {
    const before = svc.getWorkspaceAgentRuns.mock.calls.length;
    const res = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${W}/agent-runs`)
      .set('x-service-token', '1');
    expect(res.status).toBe(403);
    // The guard fires before the handler, so the service is never reached.
    expect(svc.getWorkspaceAgentRuns.mock.calls.length).toBe(before);
  });

  it('POST agent-runs → 200 for a service-token principal (write stays open to telemetry tokens)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${W}/agent-runs`)
      .set('x-service-token', '1')
      .send(validSummary);
    expect(res.status).toBe(200);
  });
});
