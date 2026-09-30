/**
 * CI Run Command
 *
 * Single command that encapsulates the full CI/CD automation flow:
 *   1. Authenticate with service token
 *   2. Load a checked-in profile or fetch the workspace parser
 *   3. Parse the local repo checkout
 *   4. Push results to cloud workspace
 *
 * Required environment variables:
 *   COREDOC_TOKEN        — Service token (cdt_...) with parser:read + result:write + repo:push permissions
 *                          Add result:read as well when summary caching is enabled.
 *   COREDOC_WORKSPACE_ID — Target workspace ID (can be overridden via --workspace-id flag)
 *
 * Optional parser source:
 *   COREDOC_PROFILE_PATH — checked-in profile.ts (or pass --profile); no cloud parser needed.
 *
 * Usage:
 *   COREDOC_TOKEN=cdt_xxx COREDOC_WORKSPACE_ID=abc npx @coredoc/cli ci run -r backend
 */

import * as fs from 'fs';
import { createHash } from 'node:crypto';
import * as path from 'path';
import { config as dotenvConfig } from 'dotenv';
import { resolveCoredocHome } from '@coredoc/core/utils';
import { initTelemetry } from '@coredoc/core/telemetry';
import { BUNDLED_POSTHOG_KEY, BUNDLED_POSTHOG_HOST } from '../build-env.js';
import { pullParserFromServer } from '../parser-remote.js';
import { parseRepoArtifact } from '../parse-repo.js';
import {
  uploadResult,
  pushByVersion,
  fetchSummaries,
  uploadSummaries,
  waitForPushJob,
  queuedPushJobId,
  PushJobTimeoutError,
} from '../push/remote.js';
import { ciSummarize } from './ci-summarize-orchestrator.js';
import { createModel } from './llm-config.js';
import { ciGitContextFromEnv, applyCiGitContext } from './git-context.js';
import type { SummaryOutput } from '../summarize/types.js';
import { reusePreviousIfUnchanged } from '../summarize/artifact-identity.js';

// Load .env from multiple locations (first found wins for each var).
// Priority: existing env > .env in cwd > <coredoc home>/.env
function loadEnvFiles(): void {
  const locations = [path.join(process.cwd(), '.env'), path.join(resolveCoredocHome(), '.env')];
  for (const envPath of locations) {
    if (fs.existsSync(envPath)) {
      dotenvConfig({ path: envPath, override: false }); // override:false = don't overwrite existing
    }
  }
}

// =============================================================================
// Types
// =============================================================================

export interface CiRunOptions {
  repo: string;
  config?: string;
  /** A checked-in profile.ts; bypasses the cloud parser download for fresh setup. */
  profile?: string;
  workspaceId?: string;
  serverUrl?: string;
  output?: string;
  includeSummaries?: boolean;
  includeEmbeddings?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  /**
   * How long to watch the queued push job before giving up on watching it (the
   * job itself keeps running server-side). Default 15 minutes.
   */
  pushTimeoutMs?: number;
}

export interface CiRunResult {
  status: 'success' | 'error';
  repo: string;
  nodes?: number;
  edges?: number;
  files?: number;
  functions?: number;
  parserVersion?: string;
  summaryStats?: { summarized: number; cached: number; failed: number };
  branch?: string;
  prNumber?: number;
  error?: string;
}

// =============================================================================
// Main CI Run
// =============================================================================

