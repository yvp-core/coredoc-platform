/**
 * Tests for trackOperation's telemetry threading (P0.7).
 *
 * trackOperation is the single seam the parse/summarize/push call sites flow
 * through. These tests assert it emits the shared-telemetry events on the
 * success and failure paths WITHOUT any real DB or network:
 *  - `@coredoc/db` is mocked so the SQLite ops table is a no-op.
 *  - `@coredoc/core/telemetry` keeps its REAL enums + detectParseAnomalies
 *    (via importActual) but swaps `track` and `shutdownTelemetry` for spies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ParsedRepo } from '@coredoc/core/types';
import { EventName, ErrorCode, repoId } from '@coredoc/core/telemetry';
import { getTelemetryConfig } from '@coredoc/core/utils';

const { trackSpy, trackErrorSpy, shutdownSpy } = vi.hoisted(() => ({
  trackSpy: vi.fn(),
  trackErrorSpy: vi.fn(),
  shutdownSpy: vi.fn().mockResolvedValue(undefined),
}));

// Keep the real vocabulary + anomaly detection; only intercept the emit sinks.
vi.mock('@coredoc/core/telemetry', async (importActual) => {
  const actual = await importActual<typeof import('@coredoc/core/telemetry')>();
  return {
    ...actual,
    track: trackSpy,
    trackError: trackErrorSpy,
    shutdownTelemetry: shutdownSpy,
  };
});

// SQLite operations table is a no-op — telemetry must emit regardless of DB.
vi.mock('@coredoc/db', () => ({
  getOperationsRepository: vi.fn().mockResolvedValue({
    startOperation: vi.fn().mockResolvedValue('op-1'),
    completeOperation: vi.fn().mockResolvedValue(undefined),
    failOperation: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { trackOperation } from './operations-tracker.js';

/**
 * The WASM-missing regression fixture: 601 functions found, 0 calls extracted,
 * 601 files parsed, 888 errors. Trips `zero_calls_nonzero_functions` and
 * `error_rate_gt_20pct` (but NOT wasm_missing — functions are non-zero).
 */
function makeWasmParsedRepo(): ParsedRepo {
  return {
    path: '/tmp/coredoc-test/my-repo',
    stats: {
      totalFiles: 601,
      parsedFiles: 601,
      skippedFiles: 0,
      totalFunctions: 601,
      totalClasses: 0,
      totalEntrypoints: 12,
      totalEntities: 4,
      totalCalls: 0,
      totalImports: 0,
      totalExternalCalls: 0,
      parseTimeMs: 4242,
    },
    errors: Array.from({ length: 888 }, (_, i) => ({
      file: `src/file-${i}.ts`,
      message: 'tree-sitter parse failed',
      severity: 'error' as const,
    })),
    files: [{ language: 'typescript' }, { language: 'typescript' }, { language: 'python' }],
    packages: [{}, {}],
    // Unused-by-scorecard fields left off — cast bridges the partial shape.
  } as unknown as ParsedRepo;
}

