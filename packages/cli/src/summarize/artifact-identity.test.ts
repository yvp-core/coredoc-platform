import { describe, it, expect } from 'vitest';
import type { SummaryOutput, FunctionSummary } from './types.js';
import { reusePreviousIfUnchanged } from './artifact-identity.js';

function summary(functionId: string, purpose: string): FunctionSummary {
  return {
    functionId,
    versionedId: `${functionId}@abc123`,
    purpose,
    side_effects: [],
    confidence: 'high',
  } as FunctionSummary;
}

function artifact(overrides: Partial<SummaryOutput> = {}): SummaryOutput {
  return {
    repoId: 'repo-1',
    repoName: 'demo',
    generatedAt: '2026-01-01T00:00:00.000Z',
    summarizerVersion: '1.0.0',
    summaries: [summary('fn-1', 'does a thing')],
    stats: {
      totalFunctions: 1,
      summarized: 1,
      skippedCached: 0,
      failedSummarization: 0,
      processingTimeMs: 1234,
    },
    ...overrides,
  };
}

describe('reusePreviousIfUnchanged', () => {
  it('keeps the previous artifact when only run metadata differs', () => {
    const previous = artifact();
    const next = artifact({
      generatedAt: '2026-06-06T12:00:00.000Z',
      stats: { totalFunctions: 1, summarized: 0, skippedCached: 1, failedSummarization: 0, processingTimeMs: 99999 },
    });

    // Byte identity is the actual contract: the server versions this artifact by
    // hashing the uploaded bytes, so an unchanged summary set must serialize the same.
    expect(reusePreviousIfUnchanged(next, previous)).toBe(previous);
    expect(JSON.stringify(reusePreviousIfUnchanged(next, previous))).toBe(JSON.stringify(previous));
  });

  it('takes the new artifact when a summary changed', () => {
    const previous = artifact();
    const next = artifact({ summaries: [summary('fn-1', 'does a DIFFERENT thing')] });

    expect(reusePreviousIfUnchanged(next, previous)).toBe(next);
  });

  it('takes the new artifact when a summary is added or dropped', () => {
    const previous = artifact();
    const added = artifact({ summaries: [summary('fn-1', 'does a thing'), summary('fn-2', 'another')] });
    const dropped = artifact({ summaries: [] });

    expect(reusePreviousIfUnchanged(added, previous)).toBe(added);
    expect(reusePreviousIfUnchanged(dropped, previous)).toBe(dropped);
  });

  it('takes the new artifact when the summarizer version changes', () => {
    const previous = artifact();
    const next = artifact({ summarizerVersion: '2.0.0' });

    expect(reusePreviousIfUnchanged(next, previous)).toBe(next);
  });

  it('takes the new artifact when a high-level summary appears', () => {
    const previous = artifact();
    const next = artifact({
      repositorySummary: { purpose: 'a demo repo' } as SummaryOutput['repositorySummary'],
    });

    expect(reusePreviousIfUnchanged(next, previous)).toBe(next);
  });

  it('takes the new artifact when package summaries are backfilled', () => {
    const previous = artifact();
    const next = artifact({
      packageSummaries: [{ packageId: 'pkg-1', purpose: 'core', generatedAt: '2026-06-06T12:00:00.000Z' }],
    });

    expect(reusePreviousIfUnchanged(next, previous)).toBe(next);
  });

  it('passes the new artifact through when there is nothing to compare against', () => {
    const next = artifact();

    expect(reusePreviousIfUnchanged(next, null)).toBe(next);
    expect(reusePreviousIfUnchanged(next, undefined)).toBe(next);
  });
});
