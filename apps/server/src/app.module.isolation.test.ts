import { afterAll, describe, expect, it, vi } from 'vitest';

const savedEnvironment = vi.hoisted(() => {
  const keys = [
    'DATABASE_URL',
    'ALLOWED_EMAIL_DOMAINS',
    'OAUTH_JWT_SECRET',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.DATABASE_URL = 'postgresql://127.0.0.1:5432/coredoc_test';
  process.env.ALLOWED_EMAIL_DOMAINS = 'example.com';
  process.env.OAUTH_JWT_SECRET = 'test-only-secret-that-is-at-least-32-characters';
  process.env.GITHUB_CLIENT_ID = 'test-client';
  process.env.GITHUB_CLIENT_SECRET = 'test-secret';
  return { keys, previous };
});
import { Test } from '@nestjs/testing';
import { ApiAppModule, AppModule, WorkerAppModule } from './app.module.js';
import { APP_CONFIG, type AppConfig } from './config/app-config.js';
import { PrismaService } from './database/prisma.service.js';
import { McpModule } from './mcp/mcp.module.js';
import { CaptureModule, CaptureWorkerScheduleModule } from './modules/capture/capture.module.js';
import { CaptureRetentionCron } from './modules/capture/capture-retention.cron.js';
import { CloudAgentRunTriggerCron } from './modules/cloud-agent-runs/cloud-agent-run-trigger.cron.js';
import {
  CloudAgentRunsApiModule,
  CloudAgentRunsWorkerScheduleModule,
} from './modules/cloud-agent-runs/cloud-agent-runs.module.js';
import { GraphSnapshotModule } from './modules/graph-snapshot/graph-snapshot.module.js';
import { GraphSnapshotExecutionService } from './modules/graph-snapshot/graph-snapshot-execution.service.js';
import { JobQueueModule } from './modules/job-queue/job-queue.module.js';
import { JobsApiModule, JobsWorkerModule } from './modules/jobs/jobs.module.js';
import { PushWorkerService } from './modules/jobs/push-worker.service.js';
import { PushApiModule, PushCoreModule } from './modules/push/push.module.js';

afterAll(() => {
  for (const key of savedEnvironment.keys) {
    const previous = savedEnvironment.previous[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

type NestModuleType = abstract new (...args: never[]) => unknown;

function unwrapModule(value: unknown): NestModuleType | null {
  if (typeof value === 'function') return value as NestModuleType;
  if (!value || typeof value !== 'object') return null;
  if ('forwardRef' in value && typeof value.forwardRef === 'function') {
    return unwrapModule(value.forwardRef());
  }
  if ('module' in value) return unwrapModule(value.module);
  return null;
}

function collectModuleGraph(root: NestModuleType): NestModuleType[] {
  const seen = new Set<NestModuleType>();
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const imports = (Reflect.getMetadata('imports', current) ?? []) as unknown[];
    for (const imported of imports) {
      const module = unwrapModule(imported);
      if (module && !seen.has(module)) queue.push(module);
    }
  }
  return [...seen];
}

function metadataEntries(module: NestModuleType, key: 'controllers' | 'providers'): unknown[] {
  return (Reflect.getMetadata(key, module) ?? []) as unknown[];
}

describe('process-role application module isolation', () => {
  it('compiles the real API root without resolving PushWorkerService', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ApiAppModule] })
      .overrideProvider(PrismaService)
      .useValue({} as PrismaService)
      .compile();

    expect(() => moduleRef.get(PushWorkerService, { strict: false })).toThrow();
    // The config boot gate ran for THIS root's role while its imports array was
    // built, and published the validated result.
    expect(moduleRef.get<AppConfig>(APP_CONFIG, { strict: false }).role).toBe('api');
    await moduleRef.close();
  });

  it('compiles the real worker root and recursively contains no controllers or MCP modules', async () => {
    const graph = collectModuleGraph(WorkerAppModule);
    expect(graph).not.toContain(McpModule);
    expect(graph).toContain(CaptureWorkerScheduleModule);
    expect(graph).toContain(CloudAgentRunsWorkerScheduleModule);
    expect(graph).toContain(GraphSnapshotModule);
    expect(graph.flatMap((module) => metadataEntries(module, 'controllers'))).toEqual([]);
    expect(graph.flatMap((module) => metadataEntries(module, 'providers'))).toContain(CaptureRetentionCron);
    expect(graph.flatMap((module) => metadataEntries(module, 'providers'))).toContain(PushWorkerService);
    expect(graph.flatMap((module) => metadataEntries(module, 'providers'))).toContain(CloudAgentRunTriggerCron);

    const moduleRef = await Test.createTestingModule({ imports: [WorkerAppModule] })
      .overrideProvider(PrismaService)
      .useValue({} as PrismaService)
      .compile();
    expect(moduleRef.get(PushWorkerService, { strict: false })).toBeInstanceOf(PushWorkerService);
    expect(moduleRef.get(CaptureRetentionCron, { strict: false })).toBeInstanceOf(CaptureRetentionCron);
    expect(moduleRef.get(CloudAgentRunTriggerCron, { strict: false })).toBeInstanceOf(CloudAgentRunTriggerCron);
    expect(moduleRef.get(GraphSnapshotExecutionService, { strict: false })).toBeInstanceOf(
      GraphSnapshotExecutionService,
    );
    // Compiling at all is the proof that a worker process is not held to the
    // api role's required variables (none of them is set for this role).
    expect(moduleRef.get<AppConfig>(APP_CONFIG, { strict: false }).role).toBe('worker');
    await moduleRef.close();
  });

  it('keeps queue, API, core, and worker module surfaces isolated', () => {
    const apiGraph = collectModuleGraph(ApiAppModule);
    expect(apiGraph).toContain(CaptureModule);
    expect(apiGraph).not.toContain(CaptureWorkerScheduleModule);
    expect(apiGraph.flatMap((module) => metadataEntries(module, 'providers'))).not.toContain(CaptureRetentionCron);
    expect(apiGraph).toContain(CloudAgentRunsApiModule);
    expect(apiGraph).not.toContain(CloudAgentRunsWorkerScheduleModule);
    expect(apiGraph.flatMap((module) => metadataEntries(module, 'providers'))).not.toContain(CloudAgentRunTriggerCron);
    expect(metadataEntries(JobQueueModule, 'controllers')).toEqual([]);
    expect(Reflect.getMetadata('imports', PushCoreModule)).not.toContain(JobQueueModule);
    expect(Reflect.getMetadata('imports', PushApiModule)).toEqual(
      expect.arrayContaining([PushCoreModule, JobQueueModule]),
    );
    expect(metadataEntries(JobsApiModule, 'providers')).not.toContain(PushWorkerService);
    expect(metadataEntries(JobsWorkerModule, 'controllers')).toEqual([]);
  });

  it('composes the API and worker roots for the default all role', () => {
    expect(Reflect.getMetadata('imports', AppModule)).toEqual([ApiAppModule, WorkerAppModule]);
  });
});
