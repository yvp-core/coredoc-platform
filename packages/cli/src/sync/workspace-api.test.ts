import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkspace,
  getWorkspace,
  connectRepo,
  getRepoState,
  SlugTakenError,
  WorkspaceForbiddenError,
  WorkspaceNotFoundError,
} from './workspace-api.js';

vi.mock('../auth.js', () => ({
  getToken: vi.fn(async () => 'cdt_test'),
  getServerUrl: vi.fn(async () => 'https://api.test'),
  authHeaders: vi.fn(async () => ({ Authorization: 'Bearer cdt_test' })),
}));

describe('workspace-api', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('createWorkspace returns parsed body on 201', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'ws_new', name: 'p', slug: 'p' }), { status: 201 }),
      ) as typeof globalThis.fetch;
    const res = await createWorkspace({ name: 'p', slug: 'p' });
    expect(res.id).toBe('ws_new');
  });

  it('createWorkspace maps 409 to SlugTakenError', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('slug taken', { status: 409 })) as typeof globalThis.fetch;
    await expect(createWorkspace({ name: 'p', slug: 'taken' })).rejects.toBeInstanceOf(SlugTakenError);
  });

  it('getWorkspace maps 403 to WorkspaceForbiddenError', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 })) as typeof globalThis.fetch;
    await expect(getWorkspace('ws_x')).rejects.toBeInstanceOf(WorkspaceForbiddenError);
  });

  it('getWorkspace maps 404 to WorkspaceNotFoundError', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('not found', { status: 404 })) as typeof globalThis.fetch;
    await expect(getWorkspace('ws_x')).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });

  it('connectRepo treats 409 as success (already-connected)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('already connected', { status: 409 })) as typeof globalThis.fetch;
    const res = await connectRepo('ws_x', { repoKey: 'k', repoName: 'n' });
    expect(res.alreadyConnected).toBe(true);
  });

  it('connectRepo passes httpPrefix and repoType through', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'r1' }), { status: 201 }));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    await connectRepo('ws_x', { repoKey: 'k', repoName: 'n', repoType: 'backend', httpPrefix: '/v1' });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ repoKey: 'k', repoName: 'n', repoType: 'backend', httpPrefix: '/v1' });
  });

  it('getRepoState returns null on 404 (first push)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('not found', { status: 404 })) as typeof globalThis.fetch;
    const res = await getRepoState('ws_x', 'r');
    expect(res).toBeNull();
  });

  it('getRepoState returns parsed body on 200', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ repoKey: 'k', repoName: 'n', lastParseHash: 'abc', currentSummaryVersion: null }), {
        status: 200,
      }),
    ) as typeof globalThis.fetch;
    const res = await getRepoState('ws_x', 'r');
    expect(res?.lastParseHash).toBe('abc');
  });

  it('getJob returns null on 404 (job not found in workspace)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('nope', { status: 404 })) as typeof globalThis.fetch;
    const { getJob } = await import('./workspace-api.js');
    expect(await getJob('ws_1', 'missing')).toBeNull();
  });

  it('getJob returns the parsed body on 200', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'job_1', status: 'succeeded', type: 'push', attempts: 1 }), { status: 200 }),
      ) as typeof globalThis.fetch;
    const { getJob } = await import('./workspace-api.js');
    const job = await getJob('ws_1', 'job_1');
    expect(job?.status).toBe('succeeded');
  });

  it('resolveWorkspace with sync=true appends ?sync=true', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ resolved: 0, total: 0, rate: 0, legacyEdges: 0, mapperSha: null }), {
        status: 200,
      }),
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    const { resolveWorkspace } = await import('./workspace-api.js');
    await resolveWorkspace('ws_1', { sync: true });
    expect((fetchMock.mock.calls[0][0] as string).endsWith('?sync=true')).toBe(true);
  });

  it('resolveWorkspace default omits the sync param', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ jobId: 'job_r', status: 'queued' }), { status: 202 }));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    const { resolveWorkspace } = await import('./workspace-api.js');
    const result = await resolveWorkspace('ws_1');
    expect(fetchMock.mock.calls[0][0] as string).not.toContain('sync=');
    expect(result).toMatchObject({ jobId: 'job_r', status: 'queued' });
  });
});