export async function runCi(options: CiRunOptions): Promise<CiRunResult> {
  loadEnvFiles();

  // Configure the shared telemetry client for the headless CI surface with the
  // CLI's bundled anon key (baked into build-env.ts at release-build time; empty
  // in dev ⇒ no-op). `ci run` reaches here through the Commander entry, whose
  // init already ran; re-initializing before any `track` fires just stamps
  // surface: 'ci'. Lazy + idempotent — channels build on first emit and a
  // runtime COREDOC_POSTHOG_* env still wins inside the channel.
  initTelemetry({
    surface: 'ci',
    channels: { posthogKey: BUNDLED_POSTHOG_KEY, posthogHost: BUNDLED_POSTHOG_HOST },
  });

  const startTime = Date.now();

  // Step 1: Validate required env vars / flags
  const workspaceId = options.workspaceId || process.env.COREDOC_WORKSPACE_ID;
  if (!workspaceId) {
    throw new Error('Missing workspace ID. Set COREDOC_WORKSPACE_ID env var or pass --workspace-id flag.');
  }

  const token = process.env.COREDOC_TOKEN;
  if (!token) {
    throw new Error('Missing auth token. Set COREDOC_TOKEN env var with a service token (cdt_...).');
  }

  if (options.serverUrl) {
    process.env.COREDOC_SERVER_URL = options.serverUrl;
  }

  const repoName = options.repo;
  const outputDir = path.resolve(options.output ?? '.coredoc-ci');
  const parserStorageDir = path.join(outputDir, 'parsers');

  log(`Coredoc CI — repo: ${repoName}, workspace: ${workspaceId}`);

  // Step 2: Stage the source for the existing typechecked profile loader.
  const profilePath = options.profile || process.env.COREDOC_PROFILE_PATH;
  // CI parsers are scoped to the 'ci' pseudo-project
  const CI_PROJECT_ID = 'ci';
  // pullParserFromServer extracts to {parserStorageDir}/{repoName}/ (flat layout).
  // loadParser expects {parserStorageDir}/{projectId}/{repoName}/ (nested layout).
  // So we pull into a temp dir and then rename into the nested location.
  const parserPullDir = path.join(parserStorageDir, '__pull_tmp');
  const parserNestedDir = path.join(parserStorageDir, CI_PROJECT_ID);

  let parserVersion: string;
  try {
    const nestedRepoDir = path.join(parserNestedDir, repoName);
    fs.mkdirSync(parserNestedDir, { recursive: true });
    if (profilePath) {
      const source = fs.readFileSync(path.resolve(profilePath));
      fs.rmSync(nestedRepoDir, { recursive: true, force: true });
      fs.mkdirSync(nestedRepoDir, { recursive: true });
      fs.writeFileSync(path.join(nestedRepoDir, 'profile.ts'), source);
      parserVersion = createHash('sha256').update(source).digest('hex').slice(0, 16);
      log(`Using repository profile ${profilePath} (v${parserVersion})`);
    } else {
      log('Fetching parser from workspace...');
      const result = await pullParserFromServer({ workspaceId, repoName, targetDir: parserPullDir });
      parserVersion = result.version;
      log(`Parser fetched (v${parserVersion})`);
      fs.rmSync(nestedRepoDir, { recursive: true, force: true });
      fs.renameSync(path.join(parserPullDir, repoName), nestedRepoDir);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`Failed to prepare parser: ${message}`);
    return toResult({ status: 'error', repo: repoName, error: message });
  }

  // Step 3: Parse repo
  log('Parsing repository...');
  const repoRoot = process.cwd();

  try {
    // Same parse implementation as `coredoc parse` and the SDK. A publish must
    // not carry a semantic blackout, so CI opts into the refusal (`--dry-run`
    // still produces inspectable basic output).
    const parsedRepo = await parseRepoArtifact({
      parserStorage: parserStorageDir,
      projectId: CI_PROJECT_ID,
      repoName,
      repoRoot,
      refuseSemanticBlackout: !options.dryRun,
      warn: log,
    });

    // GitHub Actions PR checkouts are detached-HEAD, so overlay branch/PR/SHA
    // from the Actions env over whatever the checkout's git reported.
    const ciGit = ciGitContextFromEnv(process.env);
    const effectiveGit = applyCiGitContext(parsedRepo.git, ciGit);
    if (effectiveGit) {
      parsedRepo.git = effectiveGit;
    }

    log(`Parsed: ${parsedRepo.files.length} files, ${parsedRepo.functions.length} functions`);

    // Write parsed output to temp dir (useful for debugging)
    const parsedOutputPath = path.join(outputDir, `${repoName}.json`);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(parsedOutputPath, JSON.stringify(parsedRepo));

    // Step 3b: Summarize (optional, requires LLM API key)
    let summaryOutput: SummaryOutput | null = null;
    let summaryVersion: string | undefined;
    // Declared out here so the upload step can compare against it (see below).
    let previousSummaries: SummaryOutput | null = null;

    if (process.env.COREDOC_LLM_API_KEY) {
      log('Fetching previous summaries...');
      try {
        previousSummaries = await fetchSummaries({ workspaceId, repoName });
        log(
          previousSummaries
            ? `Previous summaries: ${previousSummaries.summaries.length} functions`
            : 'No previous summaries found',
        );
      } catch (error) {
        log(`Warning: could not fetch previous summaries: ${error instanceof Error ? error.message : String(error)}`);
      }

      const model = createModel({
        provider: process.env.COREDOC_LLM_PROVIDER || 'openrouter',
        apiKey: process.env.COREDOC_LLM_API_KEY,
        model: process.env.COREDOC_LLM_MODEL || 'anthropic/claude-haiku-4-5-20251001',
      });

      try {
        summaryOutput = await ciSummarize({
          parsedRepo,
          previousSummaries,
          model,
          verbose: options.verbose,
        });
        log(`Summarized: ${summaryOutput.stats.summarized} new, ${summaryOutput.stats.skippedCached} cached`);
      } catch (error) {
        logError(`Summarization failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (options.dryRun) {
      log('[DRY RUN] Skipping push.');
      return toResult({
        status: 'success',
        repo: repoName,
        files: parsedRepo.files.length,
        functions: parsedRepo.functions.length,
        parserVersion,
      });
    }

    // Step 4: Upload result to R2 + push by version (incremental)
    log('Uploading result and pushing to workspace...');
    const uploadResp = await uploadResult({ workspaceId, repoName, parsedRepo });
    log(`Result uploaded: version=${uploadResp.version}, duplicate=${uploadResp.duplicate}`);

    // Upload summaries if generated. The artifact is content-addressed server-side,
    // so it is uploaded WITHOUT this run's `generatedAt`/`stats` when the summaries
    // themselves are unchanged — otherwise a run that summarized nothing still minted
    // a new version, re-uploading the whole artifact and leaving the push unable to
    // recognise a no-op. The stats reported above and in the run result stay this
    // run's own.
    if (summaryOutput && !options.dryRun) {
      try {
        const summaryUpload = await uploadSummaries({
          workspaceId,
          repoName,
          summaryOutput: reusePreviousIfUnchanged(summaryOutput, previousSummaries),
        });
        summaryVersion = summaryUpload.version;
        log(`Summaries uploaded: version=${summaryVersion}`);
      } catch (error) {
        logError(`Summary upload failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Enqueue + poll, never an open connection: an inline (?sync) push holds the
    // HTTP request for the whole graph write, which proxies cut long before the
    // server finishes — CI then failed a push that had actually landed, and the
    // retry collided with the repo lease.
    const pushResponse = await pushByVersion({
      workspaceId,
      repoName,
      parsedVersion: uploadResp.version,
      summaryVersion,
      commitSha: parsedRepo.git?.commitHash,
    });
    const pushJobId = queuedPushJobId(pushResponse);
    if (pushJobId) {
      log(`Push queued (jobId=${pushJobId}); waiting for it to finish...`);
      const job = await waitForPushJob(workspaceId, pushJobId, { timeoutMs: options.pushTimeoutMs });
      log(`Push job ${job.id}: ${job.status}`);
    }

    const durationMs = Date.now() - startTime;
    log(`Done in ${durationMs}ms`);

    const result: CiRunResult = {
      status: 'success',
      repo: repoName,
      nodes: parsedRepo.functions.length + parsedRepo.classes.length + parsedRepo.files.length,
      edges: parsedRepo.externalCalls?.length ?? 0,
      files: parsedRepo.files.length,
      functions: parsedRepo.functions.length,
      parserVersion,
      branch: parsedRepo.git?.branch !== 'HEAD' ? parsedRepo.git?.branch : undefined,
      prNumber: ciGit.prNumber,
      ...(summaryOutput && {
        summaryStats: {
          summarized: summaryOutput.stats.summarized,
          cached: summaryOutput.stats.skippedCached,
          failed: summaryOutput.stats.failedSummarization,
        },
      }),
    };

    // Print structured output to stdout (machine-readable)
    console.log(JSON.stringify(result));

    // Cleanup temp files only on success
    try {
      if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true, force: true });
      }
    } catch {
      // Non-fatal: cleanup failure in CI is OK
    }

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A timed-out watch is inconclusive, not a failed push — the job keeps running.
    if (error instanceof PushJobTimeoutError) {
      logError(`Push not confirmed within the watch window: ${message}`);
    } else {
      logError(`Parse/push failed: ${message}`);
    }
    logError(`Output preserved for debugging at: ${outputDir}`);
    return toResult({ status: 'error', repo: repoName, error: message });
  }
}

// =============================================================================
// Helpers
// =============================================================================

/** Log to stderr (keeps stdout clean for machine-readable output). */
function log(message: string): void {
  process.stderr.write(`[coredoc-ci] ${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`[coredoc-ci] ERROR: ${message}\n`);
}

function toResult(result: CiRunResult): CiRunResult {
  if (result.status === 'error') {
    // Also print to stdout for machine consumption
    console.log(JSON.stringify(result));
  }
  return result;
}
