/**
 * Operations Tracker
 *
 * Non-intrusive wrapper that records CLI operation start/complete/fail
 * to the SQLite operations table, scoped by (projectId, repoName), AND
 * threads the shared telemetry client (`@coredoc/core/telemetry`): a
 * `<op>_completed` / `<op>_failed` event per operation, plus the parse
 * scorecard + one `parse_anomaly` per detected rule on the parse branch.
 *
 * All five call sites (parse ×2, summarize ×2, push) flow through here, so
 * this is the single attach point for operation-level telemetry.
 */

import type { OperationType } from '@coredoc/db';
import type { ParsedRepo } from '@coredoc/core/types';
import { getTelemetryConfig } from '@coredoc/core/utils';
import {
  classifyError,
  detectParseAnomalies,
  EventName,
  type Props,
  repoId,
  scrubPaths,
  shutdownTelemetry,
  track,
  trackError,
} from '@coredoc/core/telemetry';

/** OperationType → success event. Only the three real callers are mapped (YAGNI). */
const COMPLETED_EVENT: Partial<Record<OperationType, EventName>> = {
  parse: EventName.ParseCompleted,
  summarize: EventName.SummarizeCompleted,
  push: EventName.PushCompleted,
};

/**
 * OperationType → failure event. `summarize` has no `SummarizeFailed` member in
 * the P0 vocabulary, so a summarize failure emits only the exception report
 * (see the catch in {@link trackOperation}) — noted, not faked.
 */
const FAILED_EVENT: Partial<Record<OperationType, EventName>> = {
  parse: EventName.ParseFailed,
  push: EventName.PushFailed,
};

/**
 * Builds the parse scorecard props from `ParsedRepo.stats` (never re-derived
 * from `.length`, which drifts from what the engine actually recorded). Pure +
 * exported so it stays independently testable. `languages` is a comma-joined
 * string because {@link Props} values are scalars (no array/object props).
 */
export function buildParseScorecardProps(repo: ParsedRepo): Props {
  const languages = [...new Set(repo.files.map((f) => f.language))];
  return {
    files: repo.stats.parsedFiles,
    functions: repo.stats.totalFunctions,
    calls: repo.stats.totalCalls,
    entrypoints: repo.stats.totalEntrypoints,
    entities: repo.stats.totalEntities,
    parse_time_ms: repo.stats.parseTimeMs,
    error_count: repo.errors?.length ?? 0,
    package_count: repo.packages.length,
    languages: languages.join(','),
  };
}

/**
 * Clone an error with the repo/project names replaced by `<repo>` in its
 * message and stack. Paths are scrubbed centrally (`scrubPaths` / `trackError`);
 * names are only known here, so this is the one place that can redact them and
 * keep the "repo names are never sent" promise of `coredoc telemetry show`.
 */
export function redactNames(error: unknown, names: string[]): Error {
  const src = error instanceof Error ? error : new Error(String(error));
  const redact = (text: string) =>
    names.filter((n) => n.length > 0).reduce((acc, n) => acc.split(n).join('<repo>'), text);
  const out = new Error(redact(src.message));
  out.name = src.name;
  out.stack = src.stack ? redact(src.stack) : undefined;
  return out;
}

/** Emits the success event(s) for a completed operation. Parse gets the scorecard + anomalies. */
async function emitOperationSuccess(
  operation: OperationType,
  result: unknown,
  metadata: Record<string, unknown>,
  durationMs: number,
): Promise<void> {
  if (operation === 'parse') {
    const repo = result as ParsedRepo;
    // A parse result always carries `.stats`; guard defends the generic seam
    // against a caller mislabeling a non-parse op as 'parse'.
    if (repo?.stats) {
      // repo_id keys the entire parse-health funnel on (install_id, repo_id).
      // The client's base repo_id is never populated (no P0 caller passes
      // repoRoot to initTelemetry), so we derive it per-event from the repo
      // path known HERE and let it override the base prop in the client merge.
      // `repoId` is deterministic and never throws (ids.repoId), so it is safe
      // on this hot path.
      const { installId } = await getTelemetryConfig();
      const repo_id = repoId(installId, repo.path);
      track(EventName.ParseCompleted, { duration_ms: durationMs, ...buildParseScorecardProps(repo), repo_id });
      for (const rule of detectParseAnomalies({ stats: repo.stats, errorCount: repo.errors?.length ?? 0 })) {
        track(EventName.ParseAnomaly, { rule_id: rule, repo_id });
      }
    }
    return;
  }

  const event = COMPLETED_EVENT[operation];
  if (event) {
    track(event, { duration_ms: durationMs, ...(metadata as Props) });
  }
}

/**
 * Wrap a CLI operation with start/complete/fail tracking (SQLite + telemetry).
 */
export async function trackOperation<T>(
  projectId: string,
  repoName: string,
  operation: OperationType,
  fn: () => Promise<T>,
  metadataFn?: (result: T) => Record<string, unknown>,
): Promise<T> {
  const start = Date.now();
  let operationId: string | null = null;

  try {
    const { getOperationsRepository } = await import('@coredoc/db');
    const opsRepo = await getOperationsRepository();
    operationId = await opsRepo.startOperation(projectId, repoName, operation);
  } catch {
    // DB unavailable — run without SQLite tracking (telemetry still emits)
  }

  try {
    const result = await fn();
    const metadata = metadataFn ? metadataFn(result) : {};

    if (operationId) {
      try {
        const { getOperationsRepository } = await import('@coredoc/db');
        const opsRepo = await getOperationsRepository();
        await opsRepo.completeOperation(operationId, metadata);
      } catch {
        /* ignore */
      }
    }

    // Telemetry is ungated by DB availability — it is a separate channel.
    await emitOperationSuccess(operation, result, metadata, Date.now() - start);

    return result;
  } catch (error) {
    if (operationId) {
      try {
        const { getOperationsRepository } = await import('@coredoc/db');
        const opsRepo = await getOperationsRepository();
        const message = error instanceof Error ? error.message : String(error);
        await opsRepo.failOperation(operationId, message);
      } catch {
        /* ignore */
      }
    }

    // Emit the failure event + exception report, then flush before rethrowing —
    // the CLI's ~43 `process.exit(1)` sites bypass beforeExit, so an unflushed
    // event is lost. The event carries the error type + redacted message so a
    // failure is diagnosable from the event alone; the (scrubbed) stack rides on
    // the exception report, which every operation emits — including summarize,
    // which has no `*_failed` event.
    const code = classifyError(error);
    const safe = redactNames(error, [repoName, projectId]);
    const failEvent = FAILED_EVENT[operation];
    if (failEvent) {
      track(failEvent, {
        duration_ms: Date.now() - start,
        error_code: code,
        error_name: safe.name,
        error_message: scrubPaths(safe.message).slice(0, 500),
      });
    }
    trackError(safe, code, { operation });
    await shutdownTelemetry(500);

    throw error;
  }
}
