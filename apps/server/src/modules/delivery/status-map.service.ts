import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { DeliveryTaskLifecycle } from './canonical-delivery.contract.js';

const STATUS_RAW_MAX = 128;

export interface CanonicalStatusPolicy {
  lifecycle: DeliveryTaskLifecycle | null;
  createsShipEvidence: boolean;
}

interface StatusMapRow {
  statusRaw: string;
  source: string;
}

function deterministicallyOrdered<T extends StatusMapRow>(rows: T[]): T[] {
  return [...rows].sort((left, right) => {
    const leftPriority = left.source === 'default' ? 0 : 1;
    const rightPriority = right.source === 'default' ? 0 : 1;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    if (left.source !== right.source) return left.source < right.source ? -1 : 1;
    if (left.statusRaw === right.statusRaw) return 0;
    return left.statusRaw < right.statusRaw ? -1 : 1;
  });
}

function categoryToLifecycle(key: string | undefined): DeliveryTaskLifecycle {
  return key === 'done' ? 'completed' : 'active';
}

/** Owns the canonical Jira-status policy used by delivery projections. */
@Injectable()
export class StatusMapService {
  private readonly logger = new Logger(StatusMapService.name);

  constructor(private readonly prisma: PrismaService) {}

  async bootstrapFromStatuses(
    workspaceId: string,
    connectorId: string,
    statuses: unknown[],
  ): Promise<{ created: number }> {
    const data: {
      workspaceId: string;
      connectorId: string;
      statusRaw: string;
      lifecycle: DeliveryTaskLifecycle;
      createsShipEvidence: boolean;
      source: string;
    }[] = [];
    for (const entry of statuses) {
      if (entry === null || typeof entry !== 'object') continue;
      const value = entry as Record<string, unknown>;
      if (typeof value.name !== 'string') continue;
      const statusRaw = value.name.trim().slice(0, STATUS_RAW_MAX);
      if (statusRaw === '') continue;
      const category = value.statusCategory as Record<string, unknown> | undefined;
      const key = typeof category?.key === 'string' ? category.key : undefined;
      data.push({
        workspaceId,
        connectorId,
        statusRaw,
        lifecycle: categoryToLifecycle(key),
        createsShipEvidence: false,
        source: 'default',
      });
    }

    const { count } = await this.prisma.deliveryStatusMap.createMany({ data, skipDuplicates: true });
    this.logger.debug(`bootstrapped ${count} status-map rows for connector ${connectorId}`);
    return { created: count };
  }

  async getCanonicalMap(
    workspaceId: string,
    connectorId: string,
    reader: Pick<Prisma.TransactionClient, 'deliveryStatusMap'> = this.prisma,
  ): Promise<Map<string, CanonicalStatusPolicy>> {
    const rows = await reader.deliveryStatusMap.findMany({ where: { workspaceId, connectorId } });
    const map = new Map<string, CanonicalStatusPolicy>();
    for (const row of deterministicallyOrdered(rows)) {
      map.set(row.statusRaw.toLowerCase(), {
        lifecycle: row.lifecycle as DeliveryTaskLifecycle | null,
        createsShipEvidence: row.createsShipEvidence,
      });
    }
    return map;
  }

  async listMap(
    workspaceId: string,
    connectorId: string,
  ): Promise<{
    entries: {
      statusRaw: string;
      lifecycle: DeliveryTaskLifecycle | null;
      createsShipEvidence: boolean;
      source: string;
    }[];
  }> {
    const rows = await this.prisma.deliveryStatusMap.findMany({
      where: { workspaceId, connectorId },
      orderBy: { statusRaw: 'asc' },
    });
    return {
      entries: rows.map((row) => ({
        statusRaw: row.statusRaw,
        lifecycle: row.lifecycle as DeliveryTaskLifecycle | null,
        createsShipEvidence: row.createsShipEvidence,
        source: row.source,
      })),
    };
  }

  async updateMap(
    workspaceId: string,
    connectorId: string,
    entries: {
      status: string;
      lifecycle?: DeliveryTaskLifecycle | null;
      createsShipEvidence?: boolean;
    }[],
  ): Promise<{ upserted: number }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "delivery_connectors"
        WHERE "workspace_id" = ${workspaceId}::uuid
          AND "id" = ${connectorId}::uuid
        FOR UPDATE
      `;

      let upserted = 0;
      for (const entry of entries) {
        const statusRaw = entry.status.trim().slice(0, STATUS_RAW_MAX);
        if (statusRaw === '') continue;
        const policy = {
          ...(entry.lifecycle !== undefined ? { lifecycle: entry.lifecycle } : {}),
          ...(entry.createsShipEvidence !== undefined ? { createsShipEvidence: entry.createsShipEvidence } : {}),
        };
        await tx.deliveryStatusMap.upsert({
          where: { workspaceId_connectorId_statusRaw: { workspaceId, connectorId, statusRaw } },
          create: { workspaceId, connectorId, statusRaw, ...policy, source: 'admin' },
          update: { ...policy, source: 'admin' },
        });
        upserted++;
      }
      return { upserted };
    });
  }
}
