import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { ExactTelemetryTokenGuard } from '../../auth/exact-telemetry-token.guard.js';
import { PermissionsGuard } from '../../auth/permissions.guard.js';
import { TokenPermission } from '../../auth/token-permissions.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import { CaptureController } from './capture.controller.js';
import { CaptureService } from './capture.service.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const FOREIGN_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';

type TestPrincipal = { kind: 'jwt' } | { kind: 'service'; workspaceId: string; permissions: string[] };

const deniedMachinePrincipals: Array<[string, TestPrincipal, boolean]> = [
  ['JWT', { kind: 'jwt' }, true],
  ['wildcard service token', { kind: 'service', workspaceId: WORKSPACE_ID, permissions: ['*'] }, true],
  [
    'permission-superset service token',
    {
      kind: 'service',
      workspaceId: WORKSPACE_ID,
      permissions: [TokenPermission.TelemetryWrite, TokenPermission.ResultRead],
    },
    true,
  ],
  [
    'foreign-workspace exact telemetry token',
    { kind: 'service', workspaceId: FOREIGN_WORKSPACE_ID, permissions: [TokenPermission.TelemetryWrite] },
    true,
  ],
  [
    'removed-member exact telemetry token',
    { kind: 'service', workspaceId: WORKSPACE_ID, permissions: [TokenPermission.TelemetryWrite] },
    false,
  ],
];