describe('trackOperation telemetry (P0.7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits parse_completed with the scorecard on a successful parse', async () => {
    const repo = makeWasmParsedRepo();

    await trackOperation('proj-1', 'my-repo', 'parse', async () => repo);

    const completed = trackSpy.mock.calls.find((c) => c[0] === EventName.ParseCompleted);
    expect(completed).toBeDefined();
    const props = completed?.[1] as Record<string, unknown>;
    expect(props).toMatchObject({
      files: 601,
      functions: 601,
      calls: 0,
      entrypoints: 12,
      entities: 4,
      parse_time_ms: 4242,
      error_count: 888,
      package_count: 2,
    });
    expect(props.duration_ms).toEqual(expect.any(Number));
  });

  it('stamps parse_completed + every parse_anomaly with a non-empty repo_id = repoId(installId, repo.path)', async () => {
    const repo = makeWasmParsedRepo();

    await trackOperation('proj-1', 'my-repo', 'parse', async () => repo);

    // Real (unmocked) getTelemetryConfig + repoId — the same cached installId the
    // production path resolved, so the ids must match exactly.
    const { installId } = await getTelemetryConfig();
    const expectedRepoId = repoId(installId, repo.path);
    expect(expectedRepoId).not.toBe('');

    const completed = trackSpy.mock.calls.find((c) => c[0] === EventName.ParseCompleted);
    const completedProps = completed?.[1] as Record<string, unknown>;
    expect(completedProps.repo_id).toBe(expectedRepoId);

    // Fixture trips 2 anomalies; each must carry the same repo_id.
    const anomalies = trackSpy.mock.calls.filter((c) => c[0] === EventName.ParseAnomaly);
    expect(anomalies.length).toBeGreaterThan(0);
    for (const call of anomalies) {
      expect((call[1] as Record<string, unknown>).repo_id).toBe(expectedRepoId);
    }
  });

  it('emits one parse_anomaly per detected rule (incl. zero_calls_nonzero_functions)', async () => {
    const repo = makeWasmParsedRepo();

    await trackOperation('proj-1', 'my-repo', 'parse', async () => repo);

    const anomalies = trackSpy.mock.calls
      .filter((c) => c[0] === EventName.ParseAnomaly)
      .map((c) => (c[1] as Record<string, unknown>).rule_id);

    expect(anomalies).toContain(ErrorCode.ZeroCallsNonzeroFunctions);
    expect(anomalies).toContain(ErrorCode.ErrorRateGt20Pct);
    // 601 functions ≠ 0 → wasm_missing must NOT fire.
    expect(anomalies).not.toContain(ErrorCode.WasmMissing);
  });

  it('emits <op>_failed with an error_code, flushes via shutdownTelemetry(500) BEFORE rethrowing', async () => {
    const order: string[] = [];
    trackSpy.mockImplementation((event: string) => {
      order.push(`track:${event}`);
    });
    shutdownSpy.mockImplementation(async () => {
      order.push('shutdown');
    });

    const boom = new Error('push exploded for my-repo in proj-1 at /Users/x/my-repo/graph.lbug');
    boom.name = 'LadybugError';

    await expect(
      trackOperation('proj-1', 'my-repo', 'push', async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    const failed = trackSpy.mock.calls.find((c) => c[0] === EventName.PushFailed);
    expect(failed).toBeDefined();
    const props = failed?.[1] as Record<string, unknown>;
    expect(props.error_code).toBeDefined();
    expect(props.duration_ms).toEqual(expect.any(Number));
    // The event alone must make the failure diagnosable: error class + message,
    // with the repo/project names and file paths redacted.
    expect(props.error_name).toBe('LadybugError');
    expect(props.error_message).toBe('push exploded for <repo> in <repo> at <path>');

    // The stack rides on the exception report, with names redacted and class kept.
    expect(trackErrorSpy).toHaveBeenCalledTimes(1);
    const [reported, code, extra] = trackErrorSpy.mock.calls[0] as [Error, string, Record<string, unknown>];
    expect(reported).not.toBe(boom);
    expect(reported.name).toBe('LadybugError');
    expect(reported.message).not.toContain('my-repo');
    expect(reported.stack).not.toContain('my-repo');
    expect(reported.stack).toContain('at ');
    expect(code).toBe(props.error_code);
    expect(extra).toEqual({ operation: 'push' });

    // shutdown was awaited AFTER the fail event and BEFORE the throw propagated.
    expect(shutdownSpy).toHaveBeenCalledWith(500);
    expect(order).toEqual(['track:push_failed', 'shutdown']);
  });

  it('reports a summarize failure as an exception even though it has no *_failed event', async () => {
    await expect(
      trackOperation('proj-1', 'my-repo', 'summarize', async () => {
        throw new Error('llm down');
      }),
    ).rejects.toThrow('llm down');

    expect(trackSpy).not.toHaveBeenCalled();
    expect(trackErrorSpy).toHaveBeenCalledWith(expect.any(Error), ErrorCode.Unknown, { operation: 'summarize' });
    expect(shutdownSpy).toHaveBeenCalledWith(500);
  });

  it('does not emit parse events for a non-parse successful op', async () => {
    await trackOperation(
      'proj-1',
      'my-repo',
      'push',
      async () => ({ ok: true }),
      () => ({ pushed: 3 }),
    );

    expect(trackSpy.mock.calls.find((c) => c[0] === EventName.ParseCompleted)).toBeUndefined();
    const pushCompleted = trackSpy.mock.calls.find((c) => c[0] === EventName.PushCompleted);
    expect(pushCompleted).toBeDefined();
    const props = pushCompleted?.[1] as Record<string, unknown>;
    expect(props).toMatchObject({ pushed: 3 });
    expect(props.duration_ms).toEqual(expect.any(Number));
  });
});
