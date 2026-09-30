/**
 * `coredoc sync` orchestrator.
 *
 * Sequence:
 *   1. Load config, resolve project (error if --project missing in multi-project config).
 *   2. Resolve workspaceId (create / use-stored / use-flag / rebind) via workspace-resolver.
 *   3. On 'create', immediately persist workspaceId to coredoc.config.json so retries
 *      pick up the existing workspace instead of creating a duplicate.
 *   4. Loop over repos, calling syncRepo. Continue past failures; collect results.
 *   5. If at least one repo was pushed (or --force), push the project mapper.
 *   6. If all repos succeeded, write lastSyncedAt back to config.
 *   7. Return exit code: 0=all ok, 1=any repo failed, 2=precondition failure.
 *
 * All HTTP and the mapper push call flow through the injectable `deps` so the
 * orchestrator is testable without a server.
 */

import * as fs from 'node:fs';
import type { RuntimeConfig, CoredocConfig, ProjectConfig } from '@coredoc/core/types';
import { mapperPathsForProject } from '@coredoc/core';
import { loadConfig } from '@coredoc/core/utils';
import { resolveWorkspace, WorkspaceConflictError, type WorkspaceResolverApi } from './workspace-resolver.js';
import {
  WorkspaceForbiddenError,
  WorkspaceNotFoundError,
  SlugTakenError,
  resolveWorkspace as defaultRemoteResolveWorkspace,
  type ResolveWorkspaceResponse,
  type QueuedJobReceipt,
  type JobResponse,
  getJob as defaultRemoteGetJob,
  getWorkspace as defaultRemoteGetWorkspace,
  type ResolveTarget,
} from './workspace-api.js';
import { syncRepo, defaultRepoSyncApi, type RepoSyncApi, type RepoSyncResult, type RepoSyncOk } from './repo-sync.js';
import { writeProjectCloud } from './config-writer.js';
import { runMapperPush, type MapperPushOptions, type MapperPushOutcome } from '../commands/mapper.js';
import { JOB_STILL_RUNNING_CODE, parseStructuredServerError } from '../structured-error.js';

export interface RunSyncOptions {
  configPath: string;
  projectId?: string;
  workspaceId?: string;
  rebind?: boolean;
  nameOverride?: string;
  slugOverride?: string;
  force: boolean;
  includeSummaries: boolean;
  includeEmbeddings: boolean;
  includeMapper: boolean;
  dryRun: boolean;
  verbose: boolean;
  quiet?: boolean;
  /** Block until all queued jobs reach terminal state. Default: false (fire-and-forget). */
  wait?: boolean;
  /** Max wait duration in ms. Only meaningful with wait=true. Default: unbounded. */
  waitTimeoutMs?: number;
  /** Poll interval in ms for --wait mode. Default: 5000. Exposed for testing. */
  waitPollIntervalMs?: number;
}

export interface RunSyncDeps {
  workspaceApi?: WorkspaceResolverApi;
  repoSyncApi?: RepoSyncApi;
  mapperPush?: (opts: MapperPushOptions) => Promise<MapperPushOutcome>;
  /**
   * HTTP helper that triggers one workspace-wide cross-repo resolution.
   * Called once at the end of the batch (when at least one repo was pushed)
   * because individual pushes ran with `defer=true` and skipped resolution.
   */
  resolveWorkspace?: (
    workspaceId: string,
    options?: { targets?: readonly ResolveTarget[] },
  ) => Promise<ResolveWorkspaceResponse | QueuedJobReceipt>;
  getJob?: (workspaceId: string, jobId: string) => Promise<JobResponse | null>;
}

/**
 * Default --wait ceiling when `waitTimeoutMs` is unset. Prevents the CLI from
 * wedging a CI runner forever when a job goes missing or the server is wedged.
 * Callers wanting truly unbounded waits must pass `--wait-timeout 0`.
 */
export const DEFAULT_WAIT_TIMEOUT_MS = 60 * 60 * 1000;