describe('CaptureController', () => {
  let app: INestApplication;
  const ingest = vi.fn();
  const bindRepository = vi.fn();
  const resolveRepository = vi.fn();
  const reportProvisioning = vi.fn();
  const getMember = vi.fn();
  let principal: TestPrincipal;
  let memberPresent: boolean;

  beforeEach(async () => {
    principal = { kind: 'jwt' };
    memberPresent = true;
    getMember.mockImplementation(async () =>
      memberPresent ? { userId: 'server-user', email: 'pilot@example.com', role: 'member' } : null,
    );
    ingest.mockResolvedValue({ acceptedEventIds: [], duplicateEventIds: [], rejected: [] });
    bindRepository.mockResolvedValue({ repoKey: 'graph-hash', captureRepositoryKey: 'owner/repo' });
    resolveRepository.mockResolvedValue({ status: 'resolved', repositoryKey: 'owner/repo' });
    reportProvisioning.mockResolvedValue({
      actorId: 'server-user',
      host: 'codex',
      targetKey: 'repo:graph-hash:profile:base',
      repositoryKey: 'owner/repo',
      state: 'configured',
      pendingCount: 0,
      errorCode: null,
      attributionPendingCount: 0,
      attributionRejectedCount: 0,
      attributionLastClaimAt: null,
      configuredAt: '2026-08-16T10:00:00.000Z',
      disabledAt: null,
      reportedAt: '2026-08-16T10:00:00.000Z',
    });
    const moduleRef = await Test.createTestingModule({
      controllers: [CaptureController],
      providers: [
        { provide: CaptureService, useValue: { ingest, bindRepository, resolveRepository, reportProvisioning } },
        { provide: ControlPlaneService, useValue: { getMember } },
        WorkspaceRoleGuard,
        PermissionsGuard,
        ExactTelemetryTokenGuard,
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const httpRequest = context.switchToHttp().getRequest();
          httpRequest.user = { id: 'server-user', email: 'pilot@example.com' };
          if (principal.kind === 'service') {
            httpRequest.serviceTokenWorkspaceId = principal.workspaceId;
            httpRequest.serviceTokenPermissions = principal.permissions;
          }
          return true;
        },
      })
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

  it('uses the workspace path and authenticated server identity only', async () => {
    const body = { events: [] };
    await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${WORKSPACE_ID}/capture/v1/events`)
      .send(body)
      .expect(200);

    expect(ingest).toHaveBeenCalledWith(WORKSPACE_ID, { id: 'server-user', email: 'pilot@example.com' }, body);
  });

  it('binds a normalized origin to an existing graph repo through the member provisioning route', async () => {
    const body = { repositoryKey: 'owner/repo' };

    await request(app.getHttpServer())
      .put(`/api/v1/workspaces/${WORKSPACE_ID}/capture/v1/repositories/graph-hash`)
      .send(body)
      .expect(200)
      .expect({ repoKey: 'graph-hash', captureRepositoryKey: 'owner/repo' });

    expect(bindRepository).toHaveBeenCalledWith(WORKSPACE_ID, 'graph-hash', body);
  });

  it('rejects a service-token principal from the repository binding route', async () => {
    principal = {
      kind: 'service',
      workspaceId: WORKSPACE_ID,
      permissions: [TokenPermission.TelemetryWrite],
    };

    await request(app.getHttpServer())
      .put(`/api/v1/workspaces/${WORKSPACE_ID}/capture/v1/repositories/graph-hash`)
      .send({ repositoryKey: 'owner/repo' })
      .expect(403);

    expect(bindRepository).not.toHaveBeenCalled();
  });

  it('allows a telemetry principal to resolve a normalized repository identity without an internal repo key', async () => {
    principal = {
      kind: 'service',
      workspaceId: WORKSPACE_ID,
      permissions: [TokenPermission.TelemetryWrite],
    };
    const body = { repositoryKey: 'owner/repo' };

    await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${WORKSPACE_ID}/capture/v1/repositories/resolve`)
      .send(body)
      .expect(200)
      .expect({ status: 'resolved', repositoryKey: 'owner/repo' });

    expect(resolveRepository).toHaveBeenCalledWith(WORKSPACE_ID, body);
  });

  it.each(deniedMachinePrincipals)('rejects a %s from repository resolution', async (_name, denied, isMember) => {
    principal = denied;
    memberPresent = isMember;

    await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${WORKSPACE_ID}/capture/v1/repositories/resolve`)
      .send({ repositoryKey: 'owner/repo' })
      .expect(403);

    expect(resolveRepository).not.toHaveBeenCalled();
  });

  it('returns an exact side-effect-free readiness response to an exact telemetry principal', async () => {
    principal = {
      kind: 'service',
      workspaceId: WORKSPACE_ID,
      permissions: [TokenPermission.TelemetryWrite],
    };

    await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${WORKSPACE_ID}/capture/v1/probe`)
      .send({})
      .expect(200)
      .expect({ status: 'ready' });

    expect(ingest).not.toHaveBeenCalled();
    expect(bindRepository).not.toHaveBeenCalled();
    expect(resolveRepository).not.toHaveBeenCalled();
    expect(reportProvisioning).not.toHaveBeenCalled();
  });

  it.each(deniedMachinePrincipals)('rejects a %s from the readiness probe', async (_name, denied, isMember) => {
    principal = denied;
    memberPresent = isMember;

    await request(app.getHttpServer()).post(`/api/v1/workspaces/${WORKSPACE_ID}/capture/v1/probe`).send({}).expect(403);
  });

  it('rejects non-empty readiness probe bodies', async () => {
    principal = {
      kind: 'service',
      workspaceId: WORKSPACE_ID,
      permissions: [TokenPermission.TelemetryWrite],
    };

    await request(app.getHttpServer())
      .post(`/api/v1/workspaces/${WORKSPACE_ID}/capture/v1/probe`)
      .send({ repositoryKey: 'owner/repo' })
      .expect(400);
  });

  it('reports a bounded provisioning fact using the JWT actor from the request', async () => {
    const body = {
      schemaVersion: 1,
      host: 'codex',
      target: { kind: 'repository', repoKey: 'graph-hash', repositoryKey: 'owner/repo', profileName: null },
      state: 'configured',
      pendingCount: 0,
      errorCode: null,
      attributionPendingCount: 0,
      attributionRejectedCount: 0,
      attributionLastClaimAt: null,
    };

    await request(app.getHttpServer())
      .put(`/api/v1/workspaces/${WORKSPACE_ID}/capture/v1/provisioning`)
      .send(body)
      .expect(200)
      .expect({
        actorId: 'server-user',
        host: 'codex',
        targetKey: 'repo:graph-hash:profile:base',
        repositoryKey: 'owner/repo',
        state: 'configured',
        pendingCount: 0,
        errorCode: null,
        attributionPendingCount: 0,
        attributionRejectedCount: 0,
        attributionLastClaimAt: null,
        configuredAt: '2026-08-16T10:00:00.000Z',
        disabledAt: null,
        reportedAt: '2026-08-16T10:00:00.000Z',
      });

    expect(reportProvisioning).toHaveBeenCalledWith(WORKSPACE_ID, 'server-user', body);
  });

  it('rejects a service-token principal from the provisioning report route', async () => {
    principal = {
      kind: 'service',
      workspaceId: WORKSPACE_ID,
      permissions: [TokenPermission.TelemetryWrite],
    };

    await request(app.getHttpServer())
      .put(`/api/v1/workspaces/${WORKSPACE_ID}/capture/v1/provisioning`)
      .send({
        schemaVersion: 1,
        host: 'codex',
        target: { kind: 'repository', repoKey: 'graph-hash', repositoryKey: 'owner/repo', profileName: null },
        state: 'configured',
        pendingCount: 0,
        errorCode: null,
        attributionPendingCount: 0,
        attributionRejectedCount: 0,
        attributionLastClaimAt: null,
      })
      .expect(403);

    expect(reportProvisioning).not.toHaveBeenCalled();
  });
});
