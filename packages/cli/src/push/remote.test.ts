/**
 * The remote push client's request shape.
 *
 * Covers the option→query-parameter mapping. `--rebuild` is the explicit path
 * for a parse the server's diff engine refuses to apply on its own (a repo
 * legitimately emptied of code is indistinguishable from a degraded parse), so
 * a dropped flag turns a requested replacement into a rejected push.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getToken = vi.hoisted(() => vi.fn(async () => 'cdt_test'));
const getServerUrl = vi.hoisted(() => vi.fn(async () => 'https://api.test'));
vi.mock('../auth.js', () => ({
  getToken,
  getServerUrl,
  authHeaders: async () => ({ Authorization: `Bearer ${await getToken()}` }),
}));

/** URLs the client requested, in order. */
let requested: string[];
let requestBodies: Record<string, unknown>[];

beforeEach(() => {
  // Capture THIS test's arrays by value. The stub used to push through the module-scope
  // bindings, so a call still in flight when a test timed out landed in the NEXT test's
  // arrays and corrupted its `requested[0]` assertion. Closing over the locals means a late
  // call writes into its own dead array instead.
  const urls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  requested = urls;
  requestBodies = bodies;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(url);
      if (typeof init?.body === 'string') {
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{}' } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pushByVersion query parameters', () => {
  const base = { workspaceId: 'ws_1', repoName: 'api', parsedVersion: 'v1' };

  it('asks for a rebuild when the caller requested one', async () => {
    const { pushByVersion } = await import('./remote.js');

    await pushByVersion({ ...base, rebuild: true });

    expect(requested[0]).toContain('rebuild=true');
  });

  it('does not ask for a rebuild by default', async () => {
    const { pushByVersion } = await import('./remote.js');

    await pushByVersion(base);

    expect(requested[0]).not.toContain('rebuild');
  });

  it('carries rebuild alongside the other flags', async () => {
    const { pushByVersion } = await import('./remote.js');

    await pushByVersion({ ...base, rebuild: true, defer: true });

    expect(requested[0]).toContain('defer=true');
    expect(requested[0]).toContain('rebuild=true');
  });

  it('serializes explicit metadata exclusions in the request body', async () => {
    const { pushByVersion } = await import('./remote.js');

    await pushByVersion({ ...base, excludeSummaries: true, excludeEmbeddings: true });

    expect(requestBodies[0]).toMatchObject({
      parsedVersion: 'v1',
      excludeSummaries: true,
      excludeEmbeddings: true,
    });
  });

  it('omits metadata exclusions by default so existing metadata is preserved', async () => {
    const { pushByVersion } = await import('./remote.js');

    await pushByVersion(base);

    expect(requestBodies[0]).toEqual({ parsedVersion: 'v1' });
  });
});

describe('waitForPushJob', () => {
  /** Queue one job-status body per poll; the last one repeats. */
  function stubJobPolls(bodies: Record<string, unknown>[]): { calls: () => number } {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requested.push(url);
        const body = bodies[Math.min(call, bodies.length - 1)];
        call += 1;
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as never;
      }),
    );
    return { calls: () => call };
  }

  const running = { id: 'job_1', status: 'running', lastError: null, result: null };

  it('polls the job endpoint until the job succeeds and returns the terminal job', async () => {
    const { waitForPushJob } = await import('./remote.js');
    stubJobPolls([
      { id: 'job_1', status: 'pending', lastError: null, result: null },
      running,
      { id: 'job_1', status: 'succeeded', lastError: null, result: { nodes: 3 } },
    ]);

    const job = await waitForPushJob('ws_1', 'job_1', { timeoutMs: 5000, intervalMs: 1 });

    expect(job.status).toBe('succeeded');
    expect(job.result).toEqual({ nodes: 3 });
    expect(requested[0]).toBe('https://api.test/api/v1/workspaces/ws_1/jobs/job_1');
  });

  it('throws with the job error information when the job fails', async () => {
    const { waitForPushJob } = await import('./remote.js');
    stubJobPolls([
      running,
      {
        id: 'job_1',
        status: 'failed',
        lastError: 'changeset apply rejected',
        result: { error: { code: 'graph_write_failed', jobId: 'job_1', message: 'apply failed', statusCode: 503 } },
      },
    ]);

    await expect(waitForPushJob('ws_1', 'job_1', { timeoutMs: 5000, intervalMs: 1 })).rejects.toThrow(
      /changeset apply rejected|graph_write_failed/,
    );
  });

  it('on timeout reports the jobId and that the push continues server-side, without claiming failure', async () => {
    const { waitForPushJob, PushJobTimeoutError } = await import('./remote.js');
    stubJobPolls([running]);

    const error = await waitForPushJob('ws_1', 'job_1', { timeoutMs: 20, intervalMs: 1 }).catch((e) => e);

    expect(error).toBeInstanceOf(PushJobTimeoutError);
    expect((error as Error).message).toContain('job_1');
    expect((error as Error).message).toMatch(/still running server-side/i);
    expect((error as Error).message).not.toMatch(/push failed/i);
  });

  /** Queue one HTTP status per poll; the last one repeats. */
  function stubJobStatuses(statuses: number[]): void {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requested.push(url);
        const status = statuses[Math.min(call, statuses.length - 1)];
        call += 1;
        const body = status === 200 ? { id: 'job_1', status: 'succeeded', lastError: null, result: null } : {};
        return { ok: status === 200, status, json: async () => body, text: async () => 'upstream error' } as never;
      }),
    );
  }

  it('retries a transient 5xx poll and returns the job once the server answers again', async () => {
    const { waitForPushJob } = await import('./remote.js');
    stubJobStatuses([502, 200]);

    const job = await waitForPushJob('ws_1', 'job_1', { timeoutMs: 5000, intervalMs: 1 });

    expect(job.status).toBe('succeeded');
  });

  it('reports a persistently unreachable server as inconclusive, not as a failed push', async () => {
    const { waitForPushJob, PushJobTimeoutError } = await import('./remote.js');
    stubJobStatuses([503]);

    const error = await waitForPushJob('ws_1', 'job_1', { timeoutMs: 5000, intervalMs: 1 }).catch((e) => e);

    expect(error).toBeInstanceOf(PushJobTimeoutError);
    expect((error as Error).message).toContain('job_1');
    expect((error as Error).message).toMatch(/still running server-side/i);
  });

  it('throws immediately on a non-5xx answer — the server said something definite', async () => {
    const { waitForPushJob, PushJobTimeoutError } = await import('./remote.js');
    stubJobStatuses([401]);

    const error = await waitForPushJob('ws_1', 'job_1', { timeoutMs: 5000, intervalMs: 1 }).catch((e) => e);

    expect(error).not.toBeInstanceOf(PushJobTimeoutError);
    expect((error as Error).message).toContain('getJob failed (401)');
    expect(requested).toHaveLength(1);
  });
});
