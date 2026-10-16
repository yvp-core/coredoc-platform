import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSync } from './index.js';

vi.mock('../auth.js', () => ({
  getToken: vi.fn(async () => 'cdt_test'),
  getServerUrl: vi.fn(async () => 'https://api.test'),
  authHeaders: vi.fn(async () => ({ Authorization: 'Bearer cdt_test' })),
}));

describe('runSync', () => {
  let workDir: string;
  let configPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'sync-runner-'));
    configPath = join(workDir, 'coredoc.config.json');
    mkdirSync(join(workDir, 'output', 'p1'), { recursive: true });
    mkdirSync(join(workDir, 'parsers', 'p1'), { recursive: true });

    const parsed = {
      id: 'repo:demo',
      name: 'demo',
      files: [],
      functions: [],
      classes: [],
      entrypoints: [],
      entities: [],
      externalCalls: [],
    };
    writeFileSync(join(workDir, 'output', 'p1', 'demo.json'), JSON.stringify(parsed));

    const config = {
      version: '2.0',
      projects: [{ id: 'p1', name: 'P1', repos: [{ name: 'demo', path: '.' }] }],
      output: { dir: './output' },
      parserStorage: './parsers',
      agentMode: 'auto',
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('CREATE flow → writes workspaceId before push, lastSyncedAt after full success', async () => {
    const created = { id: 'ws_new', name: 'P1', slug: 'p1' };
    const result = await runSync(
      {
        configPath,
        projectId: 'p1',
        force: true,
        includeSummaries: false,
        includeEmbeddings: false,
        includeMapper: false,
        dryRun: false,
        verbose: false,
      },
      {
        workspaceApi: {
          createWorkspace: vi.fn(async () => created),
          getWorkspace: vi.fn(async () => ({ id: 'ws_new' })),
        },
        repoSyncApi: {
          getRepoState: vi.fn(async () => null),
          connectRepo: vi.fn(async () => ({ alreadyConnected: false })),
          uploadResult: vi.fn(async () => ({ version: 'v1', sizeBytes: 1, uploadedAt: 'now', duplicate: false })),
          uploadSummaries: vi.fn(async () => ({ version: 'sum_v1' })),
          pushByVersion: vi.fn(async () => ({})),
          uploadEmbeddings: vi.fn(async () => ({ version: 'emb_v1' })),
        },
        resolveWorkspace: vi.fn(async () => ({ resolved: 0, total: 0, rate: 0, legacyEdges: 0, mapperSha: null })),
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.workspaceId).toBe('ws_new');
    expect(result.pushedCount).toBe(1);

    const after = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(after.projects[0].cloud.workspaceId).toBe('ws_new');
    expect(after.projects[0].cloud.lastSyncedAt).toBeDefined();
  });

  it('ID conflict without --rebind → exit 2, no config writes', async () => {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.projects[0].cloud = { enabled: true, workspaceId: 'ws_stored' };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

    const result = await runSync(
      {
        configPath,
        projectId: 'p1',
        workspaceId: 'ws_other',
        rebind: false,
        force: false,
        includeSummaries: false,
        includeEmbeddings: false,
        includeMapper: false,
        dryRun: false,
        verbose: false,
      },
      {
        workspaceApi: { createWorkspace: vi.fn(), getWorkspace: vi.fn(async () => ({ id: 'ws_other' })) },
        repoSyncApi: {
          getRepoState: vi.fn(),
          connectRepo: vi.fn(),
          uploadResult: vi.fn(),
          uploadSummaries: vi.fn(),
          pushByVersion: vi.fn(),
          uploadEmbeddings: vi.fn(async () => ({ version: 'emb_v1' })),
        },
        resolveWorkspace: vi.fn(),
      },
    );
    expect(result.exitCode).toBe(2);
    const after = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(after.projects[0].cloud.workspaceId).toBe('ws_stored');
    expect(after.projects[0].cloud.lastSyncedAt).toBeUndefined();
  });

  it('partial failure → exit 1, lastSyncedAt NOT advanced', async () => {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.projects[0].repos.push({ name: 'missing', path: '.' });
    config.projects[0].cloud = { enabled: true, workspaceId: 'ws_a' };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

    const result = await runSync(
      {
        configPath,
        projectId: 'p1',
        force: true,
        includeSummaries: false,
        includeEmbeddings: false,
        includeMapper: false,
        dryRun: false,
        verbose: false,
      },
      {
        workspaceApi: { createWorkspace: vi.fn(), getWorkspace: vi.fn(async () => ({ id: 'ws_a' })) },
        repoSyncApi: {
          getRepoState: vi.fn(async () => null),
          connectRepo: vi.fn(async () => ({ alreadyConnected: false })),
          uploadResult: vi.fn(async () => ({ version: 'v1', sizeBytes: 1, uploadedAt: 'now', duplicate: false })),
          uploadSummaries: vi.fn(async () => ({ version: 'sum_v1' })),
          pushByVersion: vi.fn(async () => ({})),
          uploadEmbeddings: vi.fn(async () => ({ version: 'emb_v1' })),
        },
        resolveWorkspace: vi.fn(async () => ({ resolved: 0, total: 0, rate: 0, legacyEdges: 0, mapperSha: null })),
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.pushedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    const after = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(after.projects[0].cloud.lastSyncedAt).toBeUndefined();
  });

  it('--dry-run → no HTTP writes, no config writes', async () => {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.projects[0].cloud = { enabled: true, workspaceId: 'ws_a' };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    const before = readFileSync(configPath, 'utf-8');

    const upload = vi.fn();
    const push = vi.fn();
    const result = await runSync(
      {
        configPath,
        projectId: 'p1',
        force: true,
        includeSummaries: false,
        includeEmbeddings: false,
        includeMapper: false,
        dryRun: true,
        verbose: false,
      },
      {
        workspaceApi: { createWorkspace: vi.fn(), getWorkspace: vi.fn(async () => ({ id: 'ws_a' })) },
        repoSyncApi: {
          getRepoState: vi.fn(async () => null),
          connectRepo: vi.fn(),
          uploadResult: upload,
          uploadSummaries: vi.fn(),
          pushByVersion: push,
          uploadEmbeddings: vi.fn(async () => ({ version: 'emb_v1' })),
        },
        resolveWorkspace: vi.fn(),
      },
    );
    expect(result.exitCode).toBe(0);
    expect(upload).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('--dry-run with NO stored workspaceId → does NOT call createWorkspace', async () => {
    // Project starts with no cloud field at all — live run would create.
    const before = readFileSync(configPath, 'utf-8');

    const createWorkspace = vi.fn(async () => ({ id: 'ws_new', name: 'P1', slug: 'p1' }));
    const getWorkspace = vi.fn();
    const result = await runSync(
      {
        configPath,
        projectId: 'p1',
        force: true,
        includeSummaries: false,
        includeEmbeddings: false,
        includeMapper: false,
        dryRun: true,
        verbose: false,
      },
      {
        workspaceApi: { createWorkspace, getWorkspace },
        repoSyncApi: {
          getRepoState: vi.fn(),
          connectRepo: vi.fn(),
          uploadResult: vi.fn(),
          uploadSummaries: vi.fn(),
          pushByVersion: vi.fn(),
          uploadEmbeddings: vi.fn(async () => ({ version: 'emb_v1' })),
        },
        resolveWorkspace: vi.fn(),
      },
    );
    expect(result.exitCode).toBe(0);
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(getWorkspace).not.toHaveBeenCalled();
    // workspaceId placeholder indicates the would-create branch.
    expect(result.workspaceId).toContain('would-create');
    // Config untouched.
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('mapper present + ≥1 pushed → mapper pushed', async () => {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.projects[0].cloud = { enabled: true, workspaceId: 'ws_a' };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    writeFileSync(
      join(workDir, 'parsers', 'p1', 'mapper.json'),
      JSON.stringify({ version: 1, mappings: [], sdkMappings: [] }),
    );

    const mapperPush = vi.fn(async () => ({
      sha256: 'abc',
      r2Key: 'k',
      sizeBytes: 1,
      duplicate: false,
      resolution: { resolved: 0, total: 0, rate: 0, legacyEdges: 0 },
    }));
    const result = await runSync(
      {
        configPath,
        projectId: 'p1',
        force: true,
        includeSummaries: false,
        includeEmbeddings: false,
        includeMapper: true,
        dryRun: false,
        verbose: false,
      },
      {
        workspaceApi: { createWorkspace: vi.fn(), getWorkspace: vi.fn(async () => ({ id: 'ws_a' })) },
        repoSyncApi: {
          getRepoState: vi.fn(async () => null),
          connectRepo: vi.fn(async () => ({ alreadyConnected: false })),
          uploadResult: vi.fn(async () => ({ version: 'v1', sizeBytes: 1, uploadedAt: 'now', duplicate: false })),
          uploadSummaries: vi.fn(),
          pushByVersion: vi.fn(async () => ({})),
          uploadEmbeddings: vi.fn(async () => ({ version: 'emb_v1' })),
        },
        mapperPush,
        resolveWorkspace: vi.fn(async () => ({ resolved: 0, total: 0, rate: 0, legacyEdges: 0, mapperSha: null })),
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.mapperStatus).toBe('pushed');
    expect(mapperPush).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws_a' }));
  });

  it('mapper present + 0 pushed + no --force → mapper skipped', async () => {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.projects[0].cloud = { enabled: true, workspaceId: 'ws_a' };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    writeFileSync(
      join(workDir, 'parsers', 'p1', 'mapper.json'),
      JSON.stringify({ version: 1, mappings: [], sdkMappings: [] }),
    );
    const parsedJson = readFileSync(join(workDir, 'output', 'p1', 'demo.json'), 'utf-8');
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(parsedJson).digest('hex').slice(0, 16);

    const mapperPush = vi.fn();
    const result = await runSync(
      {
        configPath,
        projectId: 'p1',
        force: false,
        includeSummaries: false,
        includeEmbeddings: false,
        includeMapper: true,
        dryRun: false,
        verbose: false,
      },
      {
        workspaceApi: { createWorkspace: vi.fn(), getWorkspace: vi.fn(async () => ({ id: 'ws_a' })) },
        repoSyncApi: {
          getRepoState: vi.fn(async () => ({
            repoKey: 'repo:demo',
            repoName: 'demo',
            lastParseHash: hash,
            currentSummaryVersion: null,
            lastPushedAt: null,
            lastPushedByUserId: null,
            nodeCount: 0,
            edgeCount: 0,
            summaryUploadedAt: null,
          })),
          connectRepo: vi.fn(),
          uploadResult: vi.fn(),
          uploadSummaries: vi.fn(),
          pushByVersion: vi.fn(),
          uploadEmbeddings: vi.fn(async () => ({ version: 'emb_v1' })),
        },
        mapperPush,
        resolveWorkspace: vi.fn(),
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(mapperPush).not.toHaveBeenCalled();
    expect(result.mapperStatus).toBe('skipped');
  });

  it('falls back to per-repo pushes when the server does not advertise batch capability', async () => {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.projects[0].cloud = { enabled: true, workspaceId: 'ws_a' };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

    const pushByVersion = vi.fn(async () => ({}));
    const resolve = vi.fn(async () => ({ resolved: 1, total: 1, rate: 1, legacyEdges: 0, mapperSha: null }));

    await runSync(
      {
        configPath,
        projectId: 'p1',
        force: true,
        includeSummaries: false,
        includeEmbeddings: false,
        includeMapper: false,
        dryRun: false,
        verbose: false,
      },
      {
        workspaceApi: {
          createWorkspace: vi.fn(),
          // Old server: reports the backend but no capabilities — its resolve
          // would run targetless and publish none of the uploads.
          getWorkspace: vi.fn(async () => ({ id: 'ws_a', graphBackend: 'file_snapshot' })),
        },
        repoSyncApi: {
          getRepoState: vi.fn(async () => null),
          connectRepo: vi.fn(async () => ({ alreadyConnected: false })),
          uploadResult: vi.fn(async () => ({ version: 'v1', sizeBytes: 1, uploadedAt: 'now', duplicate: false })),
          uploadSummaries: vi.fn(),
          pushByVersion,
          uploadEmbeddings: vi.fn(async () => ({ version: 'emb_v1' })),
        },
        resolveWorkspace: resolve,
      },
    );

    expect(pushByVersion).toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith('ws_a', { targets: [] });
  });

  it('file-snapshot workspaces upload every repo then publish them in one resolve', async () => {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.projects[0].repos.push({ name: 'second', path: '.' });
    config.projects[0].cloud = { enabled: true, workspaceId: 'ws_a' };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    writeFileSync(
      join(workDir, 'output', 'p1', 'second.json'),
      JSON.stringify({
        id: 'repo:second',
        name: 'second',
        files: [],
        functions: [],
        classes: [],
        entrypoints: [],
        entities: [],
        externalCalls: [],
      }),
    );

    const pushByVersion = vi.fn(async () => ({}));
    const resolve = vi.fn(async () => ({ jobId: 'job_batch', status: 'queued' as const }));

    await runSync(
      {
        configPath,
        projectId: 'p1',
        force: true,
        includeSummaries: false,
        includeEmbeddings: false,
        includeMapper: false,
        dryRun: false,
        verbose: false,
      },
      {
        workspaceApi: {
          createWorkspace: vi.fn(),
          getWorkspace: vi.fn(async () => ({
            id: 'ws_a',
            graphBackend: 'file_snapshot',
            capabilities: { batchResolveTargets: true },
          })),
        },
        repoSyncApi: {
          getRepoState: vi.fn(async () => null),
          connectRepo: vi.fn(async () => ({ alreadyConnected: false })),
          uploadResult: vi.fn(async () => ({ version: 'v1', sizeBytes: 1, uploadedAt: 'now', duplicate: false })),
          uploadSummaries: vi.fn(),
          pushByVersion,
          uploadEmbeddings: vi.fn(async () => ({ version: 'emb_v1' })),
        },
        resolveWorkspace: resolve,
      },
    );

    // No per-repo push: the batch resolve is what publishes them.
    expect(pushByVersion).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('ws_a', {
      targets: [
        expect.objectContaining({ repoName: 'demo', parsedVersion: 'v1' }),
        expect.objectContaining({ repoName: 'second', parsedVersion: 'v1' }),
      ],
    });
  });

  it('deferred resolver: N pushes trigger ONE resolveWorkspace call at end, with defer=true per push', async () => {
    // Two repos that both need to push (mocked: no remote state -> first push).
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.projects[0].repos.push({ name: 'second', path: '.' });
    config.projects[0].cloud = { enabled: true, workspaceId: 'ws_a' };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    // Create the parsed JSON for the second repo so syncRepo finds it.
    const secondParsed = {
      id: 'repo:second',
      name: 'second',
      files: [],
      functions: [],
      classes: [],
      entrypoints: [],
      entities: [],
      externalCalls: [],
    };
    writeFileSync(join(workDir, 'output', 'p1', 'second.json'), JSON.stringify(secondParsed));

    const pushByVersion = vi.fn(async () => ({}));
    const resolve = vi.fn(async () => ({ resolved: 5, total: 10, rate: 0.5, legacyEdges: 1, mapperSha: null }));

    const result = await runSync(
      {
        configPath,
        projectId: 'p1',
        force: true,
        includeSummaries: false,
        includeEmbeddings: false,
        includeMapper: false,
        dryRun: false,
        verbose: false,
      },
      {
        workspaceApi: { createWorkspace: vi.fn(), getWorkspace: vi.fn(async () => ({ id: 'ws_a' })) },
        repoSyncApi: {
          getRepoState: vi.fn(async () => null),
          connectRepo: vi.fn(async () => ({ alreadyConnected: false })),
          uploadResult: vi.fn(async () => ({ version: 'v1', sizeBytes: 1, uploadedAt: 'now', duplicate: false })),
          uploadSummaries: vi.fn(),
          pushByVersion,
          uploadEmbeddings: vi.fn(async () => ({ version: 'emb_v1' })),
        },
        resolveWorkspace: resolve,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.pushedCount).toBe(2);
    expect(result.resolutionStatus).toBe('resolved');

    // Every per-repo push carried defer=true so the server skipped its inline resolver.
    expect(pushByVersion).toHaveBeenCalledTimes(2);
    for (const call of pushByVersion.mock.calls) {
      expect((call[0] as { defer?: boolean }).defer).toBe(true);
    }

    // Exactly one explicit resolve at the end of the batch, with the right workspaceId.
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('ws_a', { targets: [] });
  });

  it('async default fire-and-forget: queues jobs, exits 0, resolutionStatus=queued, lastSyncedAt NOT written without --wait', async () => {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.projects[0].cloud = { enabled: true, workspaceId: 'ws_a' };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

    const result = await runSync(
      {
        configPath,
        projectId: 'p1',
        force: true,
        includeSummaries: false,
        includeEmbeddings: false,
        includeMapper: false,
        dryRun: false,
        verbose: false,
      },
      {
        workspaceApi: { createWorkspace: vi.fn(), getWorkspace: vi.fn(async () => ({ id: 'ws_a' })) },
        repoSyncApi: {
          getRepoState: vi.fn(async () => null),
          connectRepo: vi.fn(async () => ({ alreadyConnected: false })),
          uploadResult: vi.fn(async () => ({ version: 'v1', sizeBytes: 1, uploadedAt: 'now', duplicate: false })),
          uploadSummaries: vi.fn(),
          pushByVersion: vi.fn(async () => ({ jobId: 'job_p1', status: 'queued' })),
          uploadEmbeddings: vi.fn(async () => ({ version: 'emb_v1' })),
        },
        resolveWorkspace: vi.fn(async () => ({ jobId: 'job_r', status: 'queued' })),
        getJob: vi.fn(),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.resolutionStatus).toBe('queued');
    // lastSyncedAt is intentionally NOT written for unconfirmed queued work.
    // Next sync recomputes via server-side lastParseHash, so leaving the
    // timestamp stale is correct (reflects last confirmed sync, not last attempt).
    const after = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(after.projects[0].cloud.lastSyncedAt).toBeUndefined();
  });

  it('async --wait: polls until terminal; exits 1 when any job failed; no lastSyncedAt', async () => {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.projects[0].cloud = { enabled: true, workspaceId: 'ws_a' };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

    const getJob = vi.fn(async (_w: string, jobId: string) => ({
      id: jobId,
      workspaceId: 'ws_a',
      repoName: jobId === 'job_p1' ? 'demo' : null,
      type: jobId === 'job_r' ? ('resolve' as const) : ('push' as const),
      status: jobId === 'job_p1' ? ('failed' as const) : ('succeeded' as const),
      attempts: 3,
      maxAttempts: 3,
      lastError: jobId === 'job_p1' ? 'oops' : null,
      queuedAt: 'x',
      startedAt: 'x',
      finishedAt: 'x',
      result: null,
    }));

    const result = await runSync(
      {
        configPath,
        projectId: 'p1',
        force: true,
        includeSummaries: false,
        includeEmbeddings: false,
        includeMapper: false,
        dryRun: false,
        verbose: false,
        wait: true,
      },
      {
        workspaceApi: { createWorkspace: vi.fn(), getWorkspace: vi.fn(async () => ({ id: 'ws_a' })) },
        repoSyncApi: {
          getRepoState: vi.fn(async () => null),
          connectRepo: vi.fn(async () => ({ alreadyConnected: false })),
          uploadResult: vi.fn(async () => ({ version: 'v1', sizeBytes: 1, uploadedAt: 'now', duplicate: false })),
          uploadSummaries: vi.fn(),
          pushByVersion: vi.fn(async () => ({ jobId: 'job_p1', status: 'queued' })),
          uploadEmbeddings: vi.fn(async () => ({ version: 'emb_v1' })),
        },
        resolveWorkspace: vi.fn(async () => ({ jobId: 'job_r', status: 'queued' })),
        getJob,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.waitJobFailures).toBe(1);
    const after = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(after.projects[0].cloud.lastSyncedAt).toBeUndefined();
  });

  it('async --wait with timeout: exits 1, marks waitTimedOut=true', async () => {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.projects[0].cloud = { enabled: true, workspaceId: 'ws_a' };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

    const getJob = vi.fn(async (_w: string, jobId: string) => ({
      id: jobId,
      workspaceId: 'ws_a',
      repoName: 'demo',
      type: 'push' as const,
      status: 'running' as const,
      attempts: 1,
      maxAttempts: 3,
      lastError: null,
      queuedAt: 'x',
      startedAt: 'x',
      finishedAt: null,
      result: null,
    }));

    const result = await runSync(
      {
        configPath,
        projectId: 'p1',
        force: true,
        includeSummaries: false,
        includeEmbeddings: false,
        includeMapper: false,
        dryRun: false,
        verbose: false,
        wait: true,
        waitTimeoutMs: 20,
        waitPollIntervalMs: 5,
      },
      {
        workspaceApi: { createWorkspace: vi.fn(), getWorkspace: vi.fn(async () => ({ id: 'ws_a' })) },
        repoSyncApi: {
          getRepoState: vi.fn(async () => null),
          connectRepo: vi.fn(async () => ({ alreadyConnected: false })),
          uploadResult: vi.fn(async () => ({ version: 'v1', sizeBytes: 1, uploadedAt: 'now', duplicate: false })),
          uploadSummaries: vi.fn(),
          pushByVersion: vi.fn(async () => ({ jobId: 'job_p1', status: 'queued' })),
          uploadEmbeddings: vi.fn(async () => ({ version: 'emb_v1' })),
        },
        resolveWorkspace: vi.fn(async () => ({ jobId: 'job_r', status: 'queued' })),
        getJob,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.waitTimedOut).toBe(true);
  });

  it('deferred resolver: 0 pushes (all skipped) → resolveWorkspace NOT called', async () => {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.projects[0].cloud = { enabled: true, workspaceId: 'ws_a' };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    const parsedJson = readFileSync(join(workDir, 'output', 'p1', 'demo.json'), 'utf-8');
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(parsedJson).digest('hex').slice(0, 16);

    const resolve = vi.fn();
    const result = await runSync(
      {
        configPath,
        projectId: 'p1',
        force: false,
        includeSummaries: false,
        includeEmbeddings: false,
        includeMapper: false,
        dryRun: false,
        verbose: false,
      },
      {
        workspaceApi: { createWorkspace: vi.fn(), getWorkspace: vi.fn(async () => ({ id: 'ws_a' })) },
        repoSyncApi: {
          getRepoState: vi.fn(async () => ({
            repoKey: 'repo:demo',
            repoName: 'demo',
            lastParseHash: hash,
            currentSummaryVersion: null,
            lastPushedAt: null,
            lastPushedByUserId: null,
            nodeCount: 0,
            edgeCount: 0,
            summaryUploadedAt: null,
          })),
          connectRepo: vi.fn(),
          uploadResult: vi.fn(),
          uploadSummaries: vi.fn(),
          pushByVersion: vi.fn(),
          uploadEmbeddings: vi.fn(async () => ({ version: 'emb_v1' })),
        },
        resolveWorkspace: resolve,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.pushedCount).toBe(0);
    expect(result.resolutionStatus).toBe('skipped');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('mapper push failure → exitCode 1 (was 0 before fix); lastSyncedAt not written', async () => {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.projects[0].cloud = { enabled: true, workspaceId: 'ws_a' };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    writeFileSync(
      join(workDir, 'parsers', 'p1', 'mapper.json'),
      JSON.stringify({ version: 1, mappings: [], sdkMappings: [] }),
    );

    const mapperPush = vi.fn(async () => {
      throw new Error('mapper schema invalid');
    });
    const result = await runSync(
      {
        configPath,
        projectId: 'p1',
        force: true,
        includeSummaries: false,
        includeEmbeddings: false,
        includeMapper: true,
        dryRun: false,
        verbose: false,
      },
      {
        workspaceApi: { createWorkspace: vi.fn(), getWorkspace: vi.fn(async () => ({ id: 'ws_a' })) },
        repoSyncApi: {
          getRepoState: vi.fn(async () => null),
          connectRepo: vi.fn(async () => ({ alreadyConnected: false })),
          uploadResult: vi.fn(async () => ({ version: 'v1', sizeBytes: 1, uploadedAt: 'now', duplicate: false })),
          uploadSummaries: vi.fn(),
          pushByVersion: vi.fn(async () => ({})),
          uploadEmbeddings: vi.fn(async () => ({ version: 'emb_v1' })),
        },
        resolveWorkspace: vi.fn(async () => ({ resolved: 0, total: 0, rate: 0, legacyEdges: 0, mapperSha: null })),
        mapperPush,
      },
    );
    expect(result.mapperStatus).toBe('failed');
    expect(result.exitCode).toBe(1);
    const after = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(after.projects[0].cloud.lastSyncedAt).toBeUndefined();
  });

  it('resolve HTTP failure → exitCode 1; lastSyncedAt not written', async () => {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.projects[0].cloud = { enabled: true, workspaceId: 'ws_a' };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

    const result = await runSync(
      {
        configPath,
        projectId: 'p1',
        force: true,
        includeSummaries: false,
        includeEmbeddings: false,
        includeMapper: false,
        dryRun: false,
        verbose: false,
      },
      {
        workspaceApi: { createWorkspace: vi.fn(), getWorkspace: vi.fn(async () => ({ id: 'ws_a' })) },
        repoSyncApi: {
          getRepoState: vi.fn(async () => null),
          connectRepo: vi.fn(async () => ({ alreadyConnected: false })),
          uploadResult: vi.fn(async () => ({ version: 'v1', sizeBytes: 1, uploadedAt: 'now', duplicate: false })),
          uploadSummaries: vi.fn(),
          pushByVersion: vi.fn(async () => ({ jobId: 'job_p1', status: 'queued' })),
          uploadEmbeddings: vi.fn(async () => ({ version: 'emb_v1' })),
        },
        resolveWorkspace: vi.fn(async () => {
          throw new Error('resolve enqueue failed');
        }),
        getJob: vi.fn(),
      },
    );
    expect(result.resolutionStatus).toBe('failed');
    expect(result.exitCode).toBe(1);
    const after = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(after.projects[0].cloud.lastSyncedAt).toBeUndefined();
  });

  it('resolve 504 job_still_running → queued (not failed), exit 0, lastSyncedAt not advanced', async () => {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.projects[0].cloud = { enabled: true, workspaceId: 'ws_a' };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

    const result = await runSync(
      {
        configPath,
        projectId: 'p1',
        force: true,
        includeSummaries: false,
        includeEmbeddings: false,
        includeMapper: false,
        dryRun: false,
        verbose: false,
      },
      {
        workspaceApi: { createWorkspace: vi.fn(), getWorkspace: vi.fn(async () => ({ id: 'ws_a' })) },
        repoSyncApi: {
          getRepoState: vi.fn(async () => null),
          connectRepo: vi.fn(async () => ({ alreadyConnected: false })),
          uploadResult: vi.fn(async () => ({ version: 'v1', sizeBytes: 1, uploadedAt: 'now', duplicate: false })),
          uploadSummaries: vi.fn(),
          pushByVersion: vi.fn(async () => ({ jobId: 'job_p1', status: 'queued' })),
          uploadEmbeddings: vi.fn(async () => ({ version: 'emb_v1' })),
        },
        resolveWorkspace: vi.fn(async () => {
          // Shape produced by workspace-api.resolveWorkspace on the server's 504.
          throw new Error(
            'resolveWorkspace failed (504): {"code":"job_still_running","jobId":"job_r","message":"Job is still running"}',
          );
        }),
        getJob: vi.fn(),
      },
    );
    expect(result.resolutionStatus).toBe('queued');
    expect(result.exitCode).toBe(0);
    const after = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(after.projects[0].cloud.lastSyncedAt).toBeUndefined();
  });

  it('mapper publishing in background → not a failure, exit 0, lastSyncedAt not advanced', async () => {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.projects[0].cloud = { enabled: true, workspaceId: 'ws_a' };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    writeFileSync(
      join(workDir, 'parsers', 'p1', 'mapper.json'),
      JSON.stringify({ version: 1, mappings: [], sdkMappings: [] }),
    );

    const result = await runSync(
      {
        configPath,
        projectId: 'p1',
        force: true,
        includeSummaries: false,
        includeEmbeddings: false,
        includeMapper: true,
        dryRun: false,
        verbose: false,
      },
      {
        workspaceApi: { createWorkspace: vi.fn(), getWorkspace: vi.fn(async () => ({ id: 'ws_a' })) },
        repoSyncApi: {
          getRepoState: vi.fn(async () => null),
          connectRepo: vi.fn(async () => ({ alreadyConnected: false })),
          uploadResult: vi.fn(async () => ({ version: 'v1', sizeBytes: 1, uploadedAt: 'now', duplicate: false })),
          uploadSummaries: vi.fn(),
          pushByVersion: vi.fn(async () => ({})),
          uploadEmbeddings: vi.fn(async () => ({ version: 'emb_v1' })),
        },
        // Structured 504 job_still_running on a file_snapshot workspace: the
        // mapper landed, the publish job keeps running.
        mapperPush: vi.fn(async () => ({ status: 'publishing' as const, jobId: 'job_m' })),
        resolveWorkspace: vi.fn(async () => ({ resolved: 0, total: 0, rate: 0, legacyEdges: 0, mapperSha: null })),
      },
    );
    expect(result.mapperStatus).toBe('publishing');
    expect(result.exitCode).toBe(0);
    const after = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(after.projects[0].cloud.lastSyncedAt).toBeUndefined();
  });

  it('never runs the workspace-layout migration (sync is read-only on disk)', async () => {
    // Pre-sentinel flat layout the migration would move to parsers/p1/demo.
    mkdirSync(join(workDir, 'parsers', 'demo'), { recursive: true });

    const result = await runSync(
      {
        configPath,
        projectId: 'p1',
        force: false,
        includeSummaries: false,
        includeEmbeddings: false,
        includeMapper: false,
        dryRun: true,
        verbose: false,
      },
      { workspaceApi: { createWorkspace: vi.fn(), getWorkspace: vi.fn(async () => ({ id: 'ws_a' })) } },
    );

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(workDir, 'parsers', '.layout-version'))).toBe(false);
    expect(existsSync(join(workDir, 'parsers', 'demo'))).toBe(true);
    expect(existsSync(join(workDir, 'parsers', 'p1', 'demo'))).toBe(false);
  });
});
