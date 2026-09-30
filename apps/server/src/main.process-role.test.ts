import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const savedEnvironment = vi.hoisted(() => {
  const keys = [
    'DATABASE_URL',
    'ALLOWED_EMAIL_DOMAINS',
    'OAUTH_JWT_SECRET',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'PROCESS_ROLE',
    'PORT',
    'WEB_DIST_PATH',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.DATABASE_URL = 'postgresql://127.0.0.1:5432/coredoc_test';
  process.env.ALLOWED_EMAIL_DOMAINS = 'example.com';
  process.env.OAUTH_JWT_SECRET = 'test-only-secret-that-is-at-least-32-characters';
  process.env.GITHUB_CLIENT_ID = 'test-client';
  process.env.GITHUB_CLIENT_SECRET = 'test-secret';
  delete process.env.PROCESS_ROLE;
  delete process.env.PORT;
  delete process.env.WEB_DIST_PATH;
  return { keys, previous };
});

import { ApiAppModule, AppModule, WorkerAppModule } from './app.module.js';
import { bootstrap } from './main.js';

afterAll(() => {
  for (const key of savedEnvironment.keys) {
    const previous = savedEnvironment.previous[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

type BootstrapFactory = NonNullable<Parameters<typeof bootstrap>[1]>;

function createBootstrapHarness() {
  const app = {
    use: vi.fn(),
    useBodyParser: vi.fn(),
    useGlobalPipes: vi.fn(),
    useGlobalFilters: vi.fn(),
    setGlobalPrefix: vi.fn(),
    get: vi.fn(() => ({ use: vi.fn() })),
    useStaticAssets: vi.fn(),
    enableShutdownHooks: vi.fn(),
    listen: vi.fn().mockResolvedValue(undefined),
  };
  const worker = { enableShutdownHooks: vi.fn() };
  const create = vi.fn().mockResolvedValue(app);
  const createApplicationContext = vi.fn().mockResolvedValue(worker);
  const factory = { create, createApplicationContext } as unknown as BootstrapFactory;

  return { app, worker, create, createApplicationContext, factory };
}

describe('process-role bootstrap', () => {
  beforeEach(() => {
    delete process.env.PROCESS_ROLE;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('starts worker as a headless application context with shutdown hooks and no listener', async () => {
    const harness = createBootstrapHarness();
    process.env.PROCESS_ROLE = 'worker';

    await bootstrap(undefined, harness.factory);

    expect(harness.createApplicationContext).toHaveBeenCalledWith(WorkerAppModule, {
      bufferLogs: true,
    });
    expect(harness.worker.enableShutdownHooks).toHaveBeenCalledOnce();
    expect(harness.create).not.toHaveBeenCalled();
    expect(harness.app.listen).not.toHaveBeenCalled();
  });

  it('starts the API-only HTTP graph for the api role', async () => {
    const harness = createBootstrapHarness();

    await bootstrap('api', harness.factory);

    expect(harness.create).toHaveBeenCalledWith(ApiAppModule, {
      rawBody: true,
      bodyParser: true,
      bufferLogs: true,
    });
    expect(harness.app.enableShutdownHooks).toHaveBeenCalledOnce();
    expect(harness.app.listen).toHaveBeenCalledOnce();
    expect(harness.createApplicationContext).not.toHaveBeenCalled();
  });

  it('starts the composed HTTP graph for the all role', async () => {
    const harness = createBootstrapHarness();

    await bootstrap('all', harness.factory);

    expect(harness.create).toHaveBeenCalledWith(AppModule, expect.any(Object));
    expect(harness.app.listen).toHaveBeenCalledOnce();
  });

  it('defaults an omitted role to the composed all graph', async () => {
    const harness = createBootstrapHarness();

    await bootstrap(undefined, harness.factory);

    expect(harness.create).toHaveBeenCalledWith(AppModule, expect.any(Object));
  });

  it('rejects an invalid role before either Nest bootstrap path runs', async () => {
    const harness = createBootstrapHarness();
    process.env.PROCESS_ROLE = 'sidecar';

    await expect(bootstrap(undefined, harness.factory)).rejects.toThrow('Invalid PROCESS_ROLE="sidecar"');
    expect(harness.create).not.toHaveBeenCalled();
    expect(harness.createApplicationContext).not.toHaveBeenCalled();
  });
});
