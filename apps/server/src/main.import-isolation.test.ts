import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const API_ENV_KEYS = [
  'DATABASE_URL',
  'ALLOWED_EMAIL_DOMAINS',
  'OAUTH_JWT_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
] as const;

const previous = new Map<string, string | undefined>();

describe('bootstrap import isolation', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of API_ENV_KEYS) {
      previous.set(key, process.env[key]);
      process.env[key] = '';
    }
  });

  afterEach(() => {
    for (const key of API_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previous.clear();
  });

  it('recognizes the compiled extensionless Nest entrypoint without treating an import as executable', async () => {
    const { isMainEntrypoint } = await import('./main.js');

    expect(isMainEntrypoint('/srv/apps/server/dist/main', 'file:///srv/apps/server/dist/main.js')).toBe(true);
    expect(isMainEntrypoint('/srv/apps/server/dist/main.js', 'file:///srv/apps/server/dist/main.js')).toBe(true);
    expect(isMainEntrypoint('/srv/node_modules/vitest.mjs', 'file:///srv/apps/server/dist/main.js')).toBe(false);
  });

  it('loads and selects the worker root without evaluating API/OAuth configuration', async () => {
    const { bootstrap } = await import('./main.js');
    const worker = { enableShutdownHooks: vi.fn() };
    const factory = {
      create: vi.fn(),
      createApplicationContext: vi.fn().mockResolvedValue(worker),
    };

    await bootstrap('worker', factory as never);

    expect(factory.createApplicationContext).toHaveBeenCalledOnce();
    expect(worker.enableShutdownHooks).toHaveBeenCalledOnce();
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('rejects an invalid role before loading any root module', async () => {
    const { bootstrap } = await import('./main.js');
    const factory = {
      create: vi.fn(),
      createApplicationContext: vi.fn(),
    };

    await expect(bootstrap('sidecar', factory as never)).rejects.toThrow('Invalid PROCESS_ROLE="sidecar"');
    expect(factory.create).not.toHaveBeenCalled();
    expect(factory.createApplicationContext).not.toHaveBeenCalled();
  });
});
