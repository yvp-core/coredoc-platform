/**
 * Shared Prisma client construction.
 *
 * Two consumers build a Prisma client the same way:
 *  - `PrismaService` (DI-managed) extends `PrismaClient` and calls `super()`
 *    with the adapter options produced by `buildPrismaAdapter()`.
 *  - `PrismaOAuthStore` is constructed at module-definition time (the
 *    @rekog/mcp-nest custom store is registered as a `useValue` provider, so it
 *    cannot receive the DI-managed `PrismaService`). It owns a standalone
 *    client built by `createStandalonePrismaClient()` and disposes it itself.
 */

import { PrismaClient } from '../generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { configFromEnv } from '../config/app-config.js';
import pg from 'pg';

export type PrismaLogLevel = 'query' | 'warn' | 'error';

/** Log levels: every query in development unless `PRISMA_QUERY_LOG=false`; quiet otherwise. */
export function prismaLogLevels(): PrismaLogLevel[] {
  const misc = configFromEnv().misc;
  return misc.nodeEnv === 'development' && misc.prismaQueryLog ? ['query', 'warn', 'error'] : ['warn', 'error'];
}

/**
 * Build the pg driver adapter (required by Prisma v7) and its underlying pool.
 * Returns `null` when `DATABASE_URL` is unset so the caller can construct a
 * client without a live connection (matches prior PrismaService behavior).
 */
export function buildPrismaAdapter(): { adapter: PrismaPg; pool: pg.Pool } | null {
  const connectionString = configFromEnv().misc.databaseUrl;
  if (!connectionString) return null;
  const pool = new pg.Pool({ connectionString });
  return { adapter: new PrismaPg(pool), pool };
}

/**
 * Construct a standalone `PrismaClient` (not DI-managed). The caller owns its
 * lifecycle and must `$disconnect()` the client and `end()` the returned pool
 * on shutdown.
 */
export function createStandalonePrismaClient(): { client: PrismaClient; pool: pg.Pool | null } {
  const built = buildPrismaAdapter();
  const client = new PrismaClient({
    adapter: built?.adapter,
    log: prismaLogLevels(),
  } as never);
  return { client, pool: built?.pool ?? null };
}
