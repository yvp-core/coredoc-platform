/**
 * The baseline writer's completeness guard.
 *
 * Pure unit test: no database, no HTTP, no perf run — the file-system calls are
 * injected. The behaviour under test is the one that used to fail silently, a
 * baseline written from a report that lost a workload to a failed test.
 */
import { describe, expect, it } from 'vitest';
import {
  BASELINE_PATH,
  missingBaselineWorkloads,
  PerfWorkloadName,
  REPORT_PATH,
  writePerfArtifact,
  type PerfArtifactIo,
} from './intent-perf-baseline.js';

function recordingIo(): PerfArtifactIo & { writes: Array<{ path: string; contents: string }> } {
  const writes: Array<{ path: string; contents: string }> = [];
  return {
    writes,
    mkdir: () => undefined,
    writeFile: (path, contents) => {
      writes.push({ path, contents });
    },
  };
}

const completeReport = () => ({
  workloads: Object.values(PerfWorkloadName).map((name) => ({ name })),
});

describe('intent perf baseline writer', () => {
  it('writes the baseline when every workload of the baseline set was measured', () => {
    const io = recordingIo();
    const report = completeReport();

    const target = writePerfArtifact(report, { update: true, io });

    expect(target).toBe(BASELINE_PATH);
    expect(io.writes.map((write) => write.path)).toEqual([BASELINE_PATH]);
    expect(JSON.parse(io.writes[0]?.contents as string)).toEqual(report);
  });

  it('refuses to write the baseline when a workload is missing, and names it', () => {
    const io = recordingIo();
    const report = {
      workloads: completeReport().workloads.filter(
        (workload) =>
          workload.name !== PerfWorkloadName.ContextLexicalSearch && workload.name !== PerfWorkloadName.ReviewBatch,
      ),
    };

    expect(() => writePerfArtifact(report, { update: true, io })).toThrow(
      /no measurement for "context: lexical search", "review: batch of 10"/,
    );
    // Fail fast: nothing at all was written, so the committed baseline still has
    // the query-count rows for the workloads this run failed to measure.
    expect(io.writes).toEqual([]);
  });

  it('tells the operator to re-run the whole suite with the update flag', () => {
    const io = recordingIo();

    expect(() => writePerfArtifact({ workloads: [] }, { update: true, io })).toThrow(
      /re-run the whole suite with INTENT_PERF_UPDATE_BASELINE=1/,
    );
  });

  it('still writes an incomplete report on the comparison path', () => {
    const io = recordingIo();
    const report = { workloads: [{ name: PerfWorkloadName.ContextFeatureScope }] };

    const target = writePerfArtifact(report, { update: false, io });

    expect(target).toBe(REPORT_PATH);
    expect(io.writes.map((write) => write.path)).toEqual([REPORT_PATH]);
  });

  it('reports missing workloads in declaration order and ignores unknown names', () => {
    expect(
      missingBaselineWorkloads({
        workloads: [{ name: 'context: something nobody declared' }],
      }),
    ).toEqual(Object.values(PerfWorkloadName));

    expect(missingBaselineWorkloads(completeReport())).toEqual([]);
  });
});
