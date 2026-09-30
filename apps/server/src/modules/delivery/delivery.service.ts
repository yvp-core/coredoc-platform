import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { encrypt, isEncryptionAvailable } from '../../database/encryption.js';
import { PrismaService } from '../../database/prisma.service.js';
import { DeliveryProvider, Prisma } from '../../generated/prisma/client.js';
import type { CreateConnectorInput } from './delivery.contract.js';
import { GithubImporterService } from './github-importer.service.js';
import { DEFAULT_LOOKBACK_DAYS, normalizeSince, storedIngestWindow } from './ingest-window.js';
import { JiraImporterService } from './jira-importer.service.js';

export interface SafeConnector {
  id: string;
  provider: DeliveryProvider;
  providerVariant: string | null;
  displayName: string;
  status: string;
  lastSyncAt: Date | null;
  config: Prisma.JsonValue;
  createdAt: Date;
}

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly githubImporter: GithubImporterService,
    private readonly jiraImporter: JiraImporterService,
  ) {}

  async isDeliveryEnabled(workspaceId: string): Promise<boolean> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { deliveryEnabled: true },
    });
    return workspace?.deliveryEnabled === true;
  }

  async getDeliverySettings(workspaceId: string): Promise<{ enabled: boolean }> {
    return { enabled: await this.isDeliveryEnabled(workspaceId) };
  }

  async setDeliverySettings(workspaceId: string, enabled: boolean): Promise<{ enabled: boolean }> {
    const workspace = await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { deliveryEnabled: enabled },
      select: { deliveryEnabled: true },
    });
    return { enabled: workspace.deliveryEnabled };
  }

  async runConnectorSync(connectorId: string): Promise<unknown> {
    const connector = await this.prisma.deliveryConnector.findUnique({
      where: { id: connectorId },
      select: { provider: true },
    });
    if (!connector) throw new NotFoundException(`Connector ${connectorId} not found`);
    if (connector.provider === DeliveryProvider.github) return this.githubImporter.syncConnector(connectorId);
    if (connector.provider === DeliveryProvider.jira) return this.jiraImporter.syncConnector(connectorId);
    throw new BadRequestException(
      `Connector ${connectorId} provider ${connector.provider} has no connector_sync importer`,
    );
  }

  async upsertGithubConnector(workspaceId: string, dto: CreateConnectorInput): Promise<{ id: string }> {
    if (!isEncryptionAvailable()) {
      throw new BadRequestException(
        'Token encryption is unavailable (SERVER_ENCRYPTION_KEY not configured); refusing to store the PAT in plaintext.',
      );
    }
    const ingestWindow = await this.ingestWindowConfig(workspaceId, DeliveryProvider.github, dto);
    const connector = await this.prisma.deliveryConnector.upsert({
      where: {
        workspaceId_provider_providerVariant: {
          workspaceId,
          provider: DeliveryProvider.github,
          providerVariant: 'cloud',
        },
      },
      create: {
        workspaceId,
        provider: DeliveryProvider.github,
        providerVariant: 'cloud',
        displayName: 'github',
        authKind: 'pat',
        credentialsEncrypted: encrypt(dto.token),
        config: { repos: dto.repos ?? [], ...ingestWindow },
        baseUrl: dto.baseUrl ?? null,
      },
      update: {
        credentialsEncrypted: encrypt(dto.token),
        config: { repos: dto.repos ?? [], ...ingestWindow },
        baseUrl: dto.baseUrl ?? null,
        authKind: 'pat',
      },
    });
    return { id: connector.id };
  }

  async upsertConnector(workspaceId: string, dto: CreateConnectorInput): Promise<{ id: string }> {
    if (dto.provider === 'github') return this.upsertGithubConnector(workspaceId, dto);
    if (!isEncryptionAvailable()) {
      throw new BadRequestException(
        'Token encryption is unavailable (SERVER_ENCRYPTION_KEY not configured); refusing to store the Jira API token in plaintext.',
      );
    }
    if (!dto.email || !dto.baseUrl) {
      throw new BadRequestException('Jira connectors require both `email` and `baseUrl`.');
    }
    const credentialsEncrypted = encrypt(JSON.stringify({ email: dto.email, apiToken: dto.token }));
    const config = {
      projects: dto.projects ?? [],
      ...(await this.ingestWindowConfig(workspaceId, DeliveryProvider.jira, dto)),
    } as Prisma.InputJsonValue;
    const connector = await this.prisma.deliveryConnector.upsert({
      where: {
        workspaceId_provider_providerVariant: {
          workspaceId,
          provider: DeliveryProvider.jira,
          providerVariant: 'cloud',
        },
      },
      create: {
        workspaceId,
        provider: DeliveryProvider.jira,
        providerVariant: 'cloud',
        displayName: 'jira',
        authKind: 'basic',
        credentialsEncrypted,
        config,
        baseUrl: dto.baseUrl,
      },
      update: { credentialsEncrypted, config, baseUrl: dto.baseUrl, authKind: 'basic' },
    });
    return { id: connector.id };
  }

  /**
   * The connector's ingest floor as stored `config` keys. Exactly one form is persisted:
   * an absolute `since` when the caller supplied one, else the relative `lookbackDays`
   * window. Setting both is a config error rather than a silent precedence rule, so it is
   * rejected here — the DTO can validate each field but not their exclusivity.
   *
   * A caller supplying NEITHER inherits the floor already stored on the connector rather
   * than the default: this endpoint replaces `config` wholesale, so re-posting a
   * connector to rotate its token would otherwise overwrite an explicit `since` with a
   * fabricated 30-day window — silently changing what a not-yet-run backfill ingests.
   * `repos`/`projects` keep their plain replace semantics; only the floor, whose default
   * we invent rather than receive, is carried forward.
   */
  private async ingestWindowConfig(
    workspaceId: string,
    provider: DeliveryProvider,
    dto: CreateConnectorInput,
  ): Promise<{ since: string } | { lookbackDays: number }> {
    if (dto.since !== undefined && dto.lookbackDays !== undefined) {
      throw new BadRequestException('Provide either `since` or `lookbackDays`, not both.');
    }
    if (dto.since !== undefined) {
      const since = normalizeSince(dto.since);
      if (since === null) throw new BadRequestException('`since` is not a parseable ISO-8601 instant.');
      return { since };
    }
    if (dto.lookbackDays !== undefined) return { lookbackDays: dto.lookbackDays };

    // Read-then-write, deliberately unlocked. Two overlapping provisioning calls can let
    // this read miss a floor the other is committing, reverting it. That is accepted: the
    // whole endpoint is last-write-wins — concurrent calls already race on `config`,
    // `credentialsEncrypted` and `baseUrl` — so serializing this one field would surface a
    // conflict error on a rare admin action while the rest still silently races. A reverted
    // floor is visible in `GET connectors` and fixed by re-posting, and only matters before
    // the first sync. Revisit together with concurrency for the endpoint as a whole.
    const existing = await this.prisma.deliveryConnector.findUnique({
      where: { workspaceId_provider_providerVariant: { workspaceId, provider, providerVariant: 'cloud' } },
      select: { config: true },
    });
    return storedIngestWindow(existing?.config) ?? { lookbackDays: DEFAULT_LOOKBACK_DAYS };
  }

  async assertConnectorInWorkspace(workspaceId: string, connectorId: string): Promise<void> {
    const connector = await this.prisma.deliveryConnector.findFirst({
      where: { id: connectorId, workspaceId },
      select: { id: true },
    });
    if (!connector) throw new NotFoundException(`Connector ${connectorId} not found in this workspace`);
  }

  async listConnectors(workspaceId: string): Promise<{ connectors: SafeConnector[] }> {
    const connectors = await this.prisma.deliveryConnector.findMany({
      where: { workspaceId },
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
    return { connectors };
  }

  async triggerConnectorSync(
    workspaceId: string,
    connectorId: string,
    userId: string | null,
  ): Promise<{ jobId: string }> {
    const connector = await this.prisma.deliveryConnector.findFirst({
      where: { id: connectorId, workspaceId },
      select: { id: true, status: true },
    });
    if (!connector) throw new NotFoundException(`Connector ${connectorId} not found in this workspace`);
    if (connector.status === 'paused') throw new BadRequestException('Connector is paused; resume it first');
    this.logger.log(`connector_sync triggered for ${connectorId} by ${userId ?? 'system'}`);
    const job = await this.enqueueConnectorSyncJob(workspaceId, connectorId);
    return { jobId: job.id };
  }

  async setConnectorStatus(
    workspaceId: string,
    connectorId: string,
    status: 'active' | 'paused',
  ): Promise<{ id: string; status: string }> {
    await this.assertConnectorInWorkspace(workspaceId, connectorId);
    const updated = await this.prisma.deliveryConnector.update({
      where: { id: connectorId },
      data: { status },
      select: { id: true, status: true },
    });
    return { id: updated.id, status: updated.status };
  }

  async deleteConnector(workspaceId: string, connectorId: string): Promise<{ deleted: true }> {
    await this.assertConnectorInWorkspace(workspaceId, connectorId);
    await this.prisma.deliveryConnector.delete({ where: { id: connectorId } });
    return { deleted: true };
  }

  async enqueueConnectorSyncJob(workspaceId: string, connectorId: string) {
    const existing = await this.prisma.pushJob.findFirst({
      where: { workspaceId, type: 'connector_sync', repoName: connectorId, status: { in: ['pending', 'running'] } },
    });
    if (existing) return existing;
    return this.prisma.pushJob.create({
      data: {
        workspaceId,
        repoName: connectorId,
        type: 'connector_sync',
        payload: { connectorId } as Prisma.InputJsonValue,
      },
    });
  }

  async enqueueRenormalizeJob(workspaceId: string, connectorId?: string) {
    const existing = await this.prisma.pushJob.findFirst({
      where: { workspaceId, type: 'renormalize', status: { in: ['pending', 'running'] } },
    });
    if (existing) return existing;
    return this.prisma.pushJob.create({
      data: {
        workspaceId,
        repoName: 'renormalize',
        type: 'renormalize',
        payload: { connectorId } as Prisma.InputJsonValue,
      },
    });
  }
}
