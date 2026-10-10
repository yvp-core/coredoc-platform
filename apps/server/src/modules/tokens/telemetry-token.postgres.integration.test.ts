import '../../config/load-env.js';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import type { PrismaService } from '../../database/prisma.service.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { TokensService } from './tokens.service.js';

const TEST_DATABASE_URL = process.env.TOKEN_TEST_DATABASE_URL ?? '';
const RUN = `telemetry_token_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;

describe.skipIf(!TEST_DATABASE_URL)('installation telemetry tokens (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let service: TokensService;
  let workspaceId: string;
  let previousDatabaseUrl: string | undefined;

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    const built = buildPrismaAdapter();
    pool = built;
    prisma = new PrismaClient({ adapter: built?.adapter } as never);
    const controlPlane = new ControlPlaneService(prisma as unknown as PrismaService);
    service = new TokensService(controlPlane);
    const workspace = await prisma.workspace.create({ data: { name: RUN, slug: RUN } });
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } });
    await prisma.$disconnect();
    if (pool?.pool) await pool.pool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it('atomically rotates one row, invalidates the old bearer, and self-revokes', async () => {
    const installationId = randomUUID();
    const first = await service.rotateInstallationToken(workspaceId, installationId, 'member-1');
    const second = await service.rotateInstallationToken(workspaceId, installationId, 'member-1');

    expect(second.id).toBe(first.id);
    expect(second.token).not.toBe(first.token);
    expect(
      await prisma.serviceToken.findFirst({
        where: { workspaceId, name: `capture-agent:${installationId}` },
        select: { tokenHash: true, tokenEncrypted: true, lastUsedAt: true },
      }),
    ).toEqual({
      tokenHash: createHash('sha256').update(second.token).digest('hex'),
      tokenEncrypted: null,
      lastUsedAt: null,
    });

    await expect(service.listInstallationTokens(workspaceId, 'member-1')).resolves.toEqual([
      expect.objectContaining({ id: first.id, name: `capture-agent:${installationId}` }),
    ]);
    await expect(service.rotateInstallationToken(workspaceId, installationId, 'member-2')).rejects.toMatchObject({
      status: 409,
    });

    await service.revokeInstallationToken(workspaceId, installationId, 'member-1');
    await expect(
      prisma.serviceToken.count({ where: { workspaceId, name: `capture-agent:${installationId}` } }),
    ).resolves.toBe(0);
  });
});
