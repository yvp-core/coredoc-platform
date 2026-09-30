/**
 * Where the intent perf smoke's artifacts are written — and the guard that
 * stands in front of the committed baseline.
 *
 * THE DEFECT THIS EXISTS FOR. A workload that fails (a dropped supertest
 * connection, a fixture that did not seed) is simply ABSENT from the in-memory
 * report: nothing in the report says a measurement is missing. Written to
 * `intent-report.json` that is harmless — the comparison run reports what it
 * measured and gates on it. Written to `intent-baseline.json` it is not: the
 * committed baseline silently loses rows, and every later run compares against
 * a baseline that no longer covers the workload, so the query-count gate for
 * that workload is gone with no message anywhere.
 *
 * So the UPDATE path refuses to write unless every workload of the baseline set
 * is present. Fail fast: a partial baseline is never written, and there is no
 * warn-and-continue.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE BASELINE SET: the workloads a complete baseline must contain, and the
 * only names `measure()` may record. Declared here rather than read off the
 * committed baseline file on purpose — the file is the thing being validated,
 * so it cannot also define what "complete" means (an already-truncated baseline
 * would happily accept its own truncation).
 *
 * The numbers in the labels mirror the smoke test's `EXACT_ID_SELECTOR_SIZE`,
 * `CONTEXT_LIMIT` and `REVIEW_BATCH_SIZE`. Changing one of those constants means
 * changing the label here and re-measuring the baseline: a renamed workload has
 * no baseline row, which the comparison prints as `NEW workload`.
 */
export enum PerfWorkloadName {
  ContextFeatureScope = 'context: feature scope',
  ContextNodeIdsUnscoped = 'context: nodeIds (guard case, unscoped)',
  ContextNodeIdsFeatureScoped = 'context: nodeIds (guard case, feature-scoped)',
  ContextLexicalSearch = 'context: lexical search',
  ContextTask = 'context: task fusion',
  ContextExactIds = 'context: exact ids (50 selected, 20 returned)',
  ReviewBatch = 'review: batch of 10',
}

export const PERF_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '../../../../perf');
export const BASELINE_PATH = join(PERF_DIRECTORY, 'intent-baseline.json');
export const REPORT_PATH = join(PERF_DIRECTORY, 'intent-report.json');

/** The file-system calls the writer makes. Injectable so the guard is unit-testable without a perf run. */
export interface PerfArtifactIo {
  mkdir(directory: string): void;
  writeFile(path: string, contents: string): void;
}

const NODE_FS_IO: PerfArtifactIo = {
  mkdir: (directory) => {
    mkdirSync(directory, { recursive: true });
  },
  writeFile: (path, contents) => {
    writeFileSync(path, contents);
  },
};

/** The only shape the writer needs to see; the smoke test's `PerfReport` satisfies it. */
export interface MeasuredWorkloads {
  workloads: ReadonlyArray<{ name: string }>;
}

/**
 * Baseline-set workloads with no measurement in `report`, in declaration order.
 * Extra names that are not in the set are not this guard's business — the
 * comparison already prints them as `NEW workload`.
 */
export function missingBaselineWorkloads(report: MeasuredWorkloads): PerfWorkloadName[] {
  const measured = new Set(report.workloads.map((workload) => workload.name));
  return Object.values(PerfWorkloadName).filter((name) => !measured.has(name));
}

/**
 * Write the perf artifact and return the path written.
 *
 * `update` selects the committed baseline as the target and turns on the
 * completeness guard. The comparison path (`update: false`) writes
 * `intent-report.json` unconditionally, exactly as before — a partial report is
 * evidence about a failed run, not a lost gate.
 *
 * @throws when `update` is set and any baseline-set workload is missing.
 */
export function writePerfArtifact(
  report: MeasuredWorkloads,
  options: { update: boolean; io?: PerfArtifactIo },
): string {
  const io = options.io ?? NODE_FS_IO;
  if (options.update) {
    const missing = missingBaselineWorkloads(report);
    if (missing.length > 0) {
      throw new Error(
        `Refusing to write an incomplete intent perf baseline to ${BASELINE_PATH}: ` +
          `no measurement for ${missing.map((name) => `"${name}"`).join(', ')}. ` +
          'A workload is absent from the report when its test failed, so the committed baseline ' +
          'would silently lose the query-count gate for it. The baseline was NOT written — fix the ' +
          'failing workload above and re-run the whole suite with INTENT_PERF_UPDATE_BASELINE=1.',
      );
    }
  }
  const target = options.update ? BASELINE_PATH : REPORT_PATH;
  io.mkdir(PERF_DIRECTORY);
  io.writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
  return target;
}
