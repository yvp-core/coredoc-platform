import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service.js';
import type { GithubImporterService } from './github-importer.service.js';
import type { JiraImporterService } from './jira-importer.service.js';
import { DeliveryService } from './delivery.service.js';

const encryption = {
  available: vi.fn(() => true),
  encrypt: vi.fn((value: string) => `encrypted:${value}`),
};

vi.mock('../../database/encryption.js', () => ({
  isEncryptionAvailable: () => encryption.available(),
  encrypt: (value: string) => encryption.encrypt(value),
}));

function mockPrisma() {
  const prisma = {
    workspace: {
      findUnique: vi.fn().mockResolvedValue({ deliveryEnabled: true }),
      update: vi.fn().mockResolvedValue({ deliveryEnabled: false }),
    },
    deliveryConnector: {
      findUnique: vi.fn().mockResolvedValue({ provider: 'github' }),
      findFirst: vi.fn().mockResolvedValue({ id: 'conn-1', status: 'active' }),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({ id: 'conn-1' }),
      update: vi.fn().mockResolvedValue({ id: 'conn-1', status: 'paused' }),
      delete: vi.fn().mockResolvedValue({ id: 'conn-1' }),
    },
    pushJob: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'job-1' }),
    },
  };
  return prisma as unknown as PrismaService & typeof prisma;
}

function makeService(prisma = mockPrisma()) {
  const github = { syncConnector: vi.fn().mockResolvedValue({ repos: 1, prs: 2, unlinkedRepos: [] }) };
  const jira = { syncConnector: vi.fn().mockResolvedValue({ issues: 3 }) };
  return {
    prisma,
    github,
    jira,
    service: new DeliveryService(
      prisma,
      github as unknown as GithubImporterService,
      jira as unknown as JiraImporterService,
    ),
  };
}

beforeEach(() => {
  encryption.available.mockReset().mockReturnValue(true);
  encryption.encrypt.mockClear();
});

