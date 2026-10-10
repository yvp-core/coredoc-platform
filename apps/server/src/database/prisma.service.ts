/**
 * Prisma Service
 *
 * NestJS-integrated Prisma client for the control plane database.
 * Uses pg driver adapter as required by Prisma v7.
 */

import { Injectable, OnModuleInit, OnApplicationShutdown, Logger } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client.js';
import pg from 'pg';
import { buildPrismaAdapter, prismaLogLevels } from './create-prisma-client.js';
import { configFromEnv } from '../config/app-config.js';

// Store pool outside the class to avoid property shadowing issues with PrismaClient
const poolRegistry = new WeakMap<PrismaService, pg.Pool>();

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const result = buildPrismaAdapter();
    super({
      adapter: result?.adapter,
      log: prismaLogLevels(),
    } as never);
    if (result?.pool) {
      poolRegistry.set(this, result.pool);
    }
  }

  async onModuleInit(): Promise<void> {
    if (!configFromEnv().misc.databaseUrl) {
      this.logger.warn('DATABASE_URL not set — Prisma client not connected');
      return;
    }
    await this.$connect();
    this.logger.log('Prisma client connected to database');
  }

  /**
   * Tear the connection down on `onApplicationShutdown` — the LAST termination
   * phase — so the pg pool stays alive while consumers shut down in earlier
   * phases. PushWorkerService drains its polling loops in `onModuleDestroy`
   * (the first phase); closing the pool here guarantees those in-flight queries
   * complete first. Closing it earlier raced the worker and produced
   * "Cannot use a pool after calling end on the pool" on every restart.
   */
  async onApplicationShutdown(): Promise<void> {
    const pool = poolRegistry.get(this);
    try {
      await this.$disconnect();
    } finally {
      if (pool) {
        await pool.end();
      }
    }
  }
}
