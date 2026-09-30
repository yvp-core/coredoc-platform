import { describe, expect, it } from 'vitest';
import { toJobResponse } from './job-response.dto.js';

describe('toJobResponse', () => {
  it('keeps public version metadata while omitting internal job inputs and object paths', () => {
    const payloadCanary = 'private-job-payload-canary';
    const pathCanary = 'private-object-path-canary';
    const row = {
      id: 'job-1',
      workspaceId: 'workspace-1',
      repoName: 'api',
      type: 'push',
      status: 'running',
      attempts: 1,
      maxAttempts: 3,
      lastError: null,
      queuedAt: new Date('2026-08-11T00:00:00.000Z'),
      startedAt: new Date('2026-08-11T00:00:01.000Z'),
      finishedAt: null,
      result: {
        graphVersionId: 'a'.repeat(64),
        versionId: 'c'.repeat(64),
        mapperSha: 'b'.repeat(64),
        artifact: {
          r2Key: `workspace-1/graphs/${pathCanary}.ladybug`,
          sha256: 'd'.repeat(64),
          sizeBytes: 42,
        },
      },
      heartbeatAt: new Date('2026-08-11T00:00:02.000Z'),
      phase: 'build',
      progress: { current: 1, total: 2 },
      payload: { parsedRepo: payloadCanary },
      queuedByUserId: 'user-private',
    } as unknown as Parameters<typeof toJobResponse>[0];

    const response = toJobResponse(row);

    expect(response).not.toHaveProperty('payload');
    expect(response).not.toHaveProperty('queuedByUserId');
    expect(JSON.stringify(response)).not.toContain(payloadCanary);
    expect(JSON.stringify(response)).not.toContain(pathCanary);
    expect(response.result).toEqual({
      graphVersionId: 'a'.repeat(64),
      versionId: 'c'.repeat(64),
      mapperSha: 'b'.repeat(64),
      artifact: { sha256: 'd'.repeat(64), sizeBytes: 42 },
    });
  });
});
