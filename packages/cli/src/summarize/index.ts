/**
 * Summarize Command Implementation
 *
 * Generates AI-powered summaries using topological sort
 * to ensure callee summaries are available when processing callers.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ParsedRepo, FunctionNode } from '@coredoc/core/types';
import { RuntimeConfig } from '@coredoc/core/types';
import { parsedRepoFile, summariesFile } from '@coredoc/core/utils';
import { SummaryOutput, FunctionSummary, CalleeSummaryContext, RepositorySummary, SummaryStats } from './types.js';
import { reusePreviousIfUnchanged } from './artifact-identity.js';
import { topologicalSort, SortedFunction } from './topological-sort.js';
import { FunctionSummarizer } from './summarizer.js';
import { RepositorySummarizer } from './repository-summarizer.js';
import { PackageSummarizer, PackageSummary } from './package-summarizer.js';
import { trackOperation } from '../operations-tracker.js';
import { createModel, preflightModel, LlmProvider, type LlmConfig } from '../ci/llm-config.js';
import { ciSummarize } from '../ci/ci-summarize-orchestrator.js';
import { bindProjectDatabase } from '../db-scope.js';

export { SUMMARIZER_VERSION } from './types.js';
import { SUMMARIZER_VERSION } from './types.js';
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_DELAY_MS = 100;
/** Width the single-line progress bar is padded to, so shorter refreshes fully clear the previous line. */
const PROGRESS_LINE_WIDTH = 60;
/**
 * The one real cause of a missing body: the parser build that produced the artifact captured no
 * source for those nodes (a substrate gap). Source is always captured otherwise — it is stripped
 * only at the remote-push boundary, never in the local artifact the summarizer reads.
 * (Duplicated verbatim in ci/ci-summarize-orchestrator.ts — importing it from here would close an
 * import cycle, since this module imports that one.)
 */
const NO_SOURCE_HINT =
  'the parser build that produced this output captured no source for these functions — ' +
  're-parse with the current build';

/**
 * Format an estimated-time-remaining value for progress output.
 * Shows seconds under a minute, whole minutes above — the summarize run is
 * long enough that minute granularity is what the user actually reads.
 */
function formatEta(ms: number): string {
  const totalSec = Math.max(1, Math.round(ms / 1000));
  if (totalSec < 60) return `~${totalSec}s left`;
  return `~${Math.round(totalSec / 60)} min left`;
}

/**
 * Options for the summarize command
 */
export interface SummarizeOptions {
  /** Config path */
  config: string;
  /** Project id (workspace) */
  projectId: string;
  /** Repo name or path to parsed JSON file */
  repo: string;
  /** Batch size for parallel processing */
  batchSize?: number;
  /** Delay between batches in ms (for rate limiting) */
  delay?: number;
  /** Force re-summarization (ignore cache) */
  force?: boolean;
  /** Verbose output */
  verbose?: boolean;
  /** Dry run - show what would be processed */
  dryRun?: boolean;
  /** Model override (defaults to haiku for the Claude Code path; required when provider is set) */
  model?: string;
  /**
   * LLM provider: anthropic | openai | openrouter | ollama (an {@link LlmProvider} value).
   * Omit to use the default local Claude Code subprocess path (no API key).
   * When set, summarization routes through the provider-agnostic AI SDK pipeline.
   */
  provider?: string;
  /** API key for the LLM provider (falls back to COREDOC_LLM_API_KEY). Not needed for ollama. */
  apiKey?: string;
  /** Override provider base URL, e.g. a remote Ollama host (falls back to OLLAMA_BASE_URL for ollama). */
  baseURL?: string;
  /** Generate repository-level summary after function summaries */
  repoSummary?: boolean;
  /** Working directory for SDK subprocess (scopes file access) */
  cwd?: string;
  /** Path to Claude Code CLI executable (for packaged app) */
  claudeCodeCliPath?: string;
  /** Node executable for SDK subprocess (for packaged app) */
  sdkExecutable?: string;
  /** Environment variables for SDK subprocess (for packaged app) */
  sdkEnv?: NodeJS.ProcessEnv;
  /** Selected local harness (desktop Settings or COREDOC_HARNESS_PROVIDER). Omit for the Claude Code default. */
  harness?: 'claude-code' | 'codex';
  /** Path to a system Codex executable (required for the codex harness). */
  codexCliPath?: string;
}