describe('DeliveryService retained connector surface', () => {
  it('reads and updates the workspace delivery flag', async () => {
    const { service, prisma } = makeService();

    await expect(service.getDeliverySettings('ws-1')).resolves.toEqual({ enabled: true });
    await expect(service.setDeliverySettings('ws-1', false)).resolves.toEqual({ enabled: false });
    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: 'ws-1' },
      data: { deliveryEnabled: false },
      select: { deliveryEnabled: true },
    });
  });

  it('routes GitHub and Jira connector syncs to their canonical importers', async () => {
    const { service, prisma, github, jira } = makeService();

    await expect(service.runConnectorSync('conn-1')).resolves.toEqual({ repos: 1, prs: 2, unlinkedRepos: [] });
    expect(github.syncConnector).toHaveBeenCalledWith('conn-1');

    prisma.deliveryConnector.findUnique.mockResolvedValueOnce({ provider: 'jira' });
    await expect(service.runConnectorSync('conn-2')).resolves.toEqual({ issues: 3 });
    expect(jira.syncConnector).toHaveBeenCalledWith('conn-2');
  });

  it('rejects missing and retired-provider connector syncs', async () => {
    const { service, prisma } = makeService();
    prisma.deliveryConnector.findUnique.mockResolvedValueOnce(null);
    await expect(service.runConnectorSync('missing')).rejects.toBeInstanceOf(NotFoundException);

    prisma.deliveryConnector.findUnique.mockResolvedValueOnce({ provider: 'coredoc' });
    await expect(service.runConnectorSync('legacy')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stores only canonical Jira connector configuration', async () => {
    const { service, prisma } = makeService();

    await expect(
      service.upsertConnector('ws-1', {
        provider: 'jira',
        token: 'token',
        email: 'bot@example.test',
        baseUrl: 'https://example.atlassian.net',
        projects: ['ENG'],
      }),
    ).resolves.toEqual({ id: 'conn-1' });

    expect(prisma.deliveryConnector.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ config: { projects: ['ENG'], lookbackDays: 30 } }),
        update: expect.objectContaining({ config: { projects: ['ENG'], lookbackDays: 30 } }),
      }),
    );
  });

  it('persists an explicit Jira ingest window instead of the default', async () => {
    const { service, prisma } = makeService();

    await service.upsertConnector('ws-1', {
      provider: 'jira',
      token: 'token',
      email: 'bot@example.test',
      baseUrl: 'https://example.atlassian.net',
      projects: ['ENG'],
      lookbackDays: 7,
    });

    expect(prisma.deliveryConnector.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ config: { projects: ['ENG'], lookbackDays: 7 } }),
      }),
    );
  });

  it('persists an absolute `since` normalized to ISO, and drops the relative window', async () => {
    const { service, prisma } = makeService();

    await service.upsertConnector('ws-1', {
      provider: 'jira',
      token: 'token',
      email: 'bot@example.test',
      baseUrl: 'https://example.atlassian.net',
      projects: ['ENG'],
      since: '2026-08-01',
    });

    expect(prisma.deliveryConnector.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          config: { projects: ['ENG'], since: '2026-08-01T00:00:00.000Z' },
        }),
      }),
    );
  });

  it('persists `since` for github connectors on the same terms', async () => {
    const { service, prisma } = makeService();

    await service.upsertConnector('ws-1', {
      provider: 'github',
      token: 'token',
      repos: ['o/r'],
      since: '2026-08-01T09:30:00.000Z',
    });

    expect(prisma.deliveryConnector.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          config: { repos: ['o/r'], since: '2026-08-01T09:30:00.000Z' },
        }),
        update: expect.objectContaining({
          config: { repos: ['o/r'], since: '2026-08-01T09:30:00.000Z' },
        }),
      }),
    );
  });

  it('carries a stored `since` forward when an update supplies no floor', async () => {
    // Re-posting a connector to rotate its token must not silently reset the floor to
    // the default 30-day window — that would change what a not-yet-run backfill ingests.
    const prisma = mockPrisma();
    prisma.deliveryConnector.findUnique.mockResolvedValue({
      config: { repos: ['o/r'], since: '2026-08-01T00:00:00.000Z' },
    });
    const { service } = makeService(prisma);

    await service.upsertConnector('ws-1', { provider: 'github', token: 'rotated', repos: ['o/r'] });

    expect(prisma.deliveryConnector.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          config: { repos: ['o/r'], since: '2026-08-01T00:00:00.000Z' },
        }),
      }),
    );
  });

  it('carries a stored non-default lookbackDays forward on the Jira path too', async () => {
    const prisma = mockPrisma();
    prisma.deliveryConnector.findUnique.mockResolvedValue({ config: { projects: ['ENG'], lookbackDays: 7 } });
    const { service } = makeService(prisma);

    await service.upsertConnector('ws-1', {
      provider: 'jira',
      token: 'rotated',
      email: 'bot@example.test',
      baseUrl: 'https://example.atlassian.net',
      projects: ['ENG'],
    });

    expect(prisma.deliveryConnector.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ config: { projects: ['ENG'], lookbackDays: 7 } }),
      }),
    );
  });

  it('lets an explicit floor replace the stored one, leaving exactly one form persisted', async () => {
    const prisma = mockPrisma();
    prisma.deliveryConnector.findUnique.mockResolvedValue({
      config: { repos: ['o/r'], since: '2026-08-01T00:00:00.000Z' },
    });
    const { service } = makeService(prisma);

    await service.upsertConnector('ws-1', { provider: 'github', token: 'tok', repos: ['o/r'], lookbackDays: 14 });

    expect(prisma.deliveryConnector.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ config: { repos: ['o/r'], lookbackDays: 14 } }),
      }),
    );
  });

  it('falls back to the default floor when the stored config carries none', async () => {
    const prisma = mockPrisma();
    prisma.deliveryConnector.findUnique.mockResolvedValue({ config: { repos: ['o/r'] } });
    const { service } = makeService(prisma);

    await service.upsertConnector('ws-1', { provider: 'github', token: 'tok', repos: ['o/r'] });

    expect(prisma.deliveryConnector.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ config: { repos: ['o/r'], lookbackDays: 30 } }),
      }),
    );
  });

  it('rejects a body that sets both ingest-floor forms', async () => {
    const { service, prisma } = makeService();

    await expect(
      service.upsertConnector('ws-1', {
        provider: 'github',
        token: 'token',
        since: '2026-08-01',
        lookbackDays: 30,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.deliveryConnector.upsert).not.toHaveBeenCalled();
  });

  it('rejects an unparseable `since` rather than silently falling back to the window', async () => {
    const { service } = makeService();

    await expect(
      service.upsertConnector('ws-1', { provider: 'github', token: 'token', since: 'not-a-date' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses connector credentials when encryption is unavailable', async () => {
    encryption.available.mockReturnValue(false);
    const { service, prisma } = makeService();

    await expect(service.upsertConnector('ws-1', { provider: 'github', token: 'token' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.deliveryConnector.upsert).not.toHaveBeenCalled();
  });

  it('lists only the safe connector projection', async () => {
    const { service, prisma } = makeService();
    await service.listConnectors('ws-1');

    expect(prisma.deliveryConnector.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        provider: true,
        providerVariant: true,
        displayName: true,
        status: true,
        lastSyncAt: true,
        config: true,
        createdAt: true,
      },
    });
  });

  it('deletes the owned connector and relies on schema referential actions', async () => {
    const { service, prisma } = makeService();

    await expect(service.deleteConnector('ws-1', 'conn-1')).resolves.toEqual({ deleted: true });
    expect(prisma.deliveryConnector.findFirst).toHaveBeenCalledWith({
      where: { id: 'conn-1', workspaceId: 'ws-1' },
      select: { id: true },
    });
    expect(prisma.deliveryConnector.delete).toHaveBeenCalledWith({ where: { id: 'conn-1' } });
  });

  it('deduplicates active connector-sync jobs and creates a job when none exists', async () => {
    const { service, prisma } = makeService();
    prisma.pushJob.findFirst.mockResolvedValueOnce({ id: 'job-existing' });

    await expect(service.enqueueConnectorSyncJob('ws-1', 'conn-1')).resolves.toEqual({ id: 'job-existing' });
    expect(prisma.pushJob.create).not.toHaveBeenCalled();

    prisma.pushJob.findFirst.mockResolvedValueOnce(null);
    await expect(service.enqueueConnectorSyncJob('ws-1', 'conn-1')).resolves.toEqual({ id: 'job-1' });
    expect(prisma.pushJob.create).toHaveBeenCalledWith({
      data: {
        workspaceId: 'ws-1',
        repoName: 'conn-1',
        type: 'connector_sync',
        payload: { connectorId: 'conn-1' },
      },
    });
  });

  it('refuses manual sync while a connector is paused', async () => {
    const { service, prisma } = makeService();
    prisma.deliveryConnector.findFirst.mockResolvedValueOnce({ id: 'conn-1', status: 'paused' });

    await expect(service.triggerConnectorSync('ws-1', 'conn-1', 'u1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.pushJob.create).not.toHaveBeenCalled();
  });
});