export interface RunSyncResult {
  exitCode: 0 | 1 | 2;
  workspaceId?: string;
  pushedCount: number;
  skippedCount: number;
  failedCount: number;
  repos: RepoSyncResult[];
  /**
   * 'publishing': the mapper landed but its publish job outlived the server's
   * synchronous budget and keeps running. Pending work, not a failure — treated
   * like a queued resolve for lastSyncedAt and exit code.
   */
  mapperStatus?: 'pushed' | 'publishing' | 'skipped' | 'failed' | 'not-found';
  /**
   * Final resolver run after all repos pushed.
   *  - 'resolved': server processed inline (?sync=true response) — completed.
   *  - 'queued':   async response, job is queued on the server — also covers a
   *                synchronous publish that outlived the server's request budget
   *                (structured 504 `job_still_running`) and keeps running there.
   *                With `--wait`, observe completion via waitJobFailures/waitTimedOut.
   *  - 'skipped':  no repo was pushed, no resolve needed.
   *  - 'failed':   the HTTP call to enqueue/resolve itself returned an error.
   */
  resolutionStatus?: 'resolved' | 'queued' | 'skipped' | 'failed';
  error?: string;
  waitTimedOut?: boolean;
  waitJobFailures?: number;
  /** Jobs the server returned null for during --wait polling (deleted/rolled-back). */
  waitMissingJobs?: number;
}

function selectProject(config: CoredocConfig, projectId: string | undefined): ProjectConfig {
  if (config.projects.length === 0) throw new Error('Config has no projects');
  if (!projectId) {
    if (config.projects.length === 1) return config.projects[0];
    throw new Error('Multiple projects in config; pass --project <id>');
  }
  const project = config.projects.find((p) => p.id === projectId);
  if (!project) throw new Error(`Project '${projectId}' not found in config`);
  return project;
}

