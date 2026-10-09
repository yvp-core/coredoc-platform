import { afterEach, describe, expect, it, vi } from 'vitest';
import { prismaLogLevels } from './create-prisma-client.js';

describe('prismaLogLevels', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('logs every query in development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(prismaLogLevels()).toContain('query');
  });

  it('keeps development quiet when PRISMA_QUERY_LOG is false', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('PRISMA_QUERY_LOG', 'false');
    expect(prismaLogLevels()).toEqual(['warn', 'error']);
  });

  it('never logs queries outside development', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PRISMA_QUERY_LOG', 'true');
    expect(prismaLogLevels()).toEqual(['warn', 'error']);
  });
});
