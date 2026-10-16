/**
 * CI Summarize Orchestrator
 *
 * Orchestrates the full CI summarization pipeline:
 * 1. Topological sort (leaf-first)
 * 2. Cache lookup from previous summaries
 * 3. Batch LLM summarization with callee context
 * 4. Repository and package summarization
 */

import type { ParsedRepo, FunctionNode } from '@coredoc/core/types';
import type {
  SummaryOutput,
  FunctionSummary,
  CalleeSummaryContext,
  PackageSummary,
  RepositorySummary,
} from '../summarize/types.js';
import { topologicalSort, type SortedFunction } from '../summarize/topological-sort.js';
import {
  isFallbackFunctionSummary,
  type SummaryLlm,
  summarizeFunction,
  summarizePackages,
  summarizeRepository,
} from './ci-summarizer.js';

import { SUMMARIZER_VERSION } from '../summarize/types.js';

const DEFAULT_BATCH_SIZE = 10;

export interface CiSummarizeOptions {
  parsedRepo: ParsedRepo;
  previousSummaries: SummaryOutput | null;
  /** An AI SDK model, or a local harness's text generator. */
  model: SummaryLlm;
  batchSize?: number;
  verbose?: boolean;
  /** Generate repo/package summaries (default true). Set false for --no-repo-summary. */
  repoSummary?: boolean;
  /** Relax OpenAI strict json_schema for backends that reject it (e.g. local Ollama). */
  strictJsonSchema?: boolean;
  /**
   * Ignore the per-function cache and re-summarize every function (--force).
   * Unlike passing previousSummaries=null, this preserves previousSummaries so
   * carried-forward high-level summaries (under --no-repo-summary) are not lost.
   */
  force?: boolean;
  /**
   * Awaited after every function batch with a checkpoint of the artifact so far
   * (crash recovery for long local runs; also where the caller paces batches).
   */
  onBatch?: (checkpoint: SummaryOutput) => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(message: string): void {
  process.stderr.write(`[coredoc-ci] ${message}\n`);
}

/**
 * Look up callee summaries from the summary map for a given set of callee IDs.
 */
export function getCalleeSummaries(
  calleeIds: string[],
  summaryMap: Map<string, FunctionSummary>,
  fnMap: Map<string, FunctionNode>,
): CalleeSummaryContext[] {
  const contexts: CalleeSummaryContext[] = [];

  for (const calleeId of calleeIds) {
    const summary = summaryMap.get(calleeId);
    const fn = fnMap.get(calleeId);
    if (!summary || !fn) continue;

    contexts.push({
      functionId: fn.id,
      functionName: fn.name,
      purpose: summary.purpose,
      side_effects: summary.side_effects.map((se) => ({
        ...se,
        isDirect: false, // mark as indirect when used as callee context
      })),
    });
  }

  return contexts;
}

/**
 * Build ordered summaries from the summary map following topological order.
 */
export function buildOrderedSummaries(
  summaryMap: Map<string, FunctionSummary>,
  sorted: SortedFunction[],
): FunctionSummary[] {
  const result: FunctionSummary[] = [];

  for (const sf of sorted) {
    const summary = summaryMap.get(sf.function.id);
    if (summary) {
      result.push(summary);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full CI summarization pipeline.
 *
 * - Sorts functions leaf-first via topological sort
 * - Reuses cached summaries when versionedId matches
 * - Batch-processes new/changed functions with callee context
 * - Regenerates repo/package summaries when anything changed
 */
export async function ciSummarize(options: CiSummarizeOptions): Promise<SummaryOutput> {
  const { parsedRepo, previousSummaries, model, strictJsonSchema } = options;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const wantRepoSummary = options.repoSummary !== false;
  const force = options.force ?? false;
  const startTime = Date.now();
  const buildOutput = (
    summaries: FunctionSummary[],
    stats: { skippedCached: number; summarized: number; failedSummarization: number },
    repositorySummary: RepositorySummary | undefined,
    packageSummaries: PackageSummary[] | undefined,
  ): SummaryOutput => ({
    repoId: parsedRepo.id,
    repoName: parsedRepo.name,
    generatedAt: new Date().toISOString(),
    summarizerVersion: SUMMARIZER_VERSION,
    summaries,
    stats: { totalFunctions: sorted.length, ...stats, processingTimeMs: Date.now() - startTime },
    repositorySummary,
    packageSummaries,
  });

  // Step 1: Topological sort
  log(`Sorting ${parsedRepo.functions.length} functions...`);
  const { sorted } = topologicalSort(parsedRepo.functions, parsedRepo.calls);

  // Build function lookup map
  const fnMap = new Map<string, FunctionNode>();
  for (const fn of parsedRepo.functions) {
    fnMap.set(fn.id, fn);
  }

  // Step 2: Build cache from previous summaries
  const previousByVersionedId = new Map<string, FunctionSummary>();
  if (previousSummaries) {
    for (const s of previousSummaries.summaries) {
      previousByVersionedId.set(s.versionedId, s);
    }
  }

  // Step 3: Determine what needs processing
  const summaryMap = new Map<string, FunctionSummary>();
  const toProcess: SortedFunction[] = [];

  let skippedNoSource = 0;
  for (const sf of sorted) {
    // A synthesized node (e.g. a Ruby association reader minted from `has_many`) has no body —
    // summarizing it bills an LLM call for a fabricated description of code that does not exist.
    if (sf.function.synthesized) continue;
    // Same for a declared function parsed without source: the prompt would carry no body and the
    // model would invent one. `force` ignores the cache, not the absence of a body.
    if (!sf.function.sourceCode?.trim()) {
      skippedNoSource++;
      continue;
    }
    const cached = force ? undefined : previousByVersionedId.get(sf.function.versionedId);
    // A cached fallback (LLM-failure placeholder from an earlier run's
    // artifact) must not satisfy the cache — it would pin the failure until
    // the function's source changes. Re-process it instead.
    if (cached && !isFallbackFunctionSummary(cached)) {
      summaryMap.set(sf.function.id, cached);
    } else {
      toProcess.push(sf);
    }
  }

  const skippedSynthesized = sorted.filter((sf) => sf.function.synthesized).length;
  const skippedCached = sorted.length - toProcess.length - skippedSynthesized - skippedNoSource;
  log(
    `Cache: ${skippedCached} cached, ${toProcess.length} to process` +
      (skippedSynthesized > 0 ? `, ${skippedSynthesized} synthesized (no body, skipped)` : '') +
      (skippedNoSource > 0 ? `, ${skippedNoSource} without source code (skipped)` : ''),
  );
  // Repeated at the end of the run: the up-front cache line scrolls away behind the batches.
  const logNoSourceSkip = (): void => {
    if (skippedNoSource === 0) return;
    log(
      `Skipped (no source code): ${skippedNoSource} — the parser build that produced this output captured ` +
        `no source for these functions — re-parse with the current build`,
    );
  };

  // Step 4: If no functions changed, skip function summarization — but still
  // backfill a high-level summary that is MISSING (e.g. a prior run used
  // --no-repo-summary, or its repo-summary attempt failed). This mirrors the
  // default summarize path, which regenerates only what is missing when all
  // functions are cached. A present summary is carried forward untouched.
  if (toProcess.length === 0) {
    log('All functions cached — skipping function summarization');
    logNoSourceSkip();
    const summaries = buildOrderedSummaries(summaryMap, sorted);

    let repositorySummary = previousSummaries?.repositorySummary;
    let packageSummaries = previousSummaries?.packageSummaries;

    if (wantRepoSummary) {
      if (!repositorySummary) {
        log('Backfilling missing repository summary...');
        try {
          repositorySummary = await summarizeRepository(parsedRepo, summaries, model, strictJsonSchema);
        } catch (error) {
          log(`Repository summary failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const missingPackages =
        parsedRepo.packages.length > 1 && (!packageSummaries || packageSummaries.length < parsedRepo.packages.length);
      if (missingPackages) {
        log('Backfilling missing package summaries...');
        try {
          packageSummaries = await summarizePackages(parsedRepo, summaries, model, strictJsonSchema);
        } catch (error) {
          log(`Package summaries failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    return buildOutput(
      summaries,
      { skippedCached, summarized: 0, failedSummarization: 0 },
      repositorySummary,
      packageSummaries,
    );
  }

  // Step 5: Batch-process functions
  let failedCount = 0;
  for (let i = 0; i < toProcess.length; i += batchSize) {
    const batch = toProcess.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(toProcess.length / batchSize);
    log(`Batch ${batchNum}/${totalBatches}: summarizing ${batch.length} functions...`);

    const results = await Promise.all(
      batch.map(async (sf) => {
        const calleeSummaries = getCalleeSummaries(sf.calleeIds, summaryMap, fnMap);
        return summarizeFunction(sf.function, calleeSummaries, model, strictJsonSchema);
      }),
    );

    // Update summary map after batch so later batches have context
    for (let j = 0; j < batch.length; j++) {
      const result = results[j];
      // A fallback (summarizeFunction never throws) never enters summaryMap:
      // from there it would leak "summarization failed" text into later
      // batches' callee context, land in the artifact as a real summary, and
      // — read back as the next run's cache — pin the failure until the
      // function's source changes. Absent from the map, the callee is simply
      // skipped from context (the same path as a callee with no summary) and
      // the function stays eligible for the next run.
      if (isFallbackFunctionSummary(result)) {
        failedCount++;
        if (options.verbose) log(`Failed ${batch[j].function.name}: ${result.unknowns[0]}`);
        continue;
      }
      summaryMap.set(batch[j].function.id, result);
    }

    await options.onBatch?.(
      buildOutput(
        buildOrderedSummaries(summaryMap, sorted),
        { skippedCached, summarized: i + batch.length - failedCount, failedSummarization: failedCount },
        previousSummaries?.repositorySummary,
        previousSummaries?.packageSummaries,
      ),
    );
  }

  // Step 6: Build ordered summaries (fallbacks never entered summaryMap)
  const summaries = buildOrderedSummaries(summaryMap, sorted);

  // Step 7: Regenerate repo/package summaries (skipped when repoSummary === false,
  // in which case any previous high-level summaries are carried forward).
  let repositorySummary: RepositorySummary | undefined;
  let packageSummaries: PackageSummary[] | undefined;

  if (wantRepoSummary) {
    log('Generating repository summary...');
    try {
      repositorySummary = await summarizeRepository(parsedRepo, summaries, model, strictJsonSchema);
    } catch (error) {
      log(`Repository summary failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (parsedRepo.packages.length > 1) {
      log(`Generating package summaries for ${parsedRepo.packages.length} packages...`);
      try {
        packageSummaries = await summarizePackages(parsedRepo, summaries, model, strictJsonSchema);
      } catch (error) {
        log(`Package summaries failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else {
    repositorySummary = previousSummaries?.repositorySummary;
    packageSummaries = previousSummaries?.packageSummaries;
  }

  // Step 8: Return result
  log(
    `Done: ${toProcess.length - failedCount} summarized, ${failedCount} failed, ${skippedCached} cached (${Date.now() - startTime}ms)`,
  );
  logNoSourceSkip();

  return buildOutput(
    summaries,
    { skippedCached, summarized: toProcess.length - failedCount, failedSummarization: failedCount },
    repositorySummary,
    packageSummaries,
  );
}