/**
 * Run the summarize command
 */
export async function runSummarize(options: SummarizeOptions, config: RuntimeConfig): Promise<void> {
  const startTime = Date.now();
  const verbose = options.verbose ?? false;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const delay = options.delay ?? DEFAULT_DELAY_MS;

  // 1. Find and load parsed repo JSON
  const parsedRepoPath =
    options.repo.endsWith('.json') && fs.existsSync(options.repo)
      ? options.repo
      : options.projectId
        ? parsedRepoFile(config.resolvedOutputDir, options.projectId, options.repo)
        : undefined;
  if (!parsedRepoPath || !fs.existsSync(parsedRepoPath)) {
    throw new Error(`Parsed repo not found for: ${options.repo}. Run 'coredoc parse' first.`);
  }

  console.log(`\nLoading parsed repo from: ${parsedRepoPath}`);
  const parsedRepo: ParsedRepo = JSON.parse(fs.readFileSync(parsedRepoPath, 'utf-8'));

  // 2. Load existing summaries (for caching)
  const summaryOutputPath = options.projectId
    ? summariesFile(config.resolvedOutputDir, options.projectId, parsedRepo.name)
    : path.join(path.dirname(parsedRepoPath), `${parsedRepo.name}-summaries.json`);

  const existingSummaries = loadExistingSummaries(summaryOutputPath);
  const existingVersionMap = buildVersionMap(existingSummaries);

  if (verbose && existingSummaries) {
    console.log(`  Existing summaries found: ${existingSummaries.summaries.length} items`);
  }

  // 3. Topological sort
  console.log(`\nSorting ${parsedRepo.functions.length} items by call graph...`);
  const { sorted, cyclicFunctions } = topologicalSort(parsedRepo.functions, parsedRepo.calls);

  if (cyclicFunctions.size > 0) {
    console.log(`  Warning: ${cyclicFunctions.size} items involved in call cycles`);
    if (verbose) {
      const cyclicNames = [...cyclicFunctions]
        .map((id) => parsedRepo.functions.find((f) => f.id === id)?.name)
        .filter(Boolean);
      console.log(`    Cyclic: ${cyclicNames.slice(0, 5).join(', ')}${cyclicNames.length > 5 ? '...' : ''}`);
    }
  }

  // 4. Filter items needing summarization.
  // A synthesized node (e.g. a Ruby association reader minted from `has_many`) has no body:
  // summarizing it is a paid LLM call whose only input is the signature, and whose output is a
  // fabricated description of code that does not exist. The same holds for a declared function
  // whose `sourceCode` is absent — a parse run without source, or a substrate that failed to
  // capture it. Both are excluded before --force, which is about ignoring the cache, not about
  // summarizing bodies there are none of.
  const synthesizedSkipped = sorted.filter((sf) => sf.function.synthesized).length;
  const summarizable = sorted.filter((sf) => !sf.function.synthesized && !!sf.function.sourceCode?.trim());
  // A source-less function is dropped from the carried-forward summary map too: no placeholder,
  // no versionedId entry in the written artifact, so the next run after a parse WITH sources sees
  // it as unsummarized rather than cached.
  const noSourceIds = new Set(
    sorted.filter((sf) => !sf.function.synthesized && !sf.function.sourceCode?.trim()).map((sf) => sf.function.id),
  );
  const noSourceSkipped = noSourceIds.size;
  const carryForwardFunctions = parsedRepo.functions.filter((fn) => !noSourceIds.has(fn.id));
  const itemsToProcess = options.force
    ? summarizable
    : summarizable.filter((sf) => needsSummarization(sf.function, existingVersionMap));

  console.log(`\nItems to summarize: ${itemsToProcess.length} / ${sorted.length}`);
  console.log(`  Cached (skipped): ${summarizable.length - itemsToProcess.length}`);
  if (synthesizedSkipped > 0) {
    console.log(`  Synthesized, no body (skipped): ${synthesizedSkipped}`);
  }
  // Repeated in the final block: this line scrolls away behind the batch progress.
  const printNoSourceSkip = (): void => {
    if (noSourceSkipped === 0) return;
    console.log(`  Skipped (no source code): ${noSourceSkipped} — ${NO_SOURCE_HINT}`);
  };
  if (noSourceSkipped > 0) {
    console.log(`  No source code (skipped): ${noSourceSkipped} — ${NO_SOURCE_HINT}`);
  }

  if (options.dryRun) {
    console.log('\n[DRY RUN] Would process:');
    if (options.provider) {
      const dryModel = options.model ?? process.env.COREDOC_LLM_MODEL ?? '(model required)';
      console.log(`  Provider: ${options.provider}, model: ${dryModel}`);
    }
    const sample = itemsToProcess.slice(0, 20);
    for (const sf of sample) {
      const depthLabel = sf.depth >= 0 ? `depth: ${sf.depth}` : 'cyclic';
      console.log(`  - ${sf.function.name} (${depthLabel}, callees: ${sf.calleeIds.length})`);
    }
    if (itemsToProcess.length > 20) {
      console.log(`  ... and ${itemsToProcess.length - 20} more`);
    }
    return;
  }

  // Public SDK callers do not pass through the Commander wrapper. Establish
  // the project-owned operations database before either summarize path calls
  // trackOperation.
  await bindProjectDatabase(config, options.projectId);

  // Check if repo summary is needed
  const needsRepoSummary = options.repoSummary && !existingSummaries?.repositorySummary;
  const needsPackageSummaries =
    options.repoSummary &&
    parsedRepo.packages.length > 1 &&
    (!existingSummaries?.packageSummaries || existingSummaries.packageSummaries.length < parsedRepo.packages.length);

  if (itemsToProcess.length === 0 && !needsRepoSummary && !needsPackageSummaries) {
    console.log('\nAll items are cached. Nothing to summarize.');
    if (options.repoSummary && existingSummaries?.repositorySummary) {
      console.log(`  Repository summary already exists.`);
    }
    if (options.repoSummary && existingSummaries?.packageSummaries) {
      console.log(`  Package summaries already exist.`);
    }
    console.log(`  Use --force to re-summarize all.`);
    return;
  }

  // Provider-selected path: route through the provider-agnostic AI SDK pipeline
  // (reuses ciSummarize). Without --provider we fall through to the default Claude
  // Code subprocess path below (subscription auth, no API key).
  if (options.provider) {
    await runProviderSummarize({
      options,
      parsedRepo,
      summaryOutputPath,
      existingSummaries,
      verbose,
      batchSize,
    });
    return;
  }

  // Track the entire summarization workflow (batching + output write) as one operation
  await trackOperation(
    options.projectId,
    parsedRepo.name,
    'summarize',
    async () => {
      // If all cached but repo/package summary needed, skip to summary generation
      if (itemsToProcess.length === 0 && (needsRepoSummary || needsPackageSummaries)) {
        console.log('\nAll items are cached. Generating missing summaries...');
        const summaryMap = buildValidSummaryMap(existingSummaries, carryForwardFunctions);
        const finalSummaries = buildFinalSummaries(summaryMap, sorted);

        // Carry forward existing summaries; only regenerate what's missing
        let repositorySummary: RepositorySummary | undefined = existingSummaries?.repositorySummary;
        if (needsRepoSummary) {
          try {
            const repoSummarizer = new RepositorySummarizer({
              model: options.model,
              verbose,
              cwd: options.cwd,
              claudeCodeCliPath: options.claudeCodeCliPath,
              harness: options.harness,
              codexCliPath: options.codexCliPath,
              sdkExecutable: options.sdkExecutable,
              sdkEnv: options.sdkEnv,
            });
            repositorySummary = await repoSummarizer.summarize(parsedRepo, finalSummaries);
            console.log('  ✓ Repository summary generated');
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(`  ✗ Repository summary failed: ${msg}`);
            // Keep existing repositorySummary if regeneration fails
          }
        }

        // Generate package summaries for monorepos (only if missing)
        let packageSummaries: PackageSummary[] | undefined = existingSummaries?.packageSummaries;
        if (needsPackageSummaries) {
          try {
            const pkgSummarizer = new PackageSummarizer({
              model: options.model,
              verbose,
              cwd: options.cwd,
              claudeCodeCliPath: options.claudeCodeCliPath,
              harness: options.harness,
              codexCliPath: options.codexCliPath,
              sdkExecutable: options.sdkExecutable,
              sdkEnv: options.sdkEnv,
            });
            packageSummaries = await pkgSummarizer.summarize(parsedRepo, finalSummaries);
            console.log(`  ✓ Package summaries generated (${packageSummaries.length} packages)`);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(`  ✗ Package summaries failed: ${msg}`);
            // Keep existing packageSummaries (if any) on failure
          }
        }

        // Write output preserving all summaries. As on the final path, the
        // reported numbers are this run's while the artifact may be the previous
        // one kept verbatim.
        const runStats: SummaryStats = {
          totalFunctions: parsedRepo.functions.length,
          summarized: 0,
          skippedCached: sorted.length,
          failedSummarization: 0,
          processingTimeMs: Date.now() - startTime,
        };

        const output: SummaryOutput = reusePreviousIfUnchanged(
          {
            repoId: parsedRepo.id,
            repoName: parsedRepo.name,
            generatedAt: new Date().toISOString(),
            summarizerVersion: SUMMARIZER_VERSION,
            summaries: finalSummaries,
            stats: runStats,
            ...(repositorySummary && { repositorySummary }),
            ...(packageSummaries && { packageSummaries }),
          },
          existingSummaries,
        );

        fs.writeFileSync(summaryOutputPath, JSON.stringify(output, null, 2));

        console.log('\n' + '='.repeat(50));
        console.log('Summary Generation Complete');
        console.log('='.repeat(50));
        console.log(`  Total items: ${runStats.totalFunctions}`);
        console.log(`  Cached (skipped): ${runStats.skippedCached}`);
        printNoSourceSkip();
        console.log(`  Time: ${(runStats.processingTimeMs / 1000).toFixed(1)}s`);
        console.log(`  Output: ${summaryOutputPath}`);
        if (repositorySummary) {
          console.log(`  Repository summary: ✓`);
        }
        if (packageSummaries) {
          console.log(`  Package summaries: ✓ (${packageSummaries.length} packages)`);
        }
        console.log('');
        return;
      }

      // 5. Initialize the selected local harness summarizer.
      const summarizer = new FunctionSummarizer({
        model: options.model,
        verbose,
        cwd: options.cwd,
        claudeCodeCliPath: options.claudeCodeCliPath,
        harness: options.harness,
        codexCliPath: options.codexCliPath,
        sdkExecutable: options.sdkExecutable,
        sdkEnv: options.sdkEnv,
      });

      // 6. Process items in batches
      const newSummaries: FunctionSummary[] = [];
      const summaryMap = buildValidSummaryMap(existingSummaries, carryForwardFunctions);

      let processedCount = 0;
      let failedCount = 0;
      const totalBatches = Math.ceil(itemsToProcess.length / batchSize);

      console.log(`\nProcessing ${itemsToProcess.length} items in ${totalBatches} batches...`);

      // Each SDK query() spawns a subprocess that registers an exit listener on process.
      // With batchSize concurrent calls, this exceeds the default limit of 10.
      const previousMaxListeners = process.getMaxListeners();
      process.setMaxListeners(previousMaxListeners + batchSize);

      // Baseline for the time-to-finish estimate: once the first batch completes we
      // have a real throughput sample, so we can project the remaining batches.
      const loopStartTime = Date.now();

      for (let i = 0; i < itemsToProcess.length; i += batchSize) {
        const batch = itemsToProcess.slice(i, i + batchSize);
        const batchNum = Math.floor(i / batchSize) + 1;

        // Time-to-finish estimate: project the batches still to run (current + remaining)
        // from the average duration of the batches already completed. It goes on the
        // batch's own progress line — the line that stays on screen while the batch runs —
        // so it's visible throughout, not just in the gap between batches. Absent on the
        // first batch (no throughput sample yet); appears from the second batch on.
        const completedBatches = batchNum - 1;
        const etaSuffix =
          completedBatches > 0
            ? ` — ${formatEta(((Date.now() - loopStartTime) / completedBatches) * (totalBatches - completedBatches))}`
            : '';

        if (!verbose) {
          // Progress bar for non-verbose mode
          const progress = Math.round((i / itemsToProcess.length) * 100);
          const line = `  Processing batch ${batchNum}/${totalBatches} (${progress}%)...${etaSuffix}`;
          process.stdout.write('\r' + line.padEnd(PROGRESS_LINE_WIDTH));
        } else {
          console.log(`\nBatch ${batchNum}/${totalBatches}:${etaSuffix}`);
        }

        const batchPromises = batch.map(async (sf) => {
          try {
            // Get callee summaries for context
            const calleeSummaries = getCalleeSummaries(sf.calleeIds, summaryMap, parsedRepo.functions);

            const summary = await summarizer.summarize(sf.function, calleeSummaries);

            // Update map so later items in this batch can access it
            summaryMap.set(sf.function.id, summary);
            newSummaries.push(summary);
            processedCount++;

            if (verbose) {
              console.log(`  ✓ ${sf.function.name} (${summary.confidence_level})`);
            }

            return summary;
          } catch (error) {
            failedCount++;
            const msg = error instanceof Error ? error.message : String(error);
            if (verbose) {
              console.error(`  ✗ ${sf.function.name}: ${msg}`);
            }
            return null;
          }
        });

        await Promise.all(batchPromises);

        // Write intermediate results to disk after every batch (crash recovery + progress visibility)
        if (newSummaries.length > 0) {
          try {
            await writeIntermediateResults(
              summaryOutputPath,
              parsedRepo,
              summaryMap,
              sorted,
              processedCount,
              failedCount,
              startTime,
              existingSummaries,
            );
          } catch (err) {
            // Don't kill the run if intermediate write fails
            if (verbose) {
              console.warn(`  Warning: intermediate write failed: ${err instanceof Error ? err.message : err}`);
            }
          }
        }

        // Rate limiting delay between batches
        if (i + batchSize < itemsToProcess.length && delay > 0) {
          await sleep(delay);
        }
      }

      process.setMaxListeners(previousMaxListeners);

      if (!verbose) {
        process.stdout.write('\n');
      }

      // 7. Build final summaries
      const finalSummaries = buildFinalSummaries(summaryMap, sorted);

      // 8. Generate repository summary if requested, otherwise carry forward existing
      let repositorySummary: RepositorySummary | undefined;
      if (options.repoSummary) {
        console.log('\nGenerating repository summary...');
        try {
          const repoSummarizer = new RepositorySummarizer({
            model: options.model,
            verbose,
            cwd: options.cwd,
            claudeCodeCliPath: options.claudeCodeCliPath,
            harness: options.harness,
            codexCliPath: options.codexCliPath,
            sdkExecutable: options.sdkExecutable,
            sdkEnv: options.sdkEnv,
          });
          repositorySummary = await repoSummarizer.summarize(parsedRepo, finalSummaries);
          console.log('  ✓ Repository summary generated');
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`  ✗ Repository summary failed: ${msg}`);
          // Intentionally do NOT carry forward existingSummaries.repositorySummary:
          // the presence-based retry gate in needsRepoSummary would otherwise skip
          // regeneration on every future run and pin stale data forever. Leaving
          // this undefined lets the next run retry.
        }
      } else {
        // User did not request a regen — carry forward any existing summary.
        repositorySummary = existingSummaries?.repositorySummary;
      }

      // 8b. Generate package summaries for monorepos, otherwise carry forward
      let packageSummaries: PackageSummary[] | undefined;
      if (options.repoSummary && parsedRepo.packages.length > 1) {
        try {
          const pkgSummarizer = new PackageSummarizer({
            model: options.model,
            verbose,
            cwd: options.cwd,
            claudeCodeCliPath: options.claudeCodeCliPath,
            harness: options.harness,
            codexCliPath: options.codexCliPath,
            sdkExecutable: options.sdkExecutable,
            sdkEnv: options.sdkEnv,
          });
          packageSummaries = await pkgSummarizer.summarize(parsedRepo, finalSummaries);
          console.log(`  ✓ Package summaries generated (${packageSummaries.length} packages)`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`  ✗ Package summaries failed: ${msg}`);
          // Do not carry forward — see repo-summary comment above for rationale.
        }
      } else {
        // Either not requested, or single-package repo — carry forward any existing.
        packageSummaries = existingSummaries?.packageSummaries;
      }

      // 9. Write final output. Reported separately from the artifact: when nothing
      // was re-summarized the previous artifact is kept verbatim (so it keeps its
      // content-addressed identity downstream), but these are still THIS run's
      // numbers.
      const runStats: SummaryStats = {
        totalFunctions: parsedRepo.functions.length,
        summarized: processedCount,
        skippedCached: sorted.length - itemsToProcess.length,
        failedSummarization: failedCount,
        processingTimeMs: Date.now() - startTime,
      };

      const output: SummaryOutput = reusePreviousIfUnchanged(
        {
          repoId: parsedRepo.id,
          repoName: parsedRepo.name,
          generatedAt: new Date().toISOString(),
          summarizerVersion: SUMMARIZER_VERSION,
          summaries: finalSummaries,
          stats: runStats,
          ...(repositorySummary && { repositorySummary }),
          ...(packageSummaries && { packageSummaries }),
        },
        existingSummaries,
      );

      fs.writeFileSync(summaryOutputPath, JSON.stringify(output, null, 2));

      // 10. Print summary
      console.log('\n' + '='.repeat(50));
      console.log('Summary Generation Complete');
      console.log('='.repeat(50));
      console.log(`  Total items: ${runStats.totalFunctions}`);
      console.log(`  Newly summarized: ${runStats.summarized}`);
      console.log(`  Cached (skipped): ${runStats.skippedCached}`);
      printNoSourceSkip();
      console.log(`  Failed: ${runStats.failedSummarization}`);
      console.log(`  Time: ${(runStats.processingTimeMs / 1000).toFixed(1)}s`);
      console.log(`  Output: ${summaryOutputPath}`);
      console.log('');

      return runStats;

      // end trackOperation wrapper
    },
    // P1.T3: model on the default path is `options.model` (undefined => the
    // Claude Code default; passed through, never faked).
    (stats) => buildSummarizeMetadata(stats, options.model),
  );
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Resolve the LLM selection for the provider path from flags, with env fallbacks.
 * Provider comes from the flag; model and credentials fall back to env. A model
 * is mandatory (we never guess one for a provider whose models we don't control).
 *
 * Exported for unit testing.
 */
export function resolveLlmConfig(options: SummarizeOptions): LlmConfig {
  const provider = options.provider as string;
  const model = options.model ?? process.env.COREDOC_LLM_MODEL;
  if (!model) {
    throw new Error(
      `A model is required when --provider is set. Pass --model <name> or set COREDOC_LLM_MODEL ` +
        `(e.g. --provider ollama --model qwen2.5-coder:7b).`,
    );
  }
  return {
    provider,
    model,
    apiKey: options.apiKey ?? process.env.COREDOC_LLM_API_KEY ?? '',
    baseURL: options.baseURL ?? (provider === LlmProvider.Ollama ? process.env.OLLAMA_BASE_URL : undefined),
  };
}

/**
 * Provider-agnostic summarize path. Builds a model via createModel, fails fast
 * with a preflight check, then delegates the full pipeline to ciSummarize and
 * writes the result to the same {repoName}-summaries.json the default path uses.
 */
async function runProviderSummarize(args: {
  options: SummarizeOptions;
  parsedRepo: ParsedRepo;
  summaryOutputPath: string;
  existingSummaries: SummaryOutput | null;
  verbose: boolean;
  batchSize: number;
}): Promise<void> {
  const { options, parsedRepo, summaryOutputPath, existingSummaries, verbose, batchSize } = args;

  const llmConfig = resolveLlmConfig(options);
  const label = `${llmConfig.provider} (${llmConfig.model})`;
  console.log(`\nSummarizing with provider: ${label}`);

  const model = createModel(llmConfig);

  await trackOperation(
    options.projectId,
    parsedRepo.name,
    'summarize',
    async () => {
      console.log('  Validating provider connection...');
      await preflightModel(model, label);

      const output = await ciSummarize({
        parsedRepo,
        previousSummaries: existingSummaries,
        // --force re-summarizes every function but keeps previousSummaries so
        // carried-forward high-level summaries (under --no-repo-summary) survive.
        force: options.force,
        model,
        batchSize,
        verbose,
        repoSummary: options.repoSummary,
        // Local Ollama models reject OpenAI's strict json_schema; relax it.
        strictJsonSchema: llmConfig.provider === LlmProvider.Ollama ? false : undefined,
      });

      // `output` may be replaced by the previous artifact below, so read the run's
      // own numbers off it FIRST — the failure check underneath must judge THIS
      // run, never a carried-forward one.
      const runStats = output.stats;

      fs.writeFileSync(summaryOutputPath, JSON.stringify(reusePreviousIfUnchanged(output, existingSummaries), null, 2));

      console.log('\n' + '='.repeat(50));
      console.log('Summary Generation Complete');
      console.log('='.repeat(50));
      console.log(`  Provider: ${label}`);
      console.log(`  Total items: ${runStats.totalFunctions}`);
      console.log(`  Newly summarized: ${runStats.summarized}`);
      console.log(`  Cached (skipped): ${runStats.skippedCached}`);
      console.log(`  Failed: ${runStats.failedSummarization}`);
      console.log(`  Time: ${(runStats.processingTimeMs / 1000).toFixed(1)}s`);
      console.log(`  Output: ${summaryOutputPath}`);
      console.log('');

      // Fail loudly if every attempted summary fell back (e.g. the model can't
      // produce structured output). The file is still written for debugging.
      if (runStats.summarized === 0 && runStats.failedSummarization > 0) {
        throw new Error(
          `All ${runStats.failedSummarization} summaries failed for ${label}. ` +
            `Check the model name and that it supports structured (JSON) output.`,
        );
      }

      return runStats;
    },
    // P1.T3: model on the provider path is the resolved `llmConfig.model`.
    (stats) => buildSummarizeMetadata(stats, llmConfig.model),
  );
}

/**
 * Builds the `summarize_completed` telemetry/metadata props from the summarize
 * run stats (P1.T3). Exported for unit testing (mirrors `buildParseScorecardProps`).
 *
 * Enriches the existing scorecard (`totalFunctions/summarized/cached/failed`)
 * with `model` (the LLM used — `options.model` on the default path, the resolved
 * `llmConfig.model` on the provider path) and `duration_ms` (`processingTimeMs`).
 * `tokens_in`/`tokens_out` are intentionally NOT shipped — neither path tracks
 * token counts, so they have no source (no always-empty schema fields).
 */
export function buildSummarizeMetadata(
  stats: SummaryOutput['stats'] | undefined,
  model: string | undefined,
): Record<string, unknown> {
  if (!stats) return {};
  return {
    totalFunctions: stats.totalFunctions,
    summarized: stats.summarized,
    cached: stats.skippedCached,
    failed: stats.failedSummarization,
    model,
    duration_ms: stats.processingTimeMs,
  };
}

/**
 * Load existing summaries from disk
 */
function loadExistingSummaries(filePath: string): SummaryOutput | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Build a map of item ID to its versioned ID from existing summaries
 */
function buildVersionMap(existing: SummaryOutput | null): Map<string, string> {
  const map = new Map<string, string>();
  if (existing?.summaries) {
    for (const s of existing.summaries) {
      map.set(s.functionId, s.versionedId);
    }
  }
  return map;
}

/**
 * Check if an item needs summarization (version changed or not in cache)
 */
function needsSummarization(fn: FunctionNode, versionMap: Map<string, string>): boolean {
  const cachedVersion = versionMap.get(fn.id);
  return !cachedVersion || cachedVersion !== fn.versionedId;
}

/**
 * Get callee summaries for context (only those that have been summarized)
 */
function getCalleeSummaries(
  calleeIds: string[],
  summaryMap: Map<string, FunctionSummary>,
  functions: FunctionNode[],
): CalleeSummaryContext[] {
  const fnMap = new Map(functions.map((f) => [f.id, f]));

  return calleeIds
    .map((id) => {
      const summary = summaryMap.get(id);
      const fn = fnMap.get(id);
      if (summary && fn) {
        return {
          functionId: id,
          functionName: fn.name,
          purpose: summary.purpose,
          side_effects: summary.side_effects,
        };
      }
      return null;
    })
    .filter((ctx): ctx is CalleeSummaryContext => ctx !== null);
}

/**
 * Build a map of existing function summaries keyed by functionId, keeping
 * only entries whose versionedId matches the current function. Stale entries
 * (version drift) and orphans (functionId no longer in the parsed repo) are
 * dropped so that a failed retry leaves nothing stale in summaryMap and the
 * output file.
 *
 * Exported so it can be unit tested.
 */
export function buildValidSummaryMap(
  existing: SummaryOutput | null,
  functions: FunctionNode[],
): Map<string, FunctionSummary> {
  const currentVersions = new Map(functions.map((f) => [f.id, f.versionedId]));
  const map = new Map<string, FunctionSummary>();
  for (const s of existing?.summaries || []) {
    if (currentVersions.get(s.functionId) === s.versionedId) {
      map.set(s.functionId, s);
    }
  }
  return map;
}

/**
 * Build final summaries array in topological order
 */
function buildFinalSummaries(summaryMap: Map<string, FunctionSummary>, sorted: SortedFunction[]): FunctionSummary[] {
  // Return summaries in topological order (leaves first)
  const orderedIds = sorted.map((sf) => sf.function.id);
  return orderedIds.map((id) => summaryMap.get(id)).filter((s): s is FunctionSummary => s !== undefined);
}

/**
 * Write intermediate results to disk for crash recovery
 */
async function writeIntermediateResults(
  outputPath: string,
  parsedRepo: ParsedRepo,
  summaryMap: Map<string, FunctionSummary>,
  sorted: SortedFunction[],
  processedCount: number,
  failedCount: number,
  startTime: number,
  existingSummaries?: SummaryOutput | null,
): Promise<void> {
  const finalSummaries = buildFinalSummaries(summaryMap, sorted);

  const output: SummaryOutput = {
    repoId: parsedRepo.id,
    repoName: parsedRepo.name,
    generatedAt: new Date().toISOString(),
    summarizerVersion: SUMMARIZER_VERSION,
    summaries: finalSummaries,
    stats: {
      totalFunctions: parsedRepo.functions.length,
      summarized: processedCount,
      skippedCached: sorted.length - (processedCount + failedCount),
      failedSummarization: failedCount,
      processingTimeMs: Date.now() - startTime,
    },
    // Preserve previously generated high-level summaries during checkpoints
    ...(existingSummaries?.repositorySummary && { repositorySummary: existingSummaries.repositorySummary }),
    ...(existingSummaries?.packageSummaries && { packageSummaries: existingSummaries.packageSummaries }),
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-export types for use by CLI. `export type` is required: these are interfaces, and a
// value-syntax re-export makes per-file transpilers (tsx/esbuild) emit a runtime re-export
// of names that don't exist at runtime → throws on import (and errors under
// verbatimModuleSyntax/isolatedModules).
export type { SummaryOutput, FunctionSummary, SummaryStats, RepositorySummary } from './types.js';
export type { PackageSummary } from './package-summarizer.js';
