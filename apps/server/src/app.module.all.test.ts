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
import { AppModule } from './app.module.js';
import { PrismaService } from './database/prisma.service.js';
import { PushWorkerService } from './modules/jobs/push-worker.service.js';

afterAll(() => {
  for (const key of savedEnvironment.keys) {
    const previous = savedEnvironment.previous[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

describe('default all application module', () => {
  it('compiles the real composed API and worker root', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({} as PrismaService)
      .compile();

    expect(moduleRef.get(PushWorkerService, { strict: false })).toBeInstanceOf(PushWorkerService);
    await moduleRef.close();
  });
});
