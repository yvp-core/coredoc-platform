/**
 * Tests for the get_extraction_coverage tool handler.
 *
 * Coverage math itself is covered in coverage.test.ts — these pin the handler
 * contract: per-repo stats + trust guidance in both formats, resultCount for
 * the centralized metrics path, and scope propagation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleGetExtractionCoverage } from './get-extraction-coverage.js';
import type { ScopeContext } from '../../types.js';
import { DYNAMIC_DISPATCH_CAVEAT, NO_LOW_COVERAGE_FLAGS, type RepoCoverageStats } from '../../coverage.js';
import { createMockRepository, createMockCoverageCounts } from '../../__tests__/fixtures/mock-repository.js';

// Mock database (the repository is always injected as the 6th handler arg;
// response-formatter also imports getRepository for staleness metadata).
vi.mock('@coredoc/db', () => ({
  getRepository: vi.fn(),
}));

const mockScope: ScopeContext = {
  currentPath: '/test/repo',
  resolvedRepos: ['test-repo'],
  repoHashes: ['abc123def456'],
  crossRepoEnabled: false,
};

describe('get_extraction_coverage Tool Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns per-repo stats with the call-resolution record in raw format and sets resultCount', async () => {
    const mockRepo = createMockRepository({
      getCoverageCounts: vi.fn().mockResolvedValue([
        createMockCoverageCounts({
          repoName: 'svc-a',
          entityCount: 10,
          entitiesWithDbOps: 5,
          callResolution: { callSites: 100, resolvedCalls: 60, outOfScopeCalls: 20 },
          dbOpResolution: { dbOpSites: 40, boundDbOps: 25, outOfScopeDbOps: 5 },
          analysis: [{ language: 'csharp', mode: 'basic', compilerReceiverTypes: false, fallback: true }],
        }),
        createMockCoverageCounts({ repoName: 'svc-b' }),
      ]),
    });

    const result = await handleGetExtractionCoverage({}, mockScope, 'raw', undefined, undefined, mockRepo);

    expect(mockRepo.getCoverageCounts).toHaveBeenCalledWith(mockScope.repoHashes);
    expect(result.resultCount).toBe(2);
    const stats = result.data as RepoCoverageStats[];
    expect(stats).toHaveLength(2);
    expect(stats[0]).toMatchObject({
      repoName: 'svc-a',
      entitiesWithDbOps: 5,
      callResolution: { callSites: 100, resolvedCalls: 60, outOfScopeCalls: 20 },
      dbOpResolution: { dbOpSites: 40, boundDbOps: 25, outOfScopeDbOps: 5 },
      analysis: [{ language: 'csharp', mode: 'basic', compilerReceiverTypes: false, fallback: true }],
    });
    // A repo whose graph carries no record reports absence, never 0/0/0.
    expect(stats[1]!.callResolution).toBeUndefined();
    expect(stats[1]!.dbOpResolution).toBeUndefined();
    expect(stats[1]!.analysis).toBeUndefined();
  });

  it('renders counts for calls and entities, and LOW only for external resolution', async () => {
    const mockRepo = createMockRepository({
      getCoverageCounts: vi.fn().mockResolvedValue([
        createMockCoverageCounts({
          repoName: 'svc',
          nodeCountsByType: { function: 100, entity: 100, external_call: 20 },
          entityCount: 100,
          entitiesWithDbOps: 12,
          functionCount: 100,
          functionsWithCalls: 50,
          externalCallCount: 20,
          resolvedExternalCallCount: 2, // 10% — LOW
          callResolution: { callSites: 300, resolvedCalls: 160, outOfScopeCalls: 100 },
          dbOpResolution: { dbOpSites: 90, boundDbOps: 40, outOfScopeDbOps: 30 },
        }),
      ]),
    });

    const result = await handleGetExtractionCoverage({}, mockScope, 'summary', undefined, undefined, mockRepo);

    expect(result.resultCount).toBe(1);
    const text = result.data as string;
    expect(text).toContain('svc');
    expect(text).toContain(
      '- **DB operations:** 40/60 counted sites bound (67%); 30 of 90 counted sites name no entity or table declared in this repository; 12 of 100 entities have at least one recorded operation',
    );
    expect(text).toContain(
      '- **In-repo call resolution:** 160/200 counted sites bound (80%); 100 of 300 counted sites name nothing declared in this repository',
    );
    expect(text).toContain('20 total, 2 resolved'); // external calls, unchanged
    expect(text).toContain('external-call resolution LOW (10% of external calls');
    expect(text).not.toContain('dbOp coverage LOW');
    expect(text).not.toContain('call coverage LOW');
  });

  it('says so when nothing is flagged (no LOW lines)', async () => {
    const mockRepo = createMockRepository({
      getCoverageCounts: vi.fn().mockResolvedValue([createMockCoverageCounts({ repoName: 'svc' })]),
    });

    const result = await handleGetExtractionCoverage({}, mockScope, 'summary', undefined, undefined, mockRepo);

    expect(result.data).toContain(NO_LOW_COVERAGE_FLAGS);
    expect(result.data).not.toContain('LOW (');
  });

  // D1: healthy densities used to print "empty results in this repo are likely
  // real absences", which steered agents into trusting false 0-caller results
  // for dispatch the substrate cannot resolve statically.
  it('never claims empty results are real absences, and keeps the dynamic-dispatch caveat when nearly every call binds', async () => {
    const mockRepo = createMockRepository({
      getCoverageCounts: vi.fn().mockResolvedValue([
        createMockCoverageCounts({
          repoName: 'svc',
          functionCount: 100,
          functionsWithCalls: 95, // 95% — well above the LOW threshold
        }),
      ]),
    });

    const result = await handleGetExtractionCoverage({}, mockScope, 'summary', undefined, undefined, mockRepo);
    const text = result.data as string;

    expect(text).not.toContain('likely real absences');
    expect(text).toContain(DYNAMIC_DISPATCH_CAVEAT);
  });

  it('prints the dynamic-dispatch caveat once, not per repo', async () => {
    const mockRepo = createMockRepository({
      getCoverageCounts: vi
        .fn()
        .mockResolvedValue([
          createMockCoverageCounts({ repoName: 'svc-a' }),
          createMockCoverageCounts({ repoName: 'svc-b' }),
          createMockCoverageCounts({ repoName: 'svc-c' }),
        ]),
    });

    const result = await handleGetExtractionCoverage({}, mockScope, 'summary', undefined, undefined, mockRepo);
    const occurrences = (result.data as string).split(DYNAMIC_DISPATCH_CAVEAT).length - 1;

    expect(occurrences).toBe(1);
  });

  it('handles an empty scope (no parsed repos) with resultCount 0', async () => {
    const mockRepo = createMockRepository({ getCoverageCounts: vi.fn().mockResolvedValue([]) });

    const raw = await handleGetExtractionCoverage({}, mockScope, 'raw', undefined, undefined, mockRepo);
    expect(raw.data).toEqual([]);
    expect(raw.resultCount).toBe(0);

    const summary = await handleGetExtractionCoverage({}, mockScope, 'summary', undefined, undefined, mockRepo);
    expect(summary.data).toContain('No parsed repositories');
    expect(summary.resultCount).toBe(0);
  });
});