export async function runSync(options: RunSyncOptions, deps: RunSyncDeps = {}): Promise<RunSyncResult> {
  const log = options.quiet ? () => {} : (line: string) => process.stderr.write(line + '\n');
  const repoSyncApi = deps.repoSyncApi ?? defaultRepoSyncApi;
  const mapperPush = deps.mapperPush ?? runMapperPush;
  const remoteResolveWorkspace = deps.resolveWorkspace ?? defaultRemoteResolveWorkspace;
  const remoteGetJob = deps.getJob ?? defaultRemoteGetJob;
  const remoteGetWorkspace = deps.workspaceApi?.getWorkspace ?? defaultRemoteGetWorkspace;

  // Step 1: load config + select project
  let runtime: RuntimeConfig;
  let project: ProjectConfig;
  try {
    // Canonical loader, but sync stays read-only on disk: the layout migration
    // deletes "orphans" relative to the config it is handed, and sync is often
    // handed a partial/CI config. Migration belongs to the config-owning
    // surfaces (CLI parse, desktop, MCP), not to sync.
    runtime = loadConfig(options.configPath, { skipMigration: true });
    project = selectProject(runtime, options.projectId);
  } catch (err) {
    log(`[sync] ✗ ${(err as Error).message}`);
    return { exitCode: 2, pushedCount: 0, skippedCount: 0, failedCount: 0, repos: [], error: (err as Error).message };
  }

  log(`[sync] project: ${project.name} (id=${project.id})`);

  // Step 2: resolve workspace. dryRun=true short-circuits the create branch
  // so dry-run never mutates cloud state (returns action='would-create' with
  // a placeholder id instead).
  let workspaceId: string;
  let action: 'create' | 'use-stored' | 'use-flag' | 'rebind' | 'would-create';
  let wouldCreate: { name: string; slug: string } | undefined;
  try {
    const resolved = await resolveWorkspace(
      {
        project: { id: project.id, name: project.name, cloud: project.cloud },
        flag: options.workspaceId,
        rebind: options.rebind ?? false,
        nameOverride: options.nameOverride,
        slugOverride: options.slugOverride,
        dryRun: options.dryRun,
      },
      deps.workspaceApi,
    );
    workspaceId = resolved.workspaceId;
    action = resolved.action;
    wouldCreate = resolved.wouldCreate;
  } catch (err) {
    log(`[sync] ✗ ${(err as Error).message}`);
    if (
      err instanceof WorkspaceConflictError ||
      err instanceof WorkspaceForbiddenError ||
      err instanceof WorkspaceNotFoundError ||
      err instanceof SlugTakenError
    ) {
      return { exitCode: 2, pushedCount: 0, skippedCount: 0, failedCount: 0, repos: [], error: (err as Error).message };
    }
    return { exitCode: 2, pushedCount: 0, skippedCount: 0, failedCount: 0, repos: [], error: (err as Error).message };
  }
  log(`[sync] workspace: ${workspaceId} (${action})`);

  // Step 3: dry-run short-circuit (before any persistence or upload)
  if (options.dryRun) {
    if (wouldCreate) {
      log(`[sync] [DRY RUN] Would create workspace name="${wouldCreate.name}" slug="${wouldCreate.slug}"`);
    }
    log(`[sync] [DRY RUN] Would sync ${project.repos.length} repo(s) into ${workspaceId}`);
    return { exitCode: 0, workspaceId, pushedCount: 0, skippedCount: 0, failedCount: 0, repos: [] };
  }

  // Step 3b: persist workspaceId immediately after CREATE / rebind / use-flag so retries are idempotent
  if (action === 'create' || action === 'rebind' || action === 'use-flag') {
    try {
      writeProjectCloud(runtime.configPath, project.id, { enabled: true, workspaceId });
    } catch (err) {
      log(`[sync] warning: failed to persist workspaceId: ${(err as Error).message}`);
    }
  }

  // Step 4: per-repo loop
  // File snapshots compose the whole workspace into one immutable object, so a
  // batch costs one build and one stored object no matter how many repositories
  // it carries. Turso mutates a shared graph per repository and has no such
  // composition, so it keeps the per-repository path.
  let batch = false;
  try {
    const workspace = (await remoteGetWorkspace(workspaceId)) as {
      graphBackend?: string;
      capabilities?: { batchResolveTargets?: boolean };
    };
    // Both halves required: the backend says a batch is meaningful, the
    // capability says this server actually understands resolve targets. An
    // older server reports the backend but would run the final resolve
    // targetless — "succeeding" while publishing none of the uploads.
    batch = workspace.graphBackend === 'file_snapshot' && workspace.capabilities?.batchResolveTargets === true;
  } catch (err) {
    log(`[sync] could not read the workspace graph backend (${(err as Error).message}); pushing per repo`);
  }

  const results: RepoSyncResult[] = [];
  for (const repo of project.repos) {
    log(`[sync] repo ${repo.name}:`);
    const result = await syncRepo({
      projectId: project.id,
      repo,
      workspaceId,
      config: runtime,
      force: options.force,
      includeSummaries: options.includeSummaries,
      includeEmbeddings: options.includeEmbeddings,
      defer: true,
      batch,
      api: repoSyncApi,
      log,
    });
    results.push(result);
    if (result.status === 'pushed') log(batch ? `  ✓ uploaded` : `  ✓ pushed`);
    else if (result.status === 'skipped') log(`  ↺ skipped (${result.reason ?? 'up-to-date'})`);
    else if (result.status === 'failed') log(`  ✗ ${result.step}: ${result.error}`);
  }

  const pushedCount = results.filter((r) => r.status === 'pushed').length;
  const skippedCount = results.filter((r) => r.status === 'skipped').length;
  const failedCount = results.filter((r) => r.status === 'failed').length;

  const pushedJobIds = results
    .filter((r): r is RepoSyncOk => r.status === 'pushed' && !!r.jobId)
    .map((r) => r.jobId as string);

  // Step 5: mapper push
  let mapperStatus: RunSyncResult['mapperStatus'];
  let mapperJobId: string | undefined;
  if (options.includeMapper) {
    const { mapperJson } = mapperPathsForProject(runtime.resolvedParserStorage, project.id);
    if (!fs.existsSync(mapperJson)) {
      mapperStatus = 'not-found';
    } else if (pushedCount === 0 && !options.force) {
      log(`[sync] mapper: no repo updates, skipping`);
      mapperStatus = 'skipped';
    } else {
      try {
        log(`[sync] mapper: pushing ${mapperJson}...`);
        // In batch mode the mapper upload must not trigger its own resolve:
        // the batch finalizer below reads the live mapper row, and on a fresh
        // workspace an inline mapper resolve would fail on an empty
        // composition before any repository is published.
        const outcome = await mapperPush({ workspaceId, file: mapperJson, defer: batch });
        if ('status' in outcome && outcome.status === 'publishing') {
          mapperJobId = outcome.jobId;
          mapperStatus = 'publishing';
          log(`[sync] mapper: publishing in background (jobId=${mapperJobId})`);
        } else {
          mapperStatus = 'pushed';
          log(`[sync] mapper: ok`);
        }
      } catch (err) {
        mapperStatus = 'failed';
        log(`[sync] mapper: ✗ ${(err as Error).message} (repos already synced; run \`coredoc mapper push\` to retry)`);
      }
    }
  }

  // Step 5b: one explicit workspace-wide resolve at the end of the batch.
  // Per-repo pushes ran with defer=true so the server skipped resolution
  // each time. This collapses N back-to-back full resolutions into one.
  //
  // Concurrency caveat (PUSH_WORKER_CONCURRENCY > 1): the resolve job is
  // enqueued LAST. With concurrency=1 (default), FIFO ordering guarantees
  // pushes run first. With concurrency>1, the resolve job could be picked
  // up by an idle worker before all pushes finish. The ResolverService's
  // in-process coalescing means a too-early resolve doesn't corrupt data,
  // but its output may not reflect the latest pushes — they'll get resolved
  // on the next sync. If this becomes a real issue, switch to dependsOn
  // semantics on PushJob (worker re-queues resolve until all push jobs
  // for the workspace are terminal).
  const batchTargets = results
    .filter((r): r is RepoSyncOk => r.status === 'pushed' && !!r.batchTarget)
    .map((r) => r.batchTarget as NonNullable<RepoSyncOk['batchTarget']>);
  let resolutionStatus: RunSyncResult['resolutionStatus'];
  let resolveJobId: string | undefined;
  if (pushedCount === 0) {
    resolutionStatus = 'skipped';
  } else {
    try {
      log(batch ? `[sync] publishing the graph for this batch...` : `[sync] resolving cross-repo edges...`);
      const resp = await remoteResolveWorkspace(workspaceId, { targets: batchTargets });
      // Handle both sync (immediate) and async (queued) responses
      if ('jobId' in resp) {
        // Queued response — resolution will run asynchronously. Status is
        // 'queued', NOT 'resolved': only --wait + a successful terminal state
        // can promote it to confirmed-complete. Calling it 'resolved' here
        // would let lastSyncedAt write before any job ran.
        resolveJobId = resp.jobId;
        resolutionStatus = 'queued';
        log(`[sync] resolution: queued (jobId=${resolveJobId})`);
      } else {
        // Sync response — resolution completed immediately. Metrics sit at the
        // top level on Turso and nested under `resolution` on file snapshots
        // (null there means the idempotent no-op fast path).
        resolutionStatus = 'resolved';
        const metrics = 'resolved' in resp ? resp : resp.resolution;
        if (metrics)
          log(`[sync] resolution: ${metrics.resolved}/${metrics.total} (${metrics.legacyEdges} via descriptor)`);
        else log('[sync] resolution: unchanged (composition identical to the active version)');
      }
    } catch (err) {
      // A file_snapshot publication that outlives the server's synchronous
      // budget answers with a structured 504 while the job keeps running. That
      // is pending work, not a failure: treat it exactly like a queued resolve
      // so lastSyncedAt stays put until the job is confirmed terminal. Only the
      // structured code counts — matching '504' text would misfile real errors.
      const structured = parseStructuredServerError(err);
      if (structured?.code === JOB_STILL_RUNNING_CODE && structured.jobId) {
        resolveJobId = structured.jobId;
        resolutionStatus = 'queued';
        log(`[sync] resolution: publishing in background (jobId=${resolveJobId})`);
      } else {
        resolutionStatus = 'failed';
        log(`[sync] resolution: ✗ ${(err as Error).message} (push data already landed; can retry)`);
      }
    }
  }

  // Step 5c: optional --wait polling block
  let waitTimedOut = false;
  let waitJobFailures = 0;
  let waitMissingJobs = 0;
  if (options.wait && (pushedJobIds.length > 0 || resolveJobId || mapperJobId)) {
    const allJobIds = [...pushedJobIds, ...(mapperJobId ? [mapperJobId] : []), ...(resolveJobId ? [resolveJobId] : [])];
    log(`[sync] waiting for ${allJobIds.length} job(s)...`);
    const { pollJobs } = await import('./job-poller.js');
    // 0 = explicit opt-in to unbounded wait (e.g. --wait-timeout 0).
    // undefined = default 60min ceiling so CI can't wedge forever when a job
    // goes missing server-side and pollJobs would otherwise loop indefinitely.
    const explicitTimeout = options.waitTimeoutMs;
    const effectiveTimeout = explicitTimeout === 0 ? undefined : (explicitTimeout ?? DEFAULT_WAIT_TIMEOUT_MS);
    const pollResult = await pollJobs(workspaceId, allJobIds, {
      getJob: remoteGetJob,
      pollIntervalMs: options.waitPollIntervalMs ?? 5000,
      timeoutMs: effectiveTimeout,
    });
    if (pollResult.timedOut) {
      log(
        `[sync] --wait timeout; ${pollResult.terminal.length}/${allJobIds.length} jobs terminal. Check status with: coredoc sync-status <jobId>`,
      );
      waitTimedOut = true;
    } else {
      for (const job of pollResult.terminal) {
        log(
          `[sync] ${job.id} (${job.type}${job.repoName ? ` ${job.repoName}` : ''}): ${job.status}${
            job.lastError ? ` — ${job.lastError}` : ''
          }`,
        );
      }
    }
    waitJobFailures = pollResult.failedJobIds.length;
    waitMissingJobs = pollResult.missingJobIds.length;
    if (waitJobFailures > 0) {
      log(`[sync] ${waitJobFailures} job(s) failed`);
    }
    if (waitMissingJobs > 0) {
      log(`[sync] ${waitMissingJobs} job(s) missing on server (deleted or rolled back)`);
    }
  }

  // Step 6: write lastSyncedAt only on full success.
  //
  // Rules:
  //   - failedCount === 0: no repo upload/upsert errors.
  //   - mapperStatus must not be 'failed'; 'publishing' is pending work and is
  //     treated exactly like a queued resolve (see queuedButUnconfirmed).
  //   - resolutionStatus 'resolved' is fine (sync server-side completion).
  //   - resolutionStatus 'queued' WITHOUT --wait is NOT a confirmed success —
  //     skip the write so we don't lie about completion. The next sync will
  //     recompute the delta from server-side `lastParseHash`, so leaving
  //     lastSyncedAt stale is correct: it reflects the last confirmed sync,
  //     not the last attempted one.
  //   - With --wait: jobs polled to terminal state, no failures, no timeout.
  const queuedButUnconfirmed = (resolutionStatus === 'queued' || mapperStatus === 'publishing') && !options.wait;
  const fullSuccess =
    failedCount === 0 &&
    mapperStatus !== 'failed' &&
    resolutionStatus !== 'failed' &&
    !queuedButUnconfirmed &&
    !waitTimedOut &&
    waitJobFailures === 0 &&
    waitMissingJobs === 0;
  if (fullSuccess) {
    try {
      writeProjectCloud(runtime.configPath, project.id, { lastSyncedAt: new Date().toISOString() });
    } catch (err) {
      log(`[sync] warning: failed to write lastSyncedAt: ${(err as Error).message}`);
    }
  } else if (queuedButUnconfirmed) {
    log(
      `[sync] lastSyncedAt unchanged: jobs queued but not confirmed. Use --wait or \`coredoc sync-status <jobId>\` to verify.`,
    );
  }

  // exitCode reflects every failure path — repos, mapper, resolve, and wait.
  // Without this, CI reports green even when mapper upload or cross-repo
  // resolution failed (and lastSyncedAt above already refuses to advance).
  const exitCode: 0 | 1 =
    failedCount > 0 ||
    mapperStatus === 'failed' ||
    resolutionStatus === 'failed' ||
    waitTimedOut ||
    waitJobFailures > 0 ||
    waitMissingJobs > 0
      ? 1
      : 0;
  log(
    `[sync] summary: pushed=${pushedCount}, skipped=${skippedCount}, failed=${failedCount}` +
      (mapperStatus ? `, mapper=${mapperStatus}` : '') +
      (resolutionStatus ? `, resolve=${resolutionStatus}` : ''),
  );

  return {
    exitCode,
    workspaceId,
    pushedCount,
    skippedCount,
    failedCount,
    repos: results,
    mapperStatus,
    resolutionStatus,
    ...(waitTimedOut ? { waitTimedOut: true } : {}),
    ...(waitJobFailures > 0 ? { waitJobFailures } : {}),
    ...(waitMissingJobs > 0 ? { waitMissingJobs } : {}),
  };
}
