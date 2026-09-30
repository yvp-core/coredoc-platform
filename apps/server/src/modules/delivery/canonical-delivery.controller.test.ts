import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { PERMISSION_KEY } from '../../auth/decorators/require-permission.decorator.js';
import { WORKSPACE_ROLE_KEY } from '../../auth/decorators/workspace-role.decorator.js';
import { JwtOnlyGuard } from '../../auth/jwt-only.guard.js';
import { PermissionsGuard } from '../../auth/permissions.guard.js';
import { TokenPermission } from '../../auth/token-permissions.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { parseCustomWindow } from '../../libs/analytics-window.js';
import { parseLifecycleFilter } from './canonical-delivery-read.contract.js';
import { CanonicalDeliveryController } from './canonical-delivery.controller.js';
import { CanonicalDeliveryService } from './canonical-delivery.service.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = 'cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ARTIFACT_ID = 'cda_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXTERNAL_REF_ID = '9007199254740993';
const CONNECTOR_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SHIP_EVENT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SHIPPED_AT = '2026-08-17T12:34:56.789Z';

describe('CanonicalDeliveryController', () => {
  let app: INestApplication;
  let serviceTokenPrincipal = false;
  // The real WorkspaceRoleGuard leaves this on the request; `@WorkspaceRoleValue` reads it.
  let callerRole: string | undefined = 'admin';
  const ensureTask = vi.fn();
  const uploadArtifactRevision = vi.fn();
  const getArtifact = vi.fn();
  const listTasks = vi.fn();
  const attachExternalRef = vi.fn();
  const detachExternalRef = vi.fn();
  const recordCoredocShipEvidence = vi.fn();
  const listTaskSummaries = vi.fn();
  const getDeliverySummary = vi.fn();
  const getTaskDetail = vi.fn();
  const listTaskExternalRefs = vi.fn();
  const listExternalRefStateHistory = vi.fn();
  const listTaskRuns = vi.fn();
  const listRunStageOccurrences = vi.fn();
  const listTaskCodeChanges = vi.fn();
  const listTaskShipEvidence = vi.fn();
  const listTaskReworkSignals = vi.fn();
  const listTaskArtifacts = vi.fn();

  beforeEach(async () => {
    serviceTokenPrincipal = false;
    callerRole = 'admin';
    ensureTask.mockResolvedValue({
      id: TASK_ID,
      repositoryKey: null,
      lifecycle: 'active',
      authority: 'coredoc',
      externalRefs: [],
    });
    listTasks.mockResolvedValue({ tasks: [] });
    attachExternalRef.mockResolvedValue({
      status: 'attached',
      taskId: TASK_ID,
      externalRef: {
        id: EXTERNAL_REF_ID,
        provider: 'jira',
        externalId: '10042',
      },
      authority: {
        kind: 'external_ref',
        externalRefId: EXTERNAL_REF_ID,
        provider: 'jira',
        externalId: '10042',
        connected: true,
      },
    });
    detachExternalRef.mockResolvedValue({
      status: 'detached',
      taskId: TASK_ID,
      authority: { kind: 'coredoc' },
    });
    recordCoredocShipEvidence.mockResolvedValue({
      status: 'accepted',
      taskId: TASK_ID,
      eventId: SHIP_EVENT_ID,
      shippedAt: SHIPPED_AT,
    });
    listTaskSummaries.mockResolvedValue({ tasks: [], nextCursor: null });
    getDeliverySummary.mockResolvedValue({
      window: {
        days: 30,
        since: '2026-08-02T00:00:00.000Z',
        until: '2026-09-01T00:00:00.000Z',
        lifecycle: 'all',
        userId: null,
      },
      tasks: { matching: 0, shipped: 0, partiallyShipped: 0, withRework: 0, active: 0 },
      leadTimeMs: { value: null, sampleSize: 0 },
      reviewStageMs: { value: null, sampleSize: 0 },
      costPerShippedTaskUsd: { value: null, sampleSize: 0, unpricedTasks: 0 },
      stages: [],
      unclaimedMs: { value: null, sampleSize: 0 },
      reviewWaitMs: { value: null, sampleSize: 0 },
      editVerifyRoundsPerRun: { value: null, sampleSize: 0 },
      rework: {
        bySource: [
          { kind: 'tracker_reopened', signals: 0, tasks: 0 },
          { kind: 'review_changes_requested', signals: 0, tasks: 0 },
          { kind: 'review_commented', signals: 0, tasks: 0 },
        ],
      },
    });
    getTaskDetail.mockResolvedValue({
      id: TASK_ID,
      repositoryKey: null,
      lifecycle: 'active',
      authority: { kind: 'coredoc' },
      createdBy: 'actor-1',
      createdAt: SHIPPED_AT,
      updatedAt: SHIPPED_AT,
      everShipped: false,
      lastShippedAt: null,
      counts: {
        externalRefs: 0,
        workflowRuns: 0,
        codeChanges: 0,
        shipEvidence: 0,
        reworkSignals: 0,
        artifacts: 0,
      },
      fineEventRetention: { policyDays: 90, purgedThroughReceivedAt: null },
    });
    for (const nestedRead of [
      listTaskExternalRefs,
      listExternalRefStateHistory,
      listTaskRuns,
      listRunStageOccurrences,
      listTaskCodeChanges,
      listTaskShipEvidence,
      listTaskReworkSignals,
      listTaskArtifacts,
    ]) {
      nestedRead.mockResolvedValue({ items: [], nextCursor: null });
    }
    uploadArtifactRevision.mockResolvedValue({
      status: 'accepted',
      artifact: {
        id: ARTIFACT_ID,
        taskId: TASK_ID,
        repositoryKey: 'coredoc/coredoc-parser',
        kind: 'spec',
      },
      revision: {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        sha256: 'a'.repeat(64),
        byteCount: 6,
        checkpoint: 'run-finish',
        runId: null,
        createdAt: '2026-08-16T20:00:00.000Z',
      },
    });
    getArtifact.mockResolvedValue({
      artifact: {
        id: ARTIFACT_ID,
        taskId: TASK_ID,
        repositoryKey: 'coredoc/coredoc-parser',
        kind: 'spec',
      },
      revisions: [
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          sha256: 'a'.repeat(64),
          byteCount: 6,
          checkpoint: 'run-finish',
          runId: null,
          createdAt: '2026-08-16T20:00:00.000Z',
          markdown: '# Spec',
        },
      ],
    });
    const moduleRef = await Test.createTestingModule({
      controllers: [CanonicalDeliveryController],
      providers: [
        {
          provide: CanonicalDeliveryService,
          useValue: {
            ensureTask,
            uploadArtifactRevision,
            getArtifact,
            listTasks,
            attachExternalRef,
            detachExternalRef,
            recordCoredocShipEvidence,
            listTaskSummaries,
            getDeliverySummary,
            getTaskDetail,
            listTaskExternalRefs,
            listExternalRefStateHistory,
            listTaskRuns,
            listRunStageOccurrences,
            listTaskCodeChanges,
            listTaskShipEvidence,
            listTaskReworkSignals,
            listTaskArtifacts,
          },
        },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const httpRequest = context.switchToHttp().getRequest();
          httpRequest.user = { id: 'actor-1', email: 'pilot@example.com' };
          httpRequest.userWorkspaceRole = callerRole;
          if (serviceTokenPrincipal) httpRequest.serviceTokenWorkspaceId = WORKSPACE_ID;
          return true;
        },
      })
      .overrideGuard(WorkspaceRoleGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    // Bind IPv4 loopback: supertest's ephemeral '::' bind can collide with a 127.0.0.1-only local listener on macOS.
    await app.listen(0, '127.0.0.1');
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await app.close();
  });

  it('ensures a task through the existing telemetry-token trust boundary', async () => {
    serviceTokenPrincipal = true;
    const body = { externalRefs: [] };

    await request(app.getHttpServer())
      .put(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/tasks/${TASK_ID}`)
      .send(body)
      .expect(200)
      .expect({
        id: TASK_ID,
        repositoryKey: null,
        lifecycle: 'active',
        authority: 'coredoc',
        externalRefs: [],
      });

    expect(ensureTask).toHaveBeenCalledWith(WORKSPACE_ID, 'actor-1', TASK_ID, body);
  });

  it('accepts an artifact revision through the telemetry-token trust boundary without echoing Markdown', async () => {
    serviceTokenPrincipal = true;
    const body = {
      taskId: TASK_ID,
      repositoryKey: 'coredoc/coredoc-parser',
      kind: 'spec',
      checkpoint: 'run-finish',
      markdown: '# Spec',
    };

    const response = await request(app.getHttpServer())
      .put(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/artifacts/${ARTIFACT_ID}/revisions`)
      .send(body)
      .expect(200);

    expect(response.body).toEqual({
      status: 'accepted',
      artifact: {
        id: ARTIFACT_ID,
        taskId: TASK_ID,
        repositoryKey: 'coredoc/coredoc-parser',
        kind: 'spec',
      },
      revision: {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        sha256: 'a'.repeat(64),
        byteCount: 6,
        checkpoint: 'run-finish',
        runId: null,
        createdAt: '2026-08-16T20:00:00.000Z',
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('# Spec');
    // The body the service receives is the parsed one: `runId` defaulted by the schema.
    expect(uploadArtifactRevision).toHaveBeenCalledWith(WORKSPACE_ID, 'actor-1', ARTIFACT_ID, { ...body, runId: null });
  });

  it('allows a JWT administrator to read the canonical timeline', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/tasks`)
      .expect(200)
      .expect({ tasks: [] });
    expect(listTasks).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it('wires every additive bounded read without changing the old task-list route', async () => {
    const page = '?limit=1&cursor=opaque';
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/task-summaries${page}`)
      .expect(200)
      .expect({ tasks: [], nextCursor: null });
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/tasks/${TASK_ID}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/tasks/${TASK_ID}/external-refs${page}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(
        `/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/tasks/${TASK_ID}/external-refs/${EXTERNAL_REF_ID}/state-history${page}`,
      )
      .expect(200);
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/tasks/${TASK_ID}/runs${page}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(
        `/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/tasks/${TASK_ID}/runs/cdr-20260817-a1b2c3/stage-occurrences${page}`,
      )
      .expect(200);
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/tasks/${TASK_ID}/code-changes${page}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/tasks/${TASK_ID}/ship-evidence${page}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/tasks/${TASK_ID}/rework-signals${page}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/tasks/${TASK_ID}/artifacts${page}`)
      .expect(200);

    expect(listTaskSummaries).toHaveBeenCalledWith(
      WORKSPACE_ID,
      '1',
      'opaque',
      undefined,
      undefined,
      undefined,
      undefined,
      null,
    );
    expect(getTaskDetail).toHaveBeenCalledWith(WORKSPACE_ID, TASK_ID);
    expect(listTaskExternalRefs).toHaveBeenCalledWith(WORKSPACE_ID, TASK_ID, '1', 'opaque');
    expect(listExternalRefStateHistory).toHaveBeenCalledWith(WORKSPACE_ID, TASK_ID, EXTERNAL_REF_ID, '1', 'opaque');
    expect(listTaskRuns).toHaveBeenCalledWith(WORKSPACE_ID, TASK_ID, '1', 'opaque');
    expect(listRunStageOccurrences).toHaveBeenCalledWith(WORKSPACE_ID, TASK_ID, 'cdr-20260817-a1b2c3', '1', 'opaque');
    expect(listTaskCodeChanges).toHaveBeenCalledWith(WORKSPACE_ID, TASK_ID, '1', 'opaque');
    expect(listTaskShipEvidence).toHaveBeenCalledWith(WORKSPACE_ID, TASK_ID, '1', 'opaque');
    expect(listTaskReworkSignals).toHaveBeenCalledWith(WORKSPACE_ID, TASK_ID, '1', 'opaque');
    expect(listTaskArtifacts).toHaveBeenCalledWith(WORKSPACE_ID, TASK_ID, '1', 'opaque');
    expect(listTasks).not.toHaveBeenCalled();
  });

  it('allows a JWT administrator to explicitly drill into artifact Markdown', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/artifacts/${ARTIFACT_ID}/revisions`)
      .expect(200)
      .expect({
        artifact: {
          id: ARTIFACT_ID,
          taskId: TASK_ID,
          repositoryKey: 'coredoc/coredoc-parser',
          kind: 'spec',
        },
        revisions: [
          {
            id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            sha256: 'a'.repeat(64),
            byteCount: 6,
            checkpoint: 'run-finish',
            runId: null,
            createdAt: '2026-08-16T20:00:00.000Z',
            markdown: '# Spec',
          },
        ],
      });
    expect(getArtifact).toHaveBeenCalledWith(WORKSPACE_ID, ARTIFACT_ID);
  });

  it('lets a JWT administrator attach one exact external identity without coercing its BigInt id', async () => {
    const body = {
      provider: 'jira',
      externalId: '10042',
      connectorId: CONNECTOR_ID,
      makeAuthority: true,
    };

    const response = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/tasks/${TASK_ID}/external-refs`)
      .send(body);

    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
    expect(response.body).toEqual({
      status: 'attached',
      taskId: TASK_ID,
      externalRef: {
        id: EXTERNAL_REF_ID,
        provider: 'jira',
        externalId: '10042',
      },
      authority: {
        kind: 'external_ref',
        externalRefId: EXTERNAL_REF_ID,
        provider: 'jira',
        externalId: '10042',
        connected: true,
      },
    });
    expect(attachExternalRef).toHaveBeenCalledWith(WORKSPACE_ID, TASK_ID, body);
  });

  it('lets a JWT administrator detach one exact external identity with an explicit fallback', async () => {
    const body = { fallbackAuthority: { kind: 'coredoc' } };

    const response = await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/tasks/${TASK_ID}/external-refs/${EXTERNAL_REF_ID}/detach`)
      .send(body);

    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
    expect(response.body).toEqual({
      status: 'detached',
      taskId: TASK_ID,
      authority: { kind: 'coredoc' },
    });
    expect(detachExternalRef).toHaveBeenCalledWith(WORKSPACE_ID, TASK_ID, EXTERNAL_REF_ID, body);
  });

  it('records explicit Coredoc ship evidence with only the authenticated JWT actor', async () => {
    const body = { eventId: SHIP_EVENT_ID, shippedAt: SHIPPED_AT };

    await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/tasks/${TASK_ID}/ship-evidence/coredoc`)
      .send(body)
      .expect(200)
      .expect({
        status: 'accepted',
        taskId: TASK_ID,
        eventId: SHIP_EVENT_ID,
        shippedAt: SHIPPED_AT,
      });

    expect(recordCoredocShipEvidence).toHaveBeenCalledWith(WORKSPACE_ID, 'actor-1', TASK_ID, body);
  });

  it('refuses canonical delivery reads and explicit ship writes to a telemetry service token', async () => {
    serviceTokenPrincipal = true;
    await request(app.getHttpServer()).get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/tasks`).expect(403);
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/artifacts/${ARTIFACT_ID}/revisions`)
      .expect(403);
    await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/tasks/${TASK_ID}/ship-evidence/coredoc`)
      .send({ eventId: SHIP_EVENT_ID, shippedAt: SHIPPED_AT })
      .expect(403);
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/summary?days=30&lifecycle=shipped`)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/task-summaries?days=30&lifecycle=shipped`)
      .expect(403);
    expect(listTasks).not.toHaveBeenCalled();
    expect(getArtifact).not.toHaveBeenCalled();
    expect(recordCoredocShipEvidence).not.toHaveBeenCalled();
    expect(getDeliverySummary).not.toHaveBeenCalled();
    expect(listTaskSummaries).not.toHaveBeenCalled();
  });

  it('serves the delivery summary and the filtered task list on the same admin JWT read surface', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/summary?days=1000&lifecycle=shipped`)
      .expect(200);

    expect(response.body.window).toEqual({
      days: 30,
      since: '2026-08-02T00:00:00.000Z',
      until: '2026-09-01T00:00:00.000Z',
      lifecycle: 'all',
      userId: null,
    });
    // The route forwards the raw query; the service owns clamping and rejection.
    expect(getDeliverySummary).toHaveBeenCalledWith(WORKSPACE_ID, '1000', 'shipped', undefined, undefined, null);

    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/task-summaries?limit=1&days=7&lifecycle=rework`)
      .expect(200);
    expect(listTaskSummaries).toHaveBeenCalledWith(
      WORKSPACE_ID,
      '1',
      undefined,
      '7',
      'rework',
      undefined,
      undefined,
      null,
    );

    // `summary` is a fixed segment: it must not be routed as a task id.
    await request(app.getHttpServer()).get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/summary`).expect(200);
    expect(getTaskDetail).not.toHaveBeenCalled();
  });

  it('forwards a custom range and resolves `mine` from the JWT', async () => {
    const range = 'since=2026-08-01&until=2026-08-31&mine=true';
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/summary?${range}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/task-summaries?${range}`)
      .expect(200);

    expect(getDeliverySummary).toHaveBeenCalledWith(
      WORKSPACE_ID,
      undefined,
      undefined,
      '2026-08-01',
      '2026-08-31',
      'actor-1',
    );
    expect(listTaskSummaries).toHaveBeenCalledWith(
      WORKSPACE_ID,
      undefined,
      undefined,
      undefined,
      undefined,
      '2026-08-01',
      '2026-08-31',
      'actor-1',
    );

    // `mine=false` is an explicit workspace-wide read.
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/summary?mine=false`)
      .expect(200);
    expect(getDeliverySummary).toHaveBeenLastCalledWith(WORKSPACE_ID, undefined, undefined, undefined, undefined, null);
  });

  it('answers 400 for a non-boolean `mine` and a non-string `userId`', async () => {
    for (const query of ['mine=1', 'mine=yes', 'mine=true&mine=true']) {
      await request(app.getHttpServer())
        .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/summary?${query}`)
        .expect(400);
    }
    // A repeated key arrives as an array, which is not a single member id; coercing it would
    // silently filter by "a,b" and return a page nobody asked for. (The bracketed-object form
    // is rejected by the same guard but depends on the app's query parser, so it is not
    // asserted through this harness.)
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/task-summaries?userId=a&userId=b`)
      .expect(400);
    expect(getDeliverySummary).not.toHaveBeenCalled();
    expect(listTaskSummaries).not.toHaveBeenCalled();
  });

  it('lets an admin filter by any member, and a member only by themselves', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/summary?userId=someone-else`)
      .expect(200);
    expect(getDeliverySummary).toHaveBeenLastCalledWith(
      WORKSPACE_ID,
      undefined,
      undefined,
      undefined,
      undefined,
      'someone-else',
    );

    callerRole = 'member';
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/summary?userId=someone-else`)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/task-summaries?userId=someone-else`)
      .expect(403);
    // Their own id is fine, by either spelling.
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/task-summaries?userId=actor-1`)
      .expect(200);
    expect(listTaskSummaries).toHaveBeenLastCalledWith(
      WORKSPACE_ID,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'actor-1',
    );
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/summary?mine=true`)
      .expect(200);
    expect(getDeliverySummary).toHaveBeenLastCalledWith(
      WORKSPACE_ID,
      undefined,
      undefined,
      undefined,
      undefined,
      'actor-1',
    );
  });

  it('answers 400 when `mine` and `userId` are combined on either read', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/summary?mine=true&userId=actor-1`)
      .expect(400);
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/task-summaries?mine=false&userId=actor-1`)
      .expect(400);
    expect(getDeliverySummary).not.toHaveBeenCalled();
    expect(listTaskSummaries).not.toHaveBeenCalled();
  });

  it('answers 400 for a malformed custom range on both filtered reads', async () => {
    // The real window parser runs against the raw query string, so a route that stopped
    // forwarding `since`/`until` would answer 200 here.
    getDeliverySummary.mockImplementation(
      (_workspaceId: string, _days?: string, _lifecycle?: string, since?: string, until?: string) => {
        parseCustomWindow(since, until);
        return { window: { days: 30, since: '', until: '', lifecycle: 'all', userId: null } };
      },
    );
    listTaskSummaries.mockImplementation(
      (
        _workspaceId: string,
        _limit?: string,
        _cursor?: string,
        _days?: string,
        _lifecycle?: string,
        since?: string,
        until?: string,
      ) => {
        parseCustomWindow(since, until);
        return { tasks: [], nextCursor: null };
      },
    );

    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/summary?since=2026-08-01`)
      .expect(400);
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/task-summaries?since=2026-08-31&until=2026-08-01`)
      .expect(400);
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/task-summaries?since=2026-01-01&until=2026-08-01`)
      .expect(400);
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/summary?since=2026-08-01&until=2026-08-31`)
      .expect(200);
  });

  it('answers 400 for an unknown lifecycle filter on both filtered reads', async () => {
    // The real filter validator runs against the raw query string, so a route that stopped
    // forwarding `lifecycle` would answer 200 here.
    getDeliverySummary.mockImplementation((_workspaceId: string, _days?: string, lifecycle?: string) => {
      parseLifecycleFilter(lifecycle);
      return {
        window: {
          days: 30,
          since: '2026-08-02T00:00:00.000Z',
          until: '2026-09-01T00:00:00.000Z',
          lifecycle: 'all',
          userId: null,
        },
      };
    });
    listTaskSummaries.mockImplementation(
      (_workspaceId: string, _limit?: string, _cursor?: string, _days?: string, lifecycle?: string) => {
        parseLifecycleFilter(lifecycle);
        return { tasks: [], nextCursor: null };
      },
    );

    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/summary?lifecycle=bogus`)
      .expect(400);
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/task-summaries?lifecycle=bogus`)
      .expect(400);
    await request(app.getHttpServer())
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2/summary?lifecycle=shipped`)
      .expect(200);
  });

  it('keeps telemetry writes on member TelemetryWrite, opens reads to every JWT member, and locks repair writes to administrators', () => {
    const reflector = new Reflector();
    const proto = CanonicalDeliveryController.prototype;
    expect(reflector.get(WORKSPACE_ROLE_KEY, proto.ensureTask)).toBe('member');
    expect(reflector.get<TokenPermission[]>(PERMISSION_KEY, proto.ensureTask)).toEqual([
      TokenPermission.TelemetryWrite,
    ]);
    expect(reflector.get(WORKSPACE_ROLE_KEY, proto.uploadArtifactRevision)).toBe('member');
    expect(reflector.get<TokenPermission[]>(PERMISSION_KEY, proto.uploadArtifactRevision)).toEqual([
      TokenPermission.TelemetryWrite,
    ]);
    expect(reflector.get(WORKSPACE_ROLE_KEY, proto.listTasks)).toBe('member');
    expect(reflector.get<TokenPermission[]>(PERMISSION_KEY, proto.listTasks)).toEqual([TokenPermission.ResultRead]);
    expect(Reflect.getMetadata(GUARDS_METADATA, proto.listTasks)).toContain(JwtOnlyGuard);
    expect(reflector.get(WORKSPACE_ROLE_KEY, proto.getArtifact)).toBe('member');
    expect(reflector.get<TokenPermission[]>(PERMISSION_KEY, proto.getArtifact)).toEqual([TokenPermission.ResultRead]);
    expect(Reflect.getMetadata(GUARDS_METADATA, proto.getArtifact)).toContain(JwtOnlyGuard);
    expect(reflector.get(WORKSPACE_ROLE_KEY, proto.attachExternalRef)).toBe('admin');
    expect(reflector.get<TokenPermission[]>(PERMISSION_KEY, proto.attachExternalRef)).toEqual([
      TokenPermission.WorkspaceManage,
    ]);
    expect(Reflect.getMetadata(GUARDS_METADATA, proto.attachExternalRef)).toContain(JwtOnlyGuard);
    expect(reflector.get(WORKSPACE_ROLE_KEY, proto.detachExternalRef)).toBe('admin');
    expect(reflector.get<TokenPermission[]>(PERMISSION_KEY, proto.detachExternalRef)).toEqual([
      TokenPermission.WorkspaceManage,
    ]);
    expect(Reflect.getMetadata(GUARDS_METADATA, proto.detachExternalRef)).toContain(JwtOnlyGuard);
    expect(reflector.get(WORKSPACE_ROLE_KEY, proto.recordCoredocShipEvidence)).toBe('admin');
    expect(reflector.get<TokenPermission[]>(PERMISSION_KEY, proto.recordCoredocShipEvidence)).toEqual([
      TokenPermission.WorkspaceManage,
    ]);
    expect(Reflect.getMetadata(GUARDS_METADATA, proto.recordCoredocShipEvidence)).toContain(JwtOnlyGuard);
    for (const read of [
      proto.listTaskSummaries,
      proto.getDeliverySummary,
      proto.getTaskDetail,
      proto.listTaskExternalRefs,
      proto.listExternalRefStateHistory,
      proto.listTaskRuns,
      proto.listRunStageOccurrences,
      proto.listTaskCodeChanges,
      proto.listTaskShipEvidence,
      proto.listTaskReworkSignals,
      proto.listTaskArtifacts,
    ]) {
      expect(reflector.get(WORKSPACE_ROLE_KEY, read)).toBe('member');
      expect(reflector.get<TokenPermission[]>(PERMISSION_KEY, read)).toEqual([TokenPermission.ResultRead]);
      expect(Reflect.getMetadata(GUARDS_METADATA, read)).toContain(JwtOnlyGuard);
    }
  });
});
