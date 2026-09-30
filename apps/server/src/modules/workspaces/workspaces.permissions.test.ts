/**
 * Every MUTATING workspace route is control-plane administration, and a role check alone
 * does not fence one: `WorkspaceRoleGuard` reads the role of the USER WHO CREATED the
 * service token, never the token's own grants. So a token minted by an owner to hold
 * nothing but `intent:release` passed `@WorkspaceRole('owner')` and could DELETE the
 * workspace — and `PATCH` could flip `intentReleaseTrigger` (amendment §5) before
 * asserting production state with its own grant.
 *
 * The routes are exercised through the REAL guard chain, because the hole was guard
 * metadata (a role check without a permission check), not controller logic.
 */
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { TokenPermission } from '../../auth/token-permissions.js';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import { PushQueueService } from '../job-queue/push-queue.service.js';
import { ResolverService } from '../mapper/resolver.service.js';
import { WorkspacesController } from './workspaces.controller.js';
import { WorkspacesService } from './workspaces.service.js';

const WS = 'ws_1';

describe('mutating /workspaces routes: permission fence', () => {
  let app: INestApplication;
  const service = {
    updateWorkspace: vi.fn(async () => ({ id: WS, intentReleaseTrigger: 'deploy' })),
    deleteWorkspace: vi.fn(async () => ({ deleted: true })),
    enableCloud: vi.fn(async () => ({ id: WS, cloudEnabled: true })),
    createWorkspace: vi.fn(async () => ({ id: 'ws_2' })),
  };
  /** Set per case: `undefined` = an owner user session, otherwise a service token's grants. */
  let tokenPermissions: string[] | undefined;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [WorkspacesController],
      providers: [
        { provide: WorkspacesService, useValue: service },
        { provide: ResolverService, useValue: {} },
        { provide: PushQueueService, useValue: {} },
        // The token's CREATOR is a workspace owner — exactly the finding's setup.
        { provide: ControlPlaneService, useValue: { getMember: async () => ({ role: 'owner' }) } },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const req = context.switchToHttp().getRequest();
          req.user = { id: 'owner-1' };
          if (tokenPermissions) {
            req.serviceTokenWorkspaceId = WS;
            req.serviceTokenPermissions = tokenPermissions;
          }
          return true;
        },
      })
      .compile();
    app = mod.createNestApplication();
    await app.init();
    // Bind IPv4 loopback: supertest's ephemeral '::' bind can collide with a 127.0.0.1-only local listener on macOS.
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
  });

  /** One row per mutating route of the controller: how to call it, and what it must reach. */
  const routes = [
    {
      name: 'PATCH /workspaces/:id',
      call: () => request(app.getHttpServer()).patch(`/workspaces/${WS}`).send({ intentReleaseTrigger: 'deploy' }),
      handler: service.updateWorkspace,
    },
    {
      name: 'DELETE /workspaces/:id',
      call: () => request(app.getHttpServer()).delete(`/workspaces/${WS}`),
      handler: service.deleteWorkspace,
    },
    {
      name: 'POST /workspaces/:id/cloud/enable',
      call: () => request(app.getHttpServer()).post(`/workspaces/${WS}/cloud/enable`).send({}),
      handler: service.enableCloud,
    },
  ];

  describe.each(routes)('$name', ({ call, handler }) => {
    it.each([
      ['intent:release', [TokenPermission.IntentRelease]],
      ['intent:read', [TokenPermission.IntentRead]],
      ['repo:push', [TokenPermission.RepoPush]],
    ])('refuses a service token holding only %s', async (_name, permissions) => {
      tokenPermissions = permissions;
      handler.mockClear();
      await call().expect(403);
      expect(handler).not.toHaveBeenCalled();
    });

    it('allows a service token that holds workspace:manage', async () => {
      tokenPermissions = [TokenPermission.WorkspaceManage];
      handler.mockClear();
      await call().expect(({ status }) => expect([200, 201, 204]).toContain(status));
      expect(handler).toHaveBeenCalled();
    });

    it('allows an owner user session', async () => {
      tokenPermissions = undefined;
      handler.mockClear();
      await call().expect(({ status }) => expect([200, 201, 204]).toContain(status));
      expect(handler).toHaveBeenCalled();
    });
  });

  // The one mutating route that needs no permission of its own: `POST /workspaces` is
  // account-level, so WorkspaceRoleGuard already refuses EVERY service token there.
  it('keeps POST /workspaces unreachable for a service token, whatever it holds', async () => {
    tokenPermissions = [TokenPermission.WorkspaceManage];
    service.createWorkspace.mockClear();
    await request(app.getHttpServer()).post('/workspaces').send({ name: 'New', slug: 'new' }).expect(403);
    expect(service.createWorkspace).not.toHaveBeenCalled();
  });

  it('passes the PATCH body through once the fence admits the caller', async () => {
    tokenPermissions = undefined;
    service.updateWorkspace.mockClear();
    await request(app.getHttpServer()).patch(`/workspaces/${WS}`).send({ intentReleaseTrigger: 'deploy' }).expect(200);
    expect(service.updateWorkspace).toHaveBeenCalledWith(WS, { intentReleaseTrigger: 'deploy' });
  });
});
