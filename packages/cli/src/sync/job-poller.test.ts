import { describe, it, expect, vi } from 'vitest';
import { pollJobs } from './job-poller.js';

describe('pollJobs', () => {
  it('returns immediately when all jobs already terminal', async () => {
    const getJob = vi.fn(async (_w: string, id: string) => ({
      id,
      workspaceId: 'ws_1',
      repoName: null,
      type: 'push' as const,
      status: 'succeeded' as const,
      attempts: 1,
      maxAttempts: 3,
      result: null,
      lastError: null,
      queuedAt: 'x',
      startedAt: 'x',
      finishedAt: 'x',
    }));
    const result = await pollJobs('ws_1', ['job_a', 'job_b'], { getJob, pollIntervalMs: 1 });
    expect(result.terminal.length).toBe(2);
    expect(result.failedJobIds.length).toBe(0);
    expect(getJob).toHaveBeenCalledTimes(2);
  });

  it('polls until all jobs reach terminal state', async () => {
    let calls = 0;
    const getJob = vi.fn(async () => {
      calls += 1;
      return calls < 2
        ? {
            id: 'j',
            workspaceId: 'ws_1',
            repoName: null,
            type: 'push' as const,
            status: 'running' as const,
            attempts: 1,
            maxAttempts: 3,
            result: null,
            lastError: null,
            queuedAt: 'x',
            startedAt: 'x',
            finishedAt: null,
          }
        : {
            id: 'j',
            workspaceId: 'ws_1',
            repoName: null,
            type: 'push' as const,
            status: 'succeeded' as const,
            attempts: 1,
            maxAttempts: 3,
            result: null,
            lastError: null,
            queuedAt: 'x',
            startedAt: 'x',
            finishedAt: 'x',
          };
    });
    const result = await pollJobs('ws_1', ['j'], { getJob, pollIntervalMs: 1 });
    expect(result.terminal[0].status).toBe('succeeded');
    expect(result.failedJobIds.length).toBe(0);
  });

  it('collects failed job ids', async () => {
    const getJob = vi.fn(async (_w: string, id: string) => ({
      id,
      workspaceId: 'ws_1',
      repoName: null,
      type: 'push' as const,
      status: id === 'bad' ? ('failed' as const) : ('succeeded' as const),
      attempts: id === 'bad' ? 3 : 1,
      maxAttempts: 3,
      result: null,
      lastError: id === 'bad' ? 'kaboom' : null,
      queuedAt: 'x',
      startedAt: 'x',
      finishedAt: 'x',
    }));
    const result = await pollJobs('ws_1', ['ok', 'bad'], { getJob, pollIntervalMs: 1 });
    expect(result.failedJobIds).toEqual(['bad']);
  });

  it('respects timeout and returns pending jobs', async () => {
    const getJob = vi.fn(async (_w: string, id: string) => ({
      id,
      workspaceId: 'ws_1',
      repoName: null,
      type: 'push' as const,
      status: 'running' as const,
      attempts: 1,
      maxAttempts: 3,
      result: null,
      lastError: null,
      queuedAt: 'x',
      startedAt: 'x',
      finishedAt: null,
    }));
    const result = await pollJobs('ws_1', ['j'], { getJob, pollIntervalMs: 5, timeoutMs: 20 });
    expect(result.timedOut).toBe(true);
    expect(result.terminal.length).toBe(0);
  });

  it('treats getJob=null as missing after default 1 observation (no infinite loop)', async () => {
    // Regression: without missing-job handling, pending never decremented and
    // the loop hung forever when timeoutMs was unset.
    const getJob = vi.fn(async () => null);
    const result = await pollJobs('ws_1', ['gone'], { getJob, pollIntervalMs: 1 });
    expect(result.missingJobIds).toEqual(['gone']);
    expect(result.terminal.length).toBe(0);
    expect(result.failedJobIds.length).toBe(0);
    expect(result.timedOut).toBe(false);
    // Only one call needed with default missingTolerance=1.
    expect(getJob).toHaveBeenCalledTimes(1);
  });

  it('missingTolerance>1 retries before declaring missing; resets on a non-null read', async () => {
    let call = 0;
    const getJob = vi.fn(async () => {
      call += 1;
      // null, null, running, null → missing counter resets at call 3 then climbs again.
      if (call === 3) {
        return {
          id: 'j',
          workspaceId: 'ws_1',
          repoName: null,
          type: 'push' as const,
          status: 'running' as const,
          attempts: 1,
          maxAttempts: 3,
          result: null,
          lastError: null,
          queuedAt: 'x',
          startedAt: 'x',
          finishedAt: null,
        };
      }
      return null;
    });
    const result = await pollJobs('ws_1', ['j'], {
      getJob,
      pollIntervalMs: 1,
      missingTolerance: 2,
      timeoutMs: 100,
    });
    expect(result.missingJobIds).toEqual(['j']);
  });
});
