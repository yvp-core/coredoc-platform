import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StableIdGenerator } from '@coredoc/core';
import { buildRepoUpsertBodies, syncRepo } from './repo-sync.js';
import type { RuntimeConfig } from '@coredoc/core/types';

vi.mock('../auth.js', () => ({
  getToken: vi.fn(async () => 'cdt_test'),
  getServerUrl: vi.fn(async () => 'https://api.test'),
}));

const minimalParsedRepo = (overrides: Record<string, unknown> = {}) => ({
  id: 'repo:demo',
  name: 'demo',
  files: [],
  functions: [],
  classes: [],
  entrypoints: [],
  entities: [],
  externalCalls: [],
  ...overrides,
});

const hash16 = (json: unknown) => createHash('sha256').update(JSON.stringify(json)).digest('hex').slice(0, 16);

describe('syncRepo', () => {
  let workDir: string;
  let outputDir: string;
  let parserStorage: string;
  let configPath: string;
  let runtimeConfig: RuntimeConfig;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'sync-repo-'));
    outputDir = join(workDir, 'output');
    parserStorage = join(workDir, 'parsers');
    configPath = join(workDir, 'coredoc.config.json');
    mkdirSync(join(outputDir, 'p1'), { recursive: true });
    runtimeConfig = {
      version: '2.0',
      projects: [{ id: 'p1', name: 'P1', repos: [{ name: 'demo', path: '.' }] }],
      output: { dir: './output' },
      parserStorage: './parsers',
      agentMode: 'auto',
      configPath,
      configDir: workDir,
      resolvedOutputDir: outputDir,
      resolvedParserStorage: parserStorage,
      resolvedRepoPaths: new Map([['p1::demo', workDir]]),
    } as unknown as RuntimeConfig;
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns "failed" with step=load when parsed JSON is missing', async () => {
    const api = mockApi();
    const result = await syncRepo({
      projectId: 'p1',
      repo: { name: 'demo', path: '.' },
      workspaceId: 'ws_x',
      config: runtimeConfig,
      force: false,
      includeSummaries: true,
      includeEmbeddings: true,
      api,
    });
    expect(result).toMatchObject({ status: 'failed', step: 'load' });
    expect(api.connectRepo).not.toHaveBeenCalled();
  });

  it('skips push when parse hash and summary version match (no summaries case)', async () => {
    const parsed = minimalParsedRepo();
    writeFileSync(join(outputDir, 'p1', 'demo.json'), JSON.stringify(parsed));
    const api = mockApi({
      getRepoState: vi.fn(async () => ({
        repoKey: 'repo:demo',
        repoName: 'demo',
        lastParseHash: hash16(parsed),
        currentSummaryVersion: null,
        lastPushedAt: null,
        lastPushedByUserId: null,
        nodeCount: 0,
        edgeCount: 0,
        summaryUploadedAt: null,
      })),
    });
    const result = await syncRepo({
      projectId: 'p1',
      repo: { name: 'demo', path: '.' },
      workspaceId: 'ws_x',
      config: runtimeConfig,
      force: false,
      includeSummaries: false,
      includeEmbeddings: false,
      api,
    });
    expect(result.status).toBe('skipped');
    expect(api.connectRepo).not.toHaveBeenCalled();
    expect(api.uploadResult).not.toHaveBeenCalled();
  });

  it('keeps ordinary no-op and delta comparison on the 16-hex route-version convention', async () => {
    const parsed = minimalParsedRepo();
    writeFileSync(join(outputDir, 'p1', 'demo.json'), JSON.stringify(parsed));
    const routeVersion = hash16(parsed);
    expect(routeVersion).toMatch(/^[0-9a-f]{16}$/);
    const repoState = {
      repoKey: 'repo:demo',
      repoName: 'demo',
      lastParseHash: routeVersion,
      currentSummaryVersion: null,
      lastPushedAt: null,
      lastPushedByUserId: null,
      nodeCount: 0,
      edgeCount: 0,
      summaryUploadedAt: null,
    };
    const getRepoState = vi.fn(async () => repoState);
    const api = mockApi({ getRepoState });
    const request = {
      projectId: 'p1',
      repo: { name: 'demo', path: '.' },
      workspaceId: 'ws_x',
      config: runtimeConfig,
      force: false,
      includeSummaries: false,
      includeEmbeddings: false,
      api,
    } as const;

    await expect(syncRepo(request)).resolves.toMatchObject({ status: 'skipped' });

    getRepoState.mockResolvedValueOnce({
      ...repoState,
      lastParseHash: '0'.repeat(16),
    });
    await expect(syncRepo(request)).resolves.toMatchObject({ status: 'pushed' });
    expect(api.uploadResult).toHaveBeenCalledOnce();
  });

  it('pushes when parse hash differs (incremental path, no embeddings)', async () => {
    const parsed = minimalParsedRepo();
    writeFileSync(join(outputDir, 'p1', 'demo.json'), JSON.stringify(parsed));
    const api = mockApi({
      getRepoState: vi.fn(async () => ({
        repoKey: 'repo:demo',
        repoName: 'demo',
        lastParseHash: 'stale_hash_x',
        currentSummaryVersion: null,
        lastPushedAt: null,
        lastPushedByUserId: null,
        nodeCount: 0,
        edgeCount: 0,
        summaryUploadedAt: null,
      })),
    });
    const result = await syncRepo({
      projectId: 'p1',
      repo: { name: 'demo', path: '.' },
      workspaceId: 'ws_x',
      config: runtimeConfig,
      force: false,
      includeSummaries: false,
      includeEmbeddings: false,
      api,
    });
    expect(result.status).toBe('pushed');
    expect(api.connectRepo).toHaveBeenCalled();
    expect(api.uploadResult).toHaveBeenCalled();
    expect(api.pushByVersion).toHaveBeenCalled();
  });

  it('pushes with embeddings: uploads embeddings then pushByVersion with embeddingsVersion', async () => {
    const parsed = minimalParsedRepo();
    writeFileSync(join(outputDir, 'p1', 'demo.json'), JSON.stringify(parsed));
    writeFileSync(join(outputDir, 'p1', 'demo-embeddings.json'), JSON.stringify({ functions: [], endpoints: [] }));
    const api = mockApi();
    const result = await syncRepo({
      projectId: 'p1',
      repo: { name: 'demo', path: '.' },
      workspaceId: 'ws_x',
      config: runtimeConfig,
      force: true,
      includeSummaries: false,
      includeEmbeddings: true,
      api,
    });
    expect(result.status).toBe('pushed');
    expect(api.uploadResult).toHaveBeenCalled();
    expect(api.uploadEmbeddings).toHaveBeenCalled();
    expect(api.pushByVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        embeddingsVersion: 'emb_v1',
      }),
    );
  });

  it('pushes when a summary upload exists but that version was not published', async () => {
    const parsed = minimalParsedRepo();
    const summaries = { summaries: [{ id: 'function:1', summary: 'new summary' }] };
    writeFileSync(join(outputDir, 'p1', 'demo.json'), JSON.stringify(parsed));
    writeFileSync(join(outputDir, 'p1', 'demo-summaries.json'), JSON.stringify(summaries));
    const api = mockApi({
      getRepoState: vi.fn(async () => ({
        repoKey: 'repo:demo',
        repoName: 'demo',
        lastParseHash: hash16(parsed),
        currentSummaryVersion: 'sum_previous_publish',
        currentEmbeddingsVersion: null,
        lastPushedAt: null,
        lastPushedByUserId: null,
        nodeCount: 0,
        edgeCount: 0,
        summaryUploadedAt: null,
      })),
    });

    const result = await syncRepo({
      projectId: 'p1',
      repo: { name: 'demo', path: '.' },
      workspaceId: 'ws_x',
      config: runtimeConfig,
      force: false,
      includeSummaries: true,
      includeEmbeddings: false,
      api,
    });

    expect(result.status).toBe('pushed');
    expect(api.uploadSummaries).toHaveBeenCalledOnce();
    expect(api.pushByVersion).toHaveBeenCalledOnce();
  });

  it('pushes when only the published embeddings version is stale', async () => {
    const parsed = minimalParsedRepo();
    const embeddings = { functions: [], endpoints: [{ id: 'endpoint:1', embedding: [0.5] }] };
    writeFileSync(join(outputDir, 'p1', 'demo.json'), JSON.stringify(parsed));
    writeFileSync(join(outputDir, 'p1', 'demo-embeddings.json'), JSON.stringify(embeddings));
    const api = mockApi({
      getRepoState: vi.fn(async () => ({
        repoKey: 'repo:demo',
        repoName: 'demo',
        lastParseHash: hash16(parsed),
        currentSummaryVersion: null,
        currentEmbeddingsVersion: 'emb_stale',
        lastPushedAt: null,
        lastPushedByUserId: null,
        nodeCount: 0,
        edgeCount: 0,
        summaryUploadedAt: null,
      })),
    });

    const result = await syncRepo({
      projectId: 'p1',
      repo: { name: 'demo', path: '.' },
      workspaceId: 'ws_x',
      config: runtimeConfig,
      force: false,
      includeSummaries: false,
      includeEmbeddings: true,
      api,
    });

    expect(result.status).toBe('pushed');
    expect(api.uploadEmbeddings).toHaveBeenCalledOnce();
    expect(api.pushByVersion).toHaveBeenCalledOnce();
  });

  it('--force skips the delta check', async () => {
    const parsed = minimalParsedRepo();
    writeFileSync(join(outputDir, 'p1', 'demo.json'), JSON.stringify(parsed));
    const api = mockApi({
      getRepoState: vi.fn(async () => ({
        repoKey: 'repo:demo',
        repoName: 'demo',
        lastParseHash: hash16(parsed),
        currentSummaryVersion: null,
        lastPushedAt: null,
        lastPushedByUserId: null,
        nodeCount: 0,
        edgeCount: 0,
        summaryUploadedAt: null,
      })),
    });
    const result = await syncRepo({
      projectId: 'p1',
      repo: { name: 'demo', path: '.' },
      workspaceId: 'ws_x',
      config: runtimeConfig,
      force: true,
      includeSummaries: false,
      includeEmbeddings: false,
      api,
    });
    expect(result.status).toBe('pushed');
    expect(api.getRepoState).not.toHaveBeenCalled();
  });

  it('treats connectRepo "already connected" as success and proceeds', async () => {
    const parsed = minimalParsedRepo();
    writeFileSync(join(outputDir, 'p1', 'demo.json'), JSON.stringify(parsed));
    const api = mockApi({
      connectRepo: vi.fn(async () => ({ alreadyConnected: true })),
    });
    const result = await syncRepo({
      projectId: 'p1',
      repo: { name: 'demo', path: '.' },
      workspaceId: 'ws_x',
      config: runtimeConfig,
      force: true,
      includeSummaries: false,
      includeEmbeddings: false,
      api,
    });
    expect(result.status).toBe('pushed');
    expect(api.pushByVersion).toHaveBeenCalled();
  });

  it('alreadyConnected=true → calls PATCH updateRepo with httpPrefix and repoType', async () => {
    const parsed = minimalParsedRepo();
    writeFileSync(join(outputDir, 'p1', 'demo.json'), JSON.stringify(parsed));
    const api = mockApi({
      connectRepo: vi.fn(async () => ({ alreadyConnected: true })),
    });
    await syncRepo({
      projectId: 'p1',
      repo: { name: 'demo', path: '.', type: 'backend', httpPrefix: '/v1/api' },
      workspaceId: 'ws_x',
      config: runtimeConfig,
      force: true,
      includeSummaries: false,
      includeEmbeddings: false,
      api,
    });
    expect(api.updateRepo).toHaveBeenCalledWith('ws_x', 'repo:demo', {
      repoType: 'backend',
      httpPrefix: '/v1/api',
    });
  });

  it('forwards the parsed artifact’s origin remote as gitUrl on connect and PATCH', async () => {
    const parsed = minimalParsedRepo({
      git: {
        commitHash: 'abc',
        commitShortHash: 'abc',
        branch: 'main',
        isDirty: false,
        remoteUrl: 'git@github.com:acme/demo.git',
      },
    });
    writeFileSync(join(outputDir, 'p1', 'demo.json'), JSON.stringify(parsed));
    const api = mockApi({ connectRepo: vi.fn(async () => ({ alreadyConnected: true })) });
    await syncRepo({
      projectId: 'p1',
      repo: { name: 'demo', path: '.' },
      workspaceId: 'ws_x',
      config: runtimeConfig,
      force: true,
      includeSummaries: false,
      includeEmbeddings: false,
      api,
    });
    expect(api.connectRepo).toHaveBeenCalledWith(
      'ws_x',
      expect.objectContaining({ gitUrl: 'git@github.com:acme/demo.git' }),
    );
    expect(api.updateRepo).toHaveBeenCalledWith(
      'ws_x',
      'repo:demo',
      expect.objectContaining({ gitUrl: 'git@github.com:acme/demo.git' }),
    );
  });

  it('alreadyConnected=true but no mutable fields → does NOT call updateRepo (empty patch is wasteful)', async () => {
    const parsed = minimalParsedRepo();
    writeFileSync(join(outputDir, 'p1', 'demo.json'), JSON.stringify(parsed));
    const api = mockApi({
      connectRepo: vi.fn(async () => ({ alreadyConnected: true })),
    });
    await syncRepo({
      projectId: 'p1',
      // No type, no httpPrefix on the local repo config — nothing to patch.
      repo: { name: 'demo', path: '.' },
      workspaceId: 'ws_x',
      config: runtimeConfig,
      force: true,
      includeSummaries: false,
      includeEmbeddings: false,
      api,
    });
    expect(api.updateRepo).not.toHaveBeenCalled();
  });

  it('first-connect (alreadyConnected=false) → does NOT call updateRepo (POST already set the fields)', async () => {
    const parsed = minimalParsedRepo();
    writeFileSync(join(outputDir, 'p1', 'demo.json'), JSON.stringify(parsed));
    const api = mockApi(); // default connectRepo returns { alreadyConnected: false }
    await syncRepo({
      projectId: 'p1',
      repo: { name: 'demo', path: '.', type: 'backend', httpPrefix: '/v1/api' },
      workspaceId: 'ws_x',
      config: runtimeConfig,
      force: true,
      includeSummaries: false,
      includeEmbeddings: false,
      api,
    });
    expect(api.updateRepo).not.toHaveBeenCalled();
  });

  it('captures jobId from async push response', async () => {
    const parsed = minimalParsedRepo();
    writeFileSync(join(outputDir, 'p1', 'demo.json'), JSON.stringify(parsed));
    const api = mockApi({
      pushByVersion: vi.fn(async () => ({ jobId: 'job_xyz', status: 'queued' })),
    });
    const result = await syncRepo({
      projectId: 'p1',
      repo: { name: 'demo', path: '.' },
      workspaceId: 'ws_x',
      config: runtimeConfig,
      force: true,
      includeSummaries: false,
      includeEmbeddings: false,
      api,
    });
    expect(result.status).toBe('pushed');
    if (result.status === 'pushed') {
      expect(result.jobId).toBe('job_xyz');
    }
  });
});

