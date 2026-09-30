import { BadRequestException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { PermissionsGuard } from '../../auth/permissions.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { ActorRegistryService } from './actor-registry.service.js';
import { DeliveryController } from './delivery.controller.js';
import { DeliveryEnabledGuard } from './delivery-enabled.guard.js';
import { DeliveryService } from './delivery.service.js';
import { JiraCanonicalProjectionService } from './jira-canonical-projection.service.js';
import { StatusMapService } from './status-map.service.js';

const WORKSPACE_ID = 'ws-1';
const CONNECTOR_ID = 'conn-1';

function mocks() {
  return {
    delivery: {
      getDeliverySettings: vi.fn().mockResolvedValue({ enabled: true }),
      setDeliverySettings: vi.fn().mockResolvedValue({ enabled: false }),
      upsertConnector: vi.fn().mockResolvedValue({ id: CONNECTOR_ID }),
      listConnectors: vi.fn().mockResolvedValue({ connectors: [] }),
      triggerConnectorSync: vi.fn().mockResolvedValue({ jobId: 'job-1' }),
      setConnectorStatus: vi.fn().mockResolvedValue({ id: CONNECTOR_ID, status: 'paused' }),
      deleteConnector: vi.fn().mockResolvedValue({ deleted: true }),
      enqueueRenormalizeJob: vi.fn().mockResolvedValue({ id: 'job-2' }),
      assertConnectorInWorkspace: vi.fn().mockResolvedValue(undefined),
    },
    statusMap: {
      listMap: vi.fn().mockResolvedValue({ entries: [] }),
      updateMap: vi.fn().mockResolvedValue({ upserted: 1 }),
    },
    projection: { reprojectConnector: vi.fn().mockResolvedValue({ issues: 1 }) },
    actors: {
      listUnmatched: vi.fn().mockResolvedValue({ actors: [] }),
      mergeActors: vi.fn().mockResolvedValue({ movedIdentities: 1 }),
    },
  };
}

describe('DeliveryController retained API', () => {
  let app: INestApplication;
  let collaborators: ReturnType<typeof mocks>;

  beforeAll(async () => {
    collaborators = mocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [DeliveryController],
      providers: [
        { provide: DeliveryService, useValue: collaborators.delivery },
        { provide: StatusMapService, useValue: collaborators.statusMap },
        { provide: JiraCanonicalProjectionService, useValue: collaborators.projection },
        { provide: ActorRegistryService, useValue: collaborators.actors },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(WorkspaceRoleGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(DeliveryEnabledGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
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

  it('updates status policy before reprojecting canonical Jira facts', async () => {
    const response = await request(app.getHttpServer())
      .put(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/status-map/${CONNECTOR_ID}`)
      .send({ entries: [{ status: 'Done', lifecycle: 'completed', createsShipEvidence: true }] });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ upserted: 1 });
    expect(collaborators.delivery.assertConnectorInWorkspace).toHaveBeenCalledWith(WORKSPACE_ID, CONNECTOR_ID);
    expect(collaborators.statusMap.updateMap).toHaveBeenCalledWith(WORKSPACE_ID, CONNECTOR_ID, [
      { status: 'Done', lifecycle: 'completed', createsShipEvidence: true },
    ]);
    expect(collaborators.statusMap.updateMap.mock.invocationCallOrder[0]).toBeLessThan(
      collaborators.projection.reprojectConnector.mock.invocationCallOrder[0],
    );
  });

  it('requires exact connector confirmation before deletion', async () => {
    const response = await request(app.getHttpServer()).delete(
      `/api/v1/workspaces/${WORKSPACE_ID}/delivery/connectors/${CONNECTOR_ID}`,
    );

    expect(response.status).toBe(400);
    expect(response.body.message).toContain(`?confirm=${CONNECTOR_ID}`);
    expect(collaborators.delivery.deleteConnector).not.toHaveBeenCalled();
  });

  it('deletes a confirmed connector through the retained service', async () => {
    const response = await request(app.getHttpServer()).delete(
      `/api/v1/workspaces/${WORKSPACE_ID}/delivery/connectors/${CONNECTOR_ID}?confirm=${CONNECTOR_ID}`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ deleted: true });
    expect(collaborators.delivery.deleteConnector).toHaveBeenCalledWith(WORKSPACE_ID, CONNECTOR_ID);
  });

  it.each([
    'specflow-sync',
    'summary',
    'loop-readings',
    'work-items',
    'code-changes',
    'journeys',
    'rework-episodes',
    'classify',
  ])('does not expose the retired %s route', async (route) => {
    const response = await request(app.getHttpServer()).get(`/api/v1/workspaces/${WORKSPACE_ID}/delivery/${route}`);
    expect(response.status).toBe(404);
  });

  it('keeps the status-map connectorId requirement explicit', async () => {
    const controller = new DeliveryController(
      collaborators.delivery as unknown as DeliveryService,
      collaborators.statusMap as unknown as StatusMapService,
      collaborators.projection as unknown as JiraCanonicalProjectionService,
      collaborators.actors as unknown as ActorRegistryService,
    );
    await expect(controller.getStatusMap(WORKSPACE_ID, '')).rejects.toBeInstanceOf(BadRequestException);
  });
});
