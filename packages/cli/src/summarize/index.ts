/**
 * Summarize Command Implementation
 *
 * Generates AI-powered summaries using topological sort
 * to ensure callee summaries are available when processing callers.
 */

import * as fs from 'fs';
import * as path from 'path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ParsedRepo, FunctionNode } from '@coredoc/core/types';
import { RuntimeConfig } from '@coredoc/core/types';
import { parsedRepoFile, summariesFile } from '@coredoc/core/utils';
import type { SummaryOutput } from './types.js';
import { reusePreviousIfUnchanged } from './artifact-identity.js';
import { topologicalSort } from './topological-sort.js';
import { createTextGenerator } from './text-generator.js';
import { trackOperation } from '../operations-tracker.js';
import { createModel, preflightModel, LlmProvider, type LlmConfig } from '../ci/llm-config.js';
import { ciSummarize } from '../ci/ci-summarize-orchestrator.js';
import type { SummaryLlm } from '../ci/ci-summarizer.js';
import { bindProjectDatabase } from '../db-scope.js';

export { SUMMARIZER_VERSION } from './types.js';
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_DELAY_MS = 100;
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
  const noSourceSkipped = sorted.length - synthesizedSkipped - summarizable.length;
  const itemsToProcess = options.force
    ? summarizable
    : summarizable.filter((sf) => needsSummarization(sf.function, existingVersionMap));

  console.log(`\nItems to summarize: ${itemsToProcess.length} / ${sorted.length}`);
  console.log(`  Cached (skipped): ${summarizable.length - itemsToProcess.length}`);
  if (synthesizedSkipped > 0) {
    console.log(`  Synthesized, no body (skipped): ${synthesizedSkipped}`);
  }
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

  // Both paths run the same pipeline (ciSummarize). --provider routes through the
  // provider-agnostic AI SDK; without it the selected local harness (Claude Code by
  // default: subscription auth, no API key) generates free text.
  let llm: SummaryLlm;
  let providerLabel: string | undefined;
  let strictJsonSchema: boolean | undefined;
  let metadataModel = options.model;
  if (options.provider) {
    const llmConfig = resolveLlmConfig(options);
    providerLabel = `${llmConfig.provider} (${llmConfig.model})`;
    console.log(`\nSummarizing with provider: ${providerLabel}`);
    llm = createModel(llmConfig);
    // Local Ollama models reject OpenAI's strict json_schema; relax it.
    strictJsonSchema = llmConfig.provider === LlmProvider.Ollama ? false : undefined;
    metadataModel = llmConfig.model;
  } else {
    const generator = createTextGenerator(options);
    llm = (prompt, system) => generator.generate(prompt, system);
  }

  await trackOperation(
    options.projectId,
    parsedRepo.name,
    'summarize',
    async () => {
      if (providerLabel && typeof llm !== 'function') {
        console.log('  Validating provider connection...');
        await preflightModel(llm, providerLabel);
      }

      // Each harness query() spawns a subprocess that registers an exit listener on process.
      // With batchSize concurrent calls, this exceeds the default limit of 10.
      const previousMaxListeners = process.getMaxListeners();
      process.setMaxListeners(previousMaxListeners + batchSize);
      let output: SummaryOutput;
      try {
        output = await ciSummarize({
          parsedRepo,
          previousSummaries: existingSummaries,
          // --force re-summarizes every function but keeps previousSummaries so
          // carried-forward high-level summaries (under --no-repo-summary) survive.
          force: options.force,
          model: llm,
          batchSize,
          verbose,
          repoSummary: options.repoSummary ?? false,
          strictJsonSchema,
          onBatch: async (checkpoint) => {
            // Crash recovery + progress visibility; a failed checkpoint never kills the run.
            try {
              fs.writeFileSync(summaryOutputPath, JSON.stringify(checkpoint, null, 2));
            } catch (err) {
              if (verbose)
                console.warn(`  Warning: intermediate write failed: ${err instanceof Error ? err.message : err}`);
            }
            if (delay > 0) await sleep(delay);
          },
        });
      } finally {
        process.setMaxListeners(previousMaxListeners);
      }

      // `output` may be replaced by the previous artifact below (so it keeps its
      // content-addressed identity downstream), so read the run's own numbers off
      // it FIRST — the report and failure check must judge THIS run.
      const runStats = output.stats;

      fs.writeFileSync(summaryOutputPath, JSON.stringify(reusePreviousIfUnchanged(output, existingSummaries), null, 2));

      console.log('\n' + '='.repeat(50));
      console.log('Summary Generation Complete');
      console.log('='.repeat(50));
      if (providerLabel) console.log(`  Provider: ${providerLabel}`);
      console.log(`  Total items: ${runStats.totalFunctions}`);
      console.log(`  Newly summarized: ${runStats.summarized}`);
      console.log(`  Cached (skipped): ${runStats.skippedCached}`);
      if (noSourceSkipped > 0) {
        // Repeated here: the up-front line scrolls away behind the batch progress.
        console.log(`  Skipped (no source code): ${noSourceSkipped} — ${NO_SOURCE_HINT}`);
      }
      console.log(`  Failed: ${runStats.failedSummarization}`);
      console.log(`  Time: ${(runStats.processingTimeMs / 1000).toFixed(1)}s`);
      console.log(`  Output: ${summaryOutputPath}`);
      if (output.repositorySummary) console.log(`  Repository summary: ✓`);
      if (output.packageSummaries) console.log(`  Package summaries: ✓ (${output.packageSummaries.length} packages)`);
      console.log('');

      // Fail loudly if every attempted summary fell back (e.g. the model can't
      // produce structured output). The file is still written for debugging.
      if (providerLabel && runStats.summarized === 0 && runStats.failedSummarization > 0) {
        throw new Error(
          `All ${runStats.failedSummarization} summaries failed for ${providerLabel}. ` +
            `Check the model name and that it supports structured (JSON) output.`,
        );
      }

      return runStats;
    },
    // P1.T3: model is `options.model` on the harness path (undefined => the harness
    // default; passed through, never faked) and the resolved model on the provider path.
    (stats) => buildSummarizeMetadata(stats, metadataModel),
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

// Re-export types for use by CLI. `export type` is required: these are interfaces, and a
// value-syntax re-export makes per-file transpilers (tsx/esbuild) emit a runtime re-export
// of names that don't exist at runtime → throws on import (and errors under
// verbatimModuleSyntax/isolatedModules).
export type { SummaryOutput, FunctionSummary, SummaryStats, RepositorySummary, PackageSummary } from './types.js';
