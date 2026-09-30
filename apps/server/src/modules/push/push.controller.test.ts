/**
 * Integration test: NoSourceCodePipe wiring in PushController
 *
 * Verifies that the NoSourceCodePipe is actually invoked in the full Nest
 * request pipeline — not just in the unit test that calls transform() directly.
 *
 * Key technique: uses Test.createTestingModule + createNestApplication to build
 * a real Nest app, overrides all auth guards (canActivate → true), injects a
 * req.user stub via middleware, and drives requests via supertest.
 *
 * If any of the sourceCode-rejection tests fail (get 200/201 instead of 400),
 * that is proof the pipe is NOT wired correctly. The test comments call this out
 * explicitly.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';

// ---- Auth guards we must override ----
import { AuthGuard } from '../../auth/auth.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { PermissionsGuard } from '../../auth/permissions.guard.js';

// ---- The SUT ----
import { PushController } from './push.controller.js';
import { PushService } from './push.service.js';
import { PushQueueService } from '../job-queue/push-queue.service.js';
import type { VersionPushInput } from './push.contract.js';
import type { AuthUser } from '../../auth/decorators/current-user.decorator.js';

// =============================================================================
// Mock PushService — stub every method used by the controller
// =============================================================================

function createMockPushService() {
  return {
    getWorkspaceGraphBackend: vi.fn().mockResolvedValue('turso'),
    uploadResult: vi.fn().mockResolvedValue({ version: 'v1', sizeBytes: 10 }),
    pushByVersion: vi.fn().mockResolvedValue({
      repoName: 'repo',
      mode: 'incremental',
      nodesAdded: 0,
      nodesUpdated: 0,
      nodesDeleted: 0,
      edgesDeleted: 0,
      edgesInserted: 0,
      unchanged: 0,
      version: 'v1',
      totalNodeCount: 0,
      totalEdgeCount: 0,
    }),
    uploadSummary: vi.fn().mockResolvedValue({ version: 'sum_1', sizeBytes: 5 }),
    uploadEmbeddings: vi.fn().mockResolvedValue({ version: 'emb_1', sizeBytes: 5 }),
    getLatestSummary: vi.fn().mockResolvedValue(null),
    getLatestSummaryUrl: vi.fn().mockResolvedValue(null),
  };
}

function createMockPushQueueService() {
  return {
    enqueuePush: vi.fn().mockResolvedValue({ id: 'job_x' }),
  };
}

// =============================================================================
// Test suite
// =============================================================================

describe('PushController — NoSourceCodePipe wiring (integration)', () => {
  let app: INestApplication;
  let mockPushService: ReturnType<typeof createMockPushService>;
  let mockPushQueueService: ReturnType<typeof createMockPushQueueService>;

  const W = 'ws_test';
  const R = 'repo_test';
  const UPLOAD_URL = `/api/v1/workspaces/${W}/repos/${R}/results/upload`;
  const PUSH_URL = `/api/v1/workspaces/${W}/repos/${R}/push`;

  beforeAll(async () => {
    mockPushService = createMockPushService();
    mockPushQueueService = createMockPushQueueService();

    const moduleRef = await Test.createTestingModule({
      controllers: [PushController],
      providers: [
        { provide: PushService, useValue: mockPushService },
        { provide: PushQueueService, useValue: mockPushQueueService },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(WorkspaceRoleGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();

    // Replicate production pipe config
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

    // Global prefix to match controller paths in the test URLs
    app.setGlobalPrefix('api/v1');

    // Middleware to inject a stub user so @CurrentUser() param decorator works
    app.use((req: Request & { user?: unknown }, _res: Response, next: NextFunction) => {
      req.user = { id: 'test-user', email: 'test@example.com' };
      next();
    });

    await app.init();
    // Bind IPv4 loopback: supertest's ephemeral '::' bind can collide with a 127.0.0.1-only local listener on macOS.
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  // ---------------------------------------------------------------------------
  // (a) POST /results/upload — sourceCode in body must be rejected
  // ---------------------------------------------------------------------------
  it('(a) upload with sourceCode → 400 and service NOT called', async () => {
    mockPushService.uploadResult.mockClear();

    const res = await request(app.getHttpServer())
      .post(UPLOAD_URL)
      .send({ id: 'repo', functions: [{ id: 'f', sourceCode: 'function foo() {}' }] })
      .set('Content-Type', 'application/json');

    // CRITICAL: if this is 200/201, the pipe is NOT running — report immediately
    expect(
      res.status,
      `PIPE NOT WIRED: POST ${UPLOAD_URL} with sourceCode payload returned ${res.status} instead of 400. ` +
        'The NoSourceCodePipe is not executing in the Nest request pipeline.',
    ).toBe(400);

    const body = res.body as { message?: string | string[] };
    const message = Array.isArray(body.message) ? body.message.join(' ') : (body.message ?? '');
    expect(message).toContain('sourceCode');

    expect(mockPushService.uploadResult).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // (b) POST /results/upload — clean body must pass pipe and reach service
  // ---------------------------------------------------------------------------
  it('(b) upload with clean body → 200/201 and service called once', async () => {
    mockPushService.uploadResult.mockClear();

    const res = await request(app.getHttpServer())
      .post(UPLOAD_URL)
      .send({ id: 'repo', functions: [{ id: 'f', name: 'foo' }] })
      .set('Content-Type', 'application/json');

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    expect(mockPushService.uploadResult).toHaveBeenCalledTimes(1);
    // First call, first positional arg after workspaceId and repoName
    const bodyArg = mockPushService.uploadResult.mock.calls[0][2];
    expect(bodyArg).toMatchObject({ id: 'repo' });
  });

  // ---------------------------------------------------------------------------
  // (c) POST /push?sync=true — clean version reference body passes pipe and
  //     runs inline via pushByVersion (sync opt-in)
  // ---------------------------------------------------------------------------
  it('(c) push clean version reference with ?sync=true → 200/201 and pushByVersion called', async () => {
    mockPushService.pushByVersion.mockClear();

    const res = await request(app.getHttpServer())
      .post(`${PUSH_URL}?sync=true`)
      .send({ parsedVersion: 'v1' })
      .set('Content-Type', 'application/json');

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    expect(mockPushService.pushByVersion).toHaveBeenCalledTimes(1);
    const args = mockPushService.pushByVersion.mock.calls[0];
    expect(args[0]).toBe(W); // workspaceId
    expect(args[1]).toBe(R); // repoName
    expect(args[2]).toBe('v1'); // parsedVersion
  });

  // ---------------------------------------------------------------------------
  // (f) POST /push — default (no ?sync) enqueues and returns { jobId, status } with 202
  // ---------------------------------------------------------------------------
  it('(d) push clean version reference (default async) → 202 Accepted and enqueuePush called', async () => {
    mockPushQueueService.enqueuePush.mockClear();
    mockPushService.pushByVersion.mockClear();

    const res = await request(app.getHttpServer())
      .post(PUSH_URL)
      .send({ parsedVersion: 'v1' })
      .set('Content-Type', 'application/json');

    // Spec §6.1: async branch must return 202 Accepted.
    expect(res.status).toBe(202);

    expect(mockPushQueueService.enqueuePush).toHaveBeenCalledTimes(1);
    expect(mockPushService.pushByVersion).not.toHaveBeenCalled();
    const body = res.body as { jobId: string; status: string };
    expect(body.status).toBe('queued');
    expect(typeof body.jobId).toBe('string');
  });

  it('rejects contradictory metadata versions and exclusions before enqueueing', async () => {
    mockPushQueueService.enqueuePush.mockClear();
    mockPushService.pushByVersion.mockClear();

    const res = await request(app.getHttpServer())
      .post(PUSH_URL)
      .send({ parsedVersion: 'v1', summaryVersion: 'sum_v1', excludeSummaries: true })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
    expect(mockPushQueueService.enqueuePush).not.toHaveBeenCalled();
    expect(mockPushService.pushByVersion).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Unit tests: direct constructor invocation (no Nest app overhead)
// =============================================================================

describe('PushController — async-by-default unit tests', () => {
  // Mock the Express response so the controller's res.status(202) call has a target.
  // The .status() chain returns `this` to mirror Express semantics; tests assert on
  // status.mock.calls to verify the queued branch flipped to 202.
  function makeRes() {
    const status = vi.fn();
    const res = { status } as unknown as import('express').Response;
    status.mockReturnValue(res);
    return { res, status };
  }

  it('default POST /push (incremental) enqueues, returns { jobId, status: "queued" }, and sets 202', async () => {
    const pushService = { pushByVersion: vi.fn() } as unknown as PushService;
    const pushQueue = { enqueuePush: vi.fn(async () => ({ id: 'job_x' })) } as unknown as PushQueueService;
    const controller = new PushController(pushService, pushQueue);
    const { res, status } = makeRes();
    const result = await controller.push(
      'ws_1',
      'gateway',
      { parsedVersion: 'v1', commitSha: 'sha_a' } as unknown as VersionPushInput,
      { id: 'user_1' } as AuthUser,
      res,
      undefined,
      undefined,
    );
    expect(result).toEqual({ jobId: 'job_x', status: 'queued' });
    expect(status).toHaveBeenCalledWith(202);
    expect(pushQueue.enqueuePush).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws_1',
        repoName: 'gateway',
        userId: 'user_1',
        payload: expect.objectContaining({ parsedVersion: 'v1', commitSha: 'sha_a' }),
      }),
    );
    // Default async: defer not requested → not stored in payload (processor defaults to false).
    const enqueuedPayload = (pushQueue.enqueuePush as ReturnType<typeof vi.fn>).mock.calls[0][0].payload as Record<
      string,
      unknown
    >;
    expect(enqueuedPayload.deferResolution).toBeUndefined();
    expect(pushService.pushByVersion).not.toHaveBeenCalled();
  });

  it('async with ?defer=true persists deferResolution=true in the queued payload', async () => {
    const pushService = { pushByVersion: vi.fn() } as unknown as PushService;
    const pushQueue = { enqueuePush: vi.fn(async () => ({ id: 'job_d' })) } as unknown as PushQueueService;
    const controller = new PushController(pushService, pushQueue);
    const { res } = makeRes();
    await controller.push(
      'ws_1',
      'gateway',
      { parsedVersion: 'v1' } as unknown as VersionPushInput,
      { id: 'user_1' } as AuthUser,
      res,
      undefined,
      'true',
    );
    expect(pushQueue.enqueuePush).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ parsedVersion: 'v1', deferResolution: true }),
      }),
    );
  });

  it('async with ?rebuild=true persists the explicit replacement intent in the queued payload', async () => {
    const pushService = { pushByVersion: vi.fn() } as unknown as PushService;
    const pushQueue = { enqueuePush: vi.fn(async () => ({ id: 'job_r' })) } as unknown as PushQueueService;
    const controller = new PushController(pushService, pushQueue);
    const { res } = makeRes();
    await controller.push(
      'ws_1',
      'gateway',
      { parsedVersion: 'v1' } as unknown as VersionPushInput,
      { id: 'user_1' } as AuthUser,
      res,
      undefined,
      undefined,
      'true',
    );
    expect(pushQueue.enqueuePush).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ parsedVersion: 'v1', rebuild: true }),
      }),
    );
  });

  it('async push persists explicit metadata exclusions in the queued payload', async () => {
    const pushService = { pushByVersion: vi.fn() } as unknown as PushService;
    const pushQueue = { enqueuePush: vi.fn(async () => ({ id: 'job_m' })) } as unknown as PushQueueService;
    const controller = new PushController(pushService, pushQueue);
    const { res } = makeRes();
    await controller.push(
      'ws_1',
      'gateway',
      { parsedVersion: 'v1', excludeSummaries: true, excludeEmbeddings: true } as VersionPushInput,
      { id: 'user_1' } as AuthUser,
      res,
    );
    expect(pushQueue.enqueuePush).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          parsedVersion: 'v1',
          excludeSummaries: true,
          excludeEmbeddings: true,
        }),
      }),
    );
  });

  it('?sync=true (incremental) runs inline via pushByVersion and does NOT set 202', async () => {
    const pushService = {
      getWorkspaceGraphBackend: vi.fn(async () => 'turso'),
      pushByVersion: vi.fn(async () => ({ repoName: 'gateway', mode: 'incremental' })),
    } as unknown as PushService;
    const pushQueue = { enqueuePush: vi.fn() } as unknown as PushQueueService;
    const controller = new PushController(pushService, pushQueue);
    const { res, status } = makeRes();
    await controller.push(
      'ws_1',
      'gateway',
      { parsedVersion: 'v1', excludeSummaries: true, excludeEmbeddings: true } as VersionPushInput,
      { id: 'user_1' } as AuthUser,
      res,
      'true',
      undefined,
    );
    expect(pushService.pushByVersion).toHaveBeenCalledWith(
      'ws_1',
      'gateway',
      'v1',
      null,
      'user_1',
      undefined,
      undefined,
      false,
      false,
      { excludeSummaries: true, excludeEmbeddings: true },
    );
    expect(pushQueue.enqueuePush).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it('file_snapshot ?sync=true enqueues and returns the durable terminal result without an inline push', async () => {
    const terminalResult = {
      versionId: 'a'.repeat(64),
      repoName: 'gateway',
      artifact: { r2Key: 'ws_1/graphs/private.ladybug', sha256: 'b'.repeat(64), sizeBytes: 42 },
    };
    const pushService = {
      getWorkspaceGraphBackend: vi.fn(async () => 'file_snapshot'),
      pushByVersion: vi.fn(),
    } as unknown as PushService;
    const pushQueue = {
      enqueuePush: vi.fn(async () => ({ id: 'job_fs' })),
      waitForTerminal: vi.fn(async () => ({ id: 'job_fs', status: 'succeeded', result: terminalResult })),
    } as unknown as PushQueueService;
    const controller = new PushController(pushService, pushQueue);
    const { res, status } = makeRes();

    const result = await controller.push(
      'ws_1',
      'gateway',
      { parsedVersion: 'v1' } as VersionPushInput,
      { id: 'user_1' } as AuthUser,
      res,
      'true',
    );

    expect(result).toEqual({
      versionId: 'a'.repeat(64),
      repoName: 'gateway',
      artifact: { sha256: 'b'.repeat(64), sizeBytes: 42 },
    });
    expect(pushQueue.enqueuePush).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws_1', repoName: 'gateway', userId: 'user_1' }),
    );
    expect(pushQueue.waitForTerminal).toHaveBeenCalledWith('ws_1', 'job_fs');
    expect(pushService.pushByVersion).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });
});
