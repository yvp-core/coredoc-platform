import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';

const LEASE_TTL_MS = 120_000;
const GRAPH_WAIT_MS = 10 * 60_000;
/**
 * How long renewal may keep FAILING (thrown query errors) before we abort the
 * execution. Distinct from a CONFIRMED loss (renewal ran and matched 0 rows),
 * which aborts immediately: a transient Postgres blip must not roll back a
 * multi-minute Turso transaction while the DB-side lease is still ours.
 * TTL/2 leaves a full renewal interval of margin before another pod can
 * legitimately steal the expired lease.
 */
const RENEWAL_FAILURE_BUDGET_MS = LEASE_TTL_MS / 2;

export interface DistributedLease {
  ownerToken: string;
  generation: bigint;
}

/**
 * Repo lease is held by another owner. Extends ConflictException so the
 * ?sync=true HTTP path keeps returning 409; the worker treats it as
 * "resource busy" and reschedules without consuming a failure attempt.
 */
export class RepositoryLeaseBusyError extends ConflictException {
  constructor(repoName: string) {
    super(`Push already in progress for repo "${repoName}" in this workspace`);
  }
}

/**
 * Extends ServiceUnavailableException: on the sync HTTP path contention
 * surfaces as a retriable 503, not a 500; the worker reschedules without
 * consuming a failure attempt.
 */
export class GraphWriteLeaseTimeoutError extends ServiceUnavailableException {
  constructor(workspaceId: string) {
    super(`Timed out waiting for the graph-write lease for workspace ${workspaceId}; retry shortly`);
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Operation aborted'));
    };
    const timer = setTimeout(() => {
      // Detach so a polling loop doesn't accumulate one listener per
      // iteration on the caller's long-lived signal (~2/s for up to 10 min).
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

@Injectable()
export class PushLeaseService {
  constructor(private readonly prisma: PrismaService) {}

  async acquireRepository(workspaceId: string, repoName: string, ownerToken: string): Promise<DistributedLease> {
    const rows = await this.prisma.$queryRaw<Array<{ generation: bigint }>>`
      INSERT INTO repo_push_leases
        (workspace_id, repo_name, owner_token, generation, heartbeat_at, expires_at)
      VALUES
        (${workspaceId}::uuid, ${repoName}, ${ownerToken}::uuid, 1, NOW(), NOW() + INTERVAL '2 minutes')
      ON CONFLICT (workspace_id, repo_name) DO UPDATE SET
        owner_token = EXCLUDED.owner_token,
        generation = CASE
          WHEN repo_push_leases.owner_token = EXCLUDED.owner_token THEN repo_push_leases.generation
          ELSE repo_push_leases.generation + 1
        END,
        heartbeat_at = NOW(),
        expires_at = NOW() + INTERVAL '2 minutes'
      WHERE repo_push_leases.expires_at < NOW()
         OR repo_push_leases.owner_token = EXCLUDED.owner_token
      RETURNING generation
    `;
    const row = rows[0];
    if (!row) {
      throw new RepositoryLeaseBusyError(repoName);
    }
    return { ownerToken, generation: row.generation };
  }

  async renewRepository(workspaceId: string, repoName: string, lease: DistributedLease): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE repo_push_leases
      SET heartbeat_at = NOW(), expires_at = NOW() + INTERVAL '2 minutes'
      WHERE workspace_id = ${workspaceId}::uuid
        AND repo_name = ${repoName}
        AND owner_token = ${lease.ownerToken}::uuid
        AND generation = ${lease.generation}
    `;
    return count === 1;
  }

  async releaseRepository(workspaceId: string, repoName: string, lease: DistributedLease): Promise<void> {
    await this.prisma.$executeRaw`
      DELETE FROM repo_push_leases
      WHERE workspace_id = ${workspaceId}::uuid
        AND repo_name = ${repoName}
        AND owner_token = ${lease.ownerToken}::uuid
        AND generation = ${lease.generation}
    `;
  }

  async acquireGraphWrite(
    workspaceId: string,
    ownerToken: string,
    signal?: AbortSignal,
    onWait?: () => void,
  ): Promise<DistributedLease> {
    const deadline = Date.now() + GRAPH_WAIT_MS;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const rows = await this.prisma.$queryRaw<Array<{ generation: bigint }>>`
        INSERT INTO workspace_graph_write_leases
          (workspace_id, owner_token, generation, heartbeat_at, expires_at)
        VALUES
          (${workspaceId}::uuid, ${ownerToken}::uuid, 1, NOW(), NOW() + INTERVAL '2 minutes')
        ON CONFLICT (workspace_id) DO UPDATE SET
          owner_token = EXCLUDED.owner_token,
          generation = CASE
            WHEN workspace_graph_write_leases.owner_token = EXCLUDED.owner_token
              THEN workspace_graph_write_leases.generation
            ELSE workspace_graph_write_leases.generation + 1
          END,
          heartbeat_at = NOW(),
          expires_at = NOW() + INTERVAL '2 minutes'
        WHERE workspace_graph_write_leases.expires_at < NOW()
           OR workspace_graph_write_leases.owner_token = EXCLUDED.owner_token
        RETURNING generation
      `;
      const row = rows[0];
      if (row) return { ownerToken, generation: row.generation };
      onWait?.();
      await abortableDelay(500 + Math.floor(Math.random() * 250), signal);
    }
    throw new GraphWriteLeaseTimeoutError(workspaceId);
  }

  async renewGraphWrite(workspaceId: string, lease: DistributedLease): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE workspace_graph_write_leases
      SET heartbeat_at = NOW(), expires_at = NOW() + INTERVAL '2 minutes'
      WHERE workspace_id = ${workspaceId}::uuid
        AND owner_token = ${lease.ownerToken}::uuid
        AND generation = ${lease.generation}
    `;
    return count === 1;
  }

  async releaseGraphWrite(workspaceId: string, lease: DistributedLease): Promise<void> {
    await this.prisma.$executeRaw`
      DELETE FROM workspace_graph_write_leases
      WHERE workspace_id = ${workspaceId}::uuid
        AND owner_token = ${lease.ownerToken}::uuid
        AND generation = ${lease.generation}
    `;
  }

  startRenewal(renew: () => Promise<boolean>, abort: (reason: Error) => void): ReturnType<typeof setInterval> {
    let renewing = false;
    let lastSuccessAt = Date.now();
    return setInterval(
      () => {
        if (renewing) return;
        renewing = true;
        renew()
          .then((owned) => {
            // 0 rows matched = the lease is confirmed gone (stolen or released)
            // — abort immediately, another owner may already be writing.
            if (!owned) abort(new Error('Distributed push lease was lost'));
            else lastSuccessAt = Date.now();
          })
          .catch((err) => {
            // The renewal QUERY failed — the DB-side lease may still be ours.
            // Tolerate transient control-plane errors until the TTL is at
            // risk; aborting a multi-minute graph write on one Postgres blip
            // couples push availability to control-plane p999.
            if (Date.now() - lastSuccessAt > RENEWAL_FAILURE_BUDGET_MS) {
              abort(err instanceof Error ? err : new Error(String(err)));
            }
          })
          .finally(() => {
            renewing = false;
          });
      },
      Math.min(15_000, LEASE_TTL_MS / 4),
    );
  }
}
