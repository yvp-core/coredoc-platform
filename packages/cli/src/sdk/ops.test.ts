/**
 * `readOpsTimestamps` is the loud reader (`coredoc ops` must exit 1 on an
 * unavailable/corrupt project DB); `getOpsTimestamps` is the never-throws poll
 * the desktop uses. `@coredoc/db` is mocked so the split is testable without a
 * real database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { openProjectDatabaseSpy, getOperationSummarySpy } = vi.hoisted(() => ({
  openProjectDatabaseSpy: vi.fn(),
  getOperationSummarySpy: vi.fn(),
}));

vi.mock('@coredoc/db', () => ({ openProjectDatabase: openProjectDatabaseSpy }));

import { getOpsTimestamps, readOpsTimestamps } from './ops.js';

beforeEach(() => {
  vi.clearAllMocks();
  openProjectDatabaseSpy.mockResolvedValue({ operations: { getOperationSummary: getOperationSummarySpy } });
});

describe('readOpsTimestamps', () => {
  it('surfaces parsedRevision from the last parse metadata', async () => {
    getOperationSummarySpy.mockResolvedValue({
      lastParsed: {
        completedAt: 1_700_000_000_000,
        metadata: {
          gitCommitHash: 'abc123def',
          gitCommitShortHash: 'abc123d',
          gitBranch: 'main',
          gitIsDirty: false,
        },
      },
    });

    const result = await readOpsTimestamps('p1', 'demo', '/cfg');

    expect(result?.lastParsed).toBe(new Date(1_700_000_000_000).toISOString());
    expect(result?.parsedRevision).toEqual({
      commitHash: 'abc123def',
      commitShortHash: 'abc123d',
      branch: 'main',
      isDirty: false,
    });
  });

  it('rethrows when the project database cannot be opened', async () => {
    openProjectDatabaseSpy.mockRejectedValue(new Error('file is not a database'));

    await expect(readOpsTimestamps('p1', 'demo', '/cfg')).rejects.toThrow('file is not a database');
  });
});

describe('getOpsTimestamps', () => {
  it('returns null for the same failure (never-throws poll)', async () => {
    openProjectDatabaseSpy.mockRejectedValue(new Error('file is not a database'));

    await expect(getOpsTimestamps('p1', 'demo', '/cfg')).resolves.toBeNull();
  });
});