/**
 * The durable intent identity on the wire. Nothing sent it before this: the
 * server accepted `intentRepoKey` on both routes and every client omitted it,
 * so a repo with an explicit `repos[].key` could never be bound and every
 * intent anchor against it failed `unknown_repo_key`.
 */
describe('buildRepoUpsertBodies', () => {
  const repoHash = (key: string) => new StableIdGenerator('', key).getRepoHash();

  it('sends the durable key on BOTH the connect and the PATCH body', () => {
    const repo = { name: 'orders-api', path: '.', key: 'github.com/acme/orders-api' };
    const bodies = buildRepoUpsertBodies(repo, repoHash(repo.key));
    expect(bodies.connect).toMatchObject({ intentRepoKey: 'github.com/acme/orders-api', repoName: 'orders-api' });
    // The PATCH carries it too — that is the ONLY remedy for a repo an older
    // client connected and left with a null identity.
    expect(bodies.patch).toMatchObject({ intentRepoKey: 'github.com/acme/orders-api' });
  });

  it('falls back to the repo name when no explicit key is configured', () => {
    const bodies = buildRepoUpsertBodies({ name: 'demo', path: '.' }, repoHash('demo'));
    expect(bodies.connect.intentRepoKey).toBe('demo');
    expect(bodies.patch.intentRepoKey).toBe('demo');
  });

  it('omits the identity, loudly, when the key does not reproduce the parsed repo id', () => {
    // A stale parsed artifact: `repos[].key` changed after the last parse.
    // Sending the key anyway would make every push a 400.
    const lines: string[] = [];
    const bodies = buildRepoUpsertBodies({ name: 'demo', path: '.', key: 'new-key' }, repoHash('old-key'), (line) =>
      lines.push(line),
    );
    expect(bodies.connect.intentRepoKey).toBeUndefined();
    expect(bodies.patch.intentRepoKey).toBeUndefined();
    expect(lines.join('\n')).toContain('does not reproduce');
  });

  // The delivery importer links a PR to a repo only through `WorkspaceRepo.gitUrl`.
  // Without it on the wire a connected repo never receives its pull requests.
  it('sends the captured remote as gitUrl on BOTH bodies', () => {
    const bodies = buildRepoUpsertBodies(
      { name: 'demo', path: '.' },
      repoHash('demo'),
      () => {},
      'https://github.com/acme/demo.git',
    );
    expect(bodies.connect.gitUrl).toBe('https://github.com/acme/demo.git');
    expect(bodies.patch.gitUrl).toBe('https://github.com/acme/demo.git');
  });

  it('passes an ssh remote through untouched (the server parses both forms)', () => {
    const bodies = buildRepoUpsertBodies(
      { name: 'demo', path: '.' },
      repoHash('demo'),
      () => {},
      '  git@github.com:acme/demo.git\n',
    );
    expect(bodies.connect.gitUrl).toBe('git@github.com:acme/demo.git');
    expect(bodies.patch.gitUrl).toBe('git@github.com:acme/demo.git');
  });

  it('omits gitUrl when no remote is known, so a PATCH never clears the stored one', () => {
    const bodies = buildRepoUpsertBodies({ name: 'demo', path: '.' }, repoHash('demo'));
    expect(bodies.connect).not.toHaveProperty('gitUrl');
    expect(bodies.patch).not.toHaveProperty('gitUrl');
  });

  it('keeps the httpPrefix tri-state it already had', () => {
    expect(buildRepoUpsertBodies({ name: 'demo', path: '.' }, repoHash('demo')).connect).not.toHaveProperty(
      'httpPrefix',
    );
    expect(
      buildRepoUpsertBodies({ name: 'demo', path: '.', httpPrefix: null }, repoHash('demo')).patch.httpPrefix,
    ).toBeNull();
  });
});

function mockApi(over: Partial<Parameters<typeof syncRepo>[0]['api']> = {}) {
  return {
    getRepoState: vi.fn(async () => null),
    connectRepo: vi.fn(async () => ({ alreadyConnected: false })),
    updateRepo: vi.fn(async () => {}),
    uploadResult: vi.fn(async () => ({
      version: 'v1',
      sizeBytes: 100,
      uploadedAt: '2026-05-23T00:00:00Z',
      duplicate: false,
    })),
    uploadSummaries: vi.fn(async () => ({ version: 'sum_v1' })),
    uploadEmbeddings: vi.fn(async () => ({ version: 'emb_v1' })),
    pushByVersion: vi.fn(async () => ({ ok: true })),
    ...over,
  } as NonNullable<Parameters<typeof syncRepo>[0]['api']>;
}
