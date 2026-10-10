import '../../config/load-env.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import type { PrismaService } from '../../database/prisma.service.js';
import { PrismaClient, type PushJob } from '../../generated/prisma/client.js';
import { LicenseState } from '../license/license-state.js';
import { licenseServiceIn } from '../license/license.test-support.js';
import type { JobProcessor } from './job-processor.service.js';
import { PushWorkerService } from './push-worker.service.js';

/**
 * The expired-license claim narrowing, proven against the REAL claim CTE — the
 * restriction lives inside that one SQL statement, so a mock of $queryRaw can
 * only ever prove which parameter was sent, not which row PostgreSQL returns.
 *
 * Why "narrow" and not "refuse everything": DeliverySyncCron keeps enqueuing
 * renormalize jobs while expired because the raw payloads they re-derive from
 * are hard-deleted on a retention deadline that does not pause. A wholesale
 * claim refusal turns a paused license into permanent data loss.
 */
const TEST_DATABASE_URL = process.env.PUSH_WORKER_LICENSE_TEST_DATABASE_URL ?? '';
const RUN = `push-worker-license-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;

describe.skipIf(!TEST_DATABASE_URL)('PushWorker license claim narrowing (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let previousDatabaseUrl: string | undefined;
  const workspaceIds: string[] = [];
  const processor = { process: async () => ({}) } as unknown as JobProcessor;

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    pool = buildPrismaAdapter();
    prisma = new PrismaClient({ adapter: pool?.adapter } as never);
    await prisma.$connect();
  });

  afterAll(async () => {
    for (const workspaceId of workspaceIds.reverse()) {
      await prisma.workspace.delete({ where: { id: workspaceId } });
    }
    await prisma.$disconnect();
    if (pool?.pool) await pool.pool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  async function createWorkspace(suffix: string): Promise<string> {
    const workspace = await prisma.workspace.create({
      data: { name: `${RUN}-${suffix}`, slug: `${RUN}-${suffix}` },
    });
    workspaceIds.push(workspace.id);
    return workspace.id;
  }

  /**
   * One job of every type the worker can claim. `resolve` sits in its own
   * workspace: the claim CTE holds resolve jobs while a push is pending in the
   * SAME workspace, and that unrelated rule must not be what makes this test
   * pass. next_run_at ordering deliberately puts renormalize LAST, so a claim
   * that ignored the license would pick a push first.
   */
  async function seedQueue(suffix: string): Promise<{ ids: Record<string, string>; workspaceIds: string[] }> {
    const main = await createWorkspace(`${suffix}-main`);
    const other = await createWorkspace(`${suffix}-other`);
    const base = Date.now() - 60 * 60 * 1000;
    const rows: Array<{ type: 'push' | 'connector_sync' | 'resolve' | 'renormalize'; workspaceId: string }> = [
      { type: 'push', workspaceId: main },
      { type: 'connector_sync', workspaceId: main },
      { type: 'resolve', workspaceId: other },
      { type: 'renormalize', workspaceId: main },
    ];
    const ids: Record<string, string> = {};
    for (const [index, row] of rows.entries()) {
      const job = await prisma.pushJob.create({
        data: {
          workspaceId: row.workspaceId,
          type: row.type,
          repoName: row.type === 'push' ? `${RUN}-repo` : null,
          payload: {},
          status: 'pending',
          nextRunAt: new Date(base + index * 1000),
        },
        select: { id: true },
      });
      ids[row.type] = job.id;
    }
    return { ids, workspaceIds: [main, other] };
  }

  /**
   * Claim until the queue is empty, keeping only OUR rows: the integration
   * database is shared with the other suites in the run, and the claim query is
   * global by design.
   */
  async function claimOurs(worker: PushWorkerService, ours: string[], max = 12): Promise<PushJob[]> {
    const claimed: PushJob[] = [];
    for (let i = 0; i < max; i++) {
      const job = await worker.claimNextJob();
      if (!job) break;
      if (ours.includes(job.workspaceId)) claimed.push(job);
    }
    return claimed;
  }

  it('claims ONLY the renormalize job while the license is expired past grace', async () => {
    const { ids, workspaceIds: ours } = await seedQueue('expired');
    const license = licenseServiceIn(LicenseState.Expired);
    const worker = new PushWorkerService(prisma as unknown as PrismaService, processor, license);

    const claimed = await claimOurs(worker, ours);

    expect(claimed.map((job) => job.type)).toEqual(['renormalize']);
    expect(claimed[0]!.id).toBe(ids.renormalize);
    // Everything else stays pending and un-attempted: the license restriction
    // is part of the claim query, never a claim-then-release.
    const untouched = await prisma.pushJob.findMany({
      where: { id: { in: [ids.push!, ids.resolve!, ids.connector_sync!] } },
      select: { id: true, status: true, attempts: true, leaseToken: true },
    });
    expect(untouched).toHaveLength(3);
    for (const job of untouched) {
      expect(job).toMatchObject({ status: 'pending', attempts: 0, leaseToken: null });
    }
    license.onModuleDestroy();
  });

  it('claims every type while the license is valid', async () => {
    const { workspaceIds: ours } = await seedQueue('valid');
    const license = licenseServiceIn(LicenseState.Valid);
    const worker = new PushWorkerService(prisma as unknown as PrismaService, processor, license);

    const claimed = await claimOurs(worker, ours);

    expect(new Set(claimed.map((job) => job.type))).toEqual(
      new Set(['push', 'connector_sync', 'resolve', 'renormalize']),
    );
    license.onModuleDestroy();
  });
});
