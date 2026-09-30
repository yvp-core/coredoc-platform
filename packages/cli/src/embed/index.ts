/**
 * Embed Command Implementation
 *
 * Generates embeddings for functions and endpoints using LangChain.
 * Supports Ollama (local) and OpenRouter providers with incremental updates.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ParsedRepo } from '@coredoc/core/types';
import { RuntimeConfig } from '@coredoc/core/types';
import { parsedRepoFile, summariesFile, embeddingsFile } from '@coredoc/core/utils';
import { EmbedOptions, EmbedItem, EmbedStats } from './types.js';
import { createEmbeddingProvider, getDefaultModel } from './providers.js';
import { EmbeddingStorage, createFunctionEmbedding, createEndpointEmbedding } from './storage.js';
import { buildFunctionItems, buildEndpointItems, loadSummaries } from './input-builder.js';

export const EMBEDDER_VERSION = '1.0.0';
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_DELAY_MS = 100;

/**
 * Run the embed command
 */
export async function runEmbed(options: EmbedOptions, config: RuntimeConfig): Promise<void> {
  const startTime = Date.now();
  const verbose = options.verbose;
  const batchSize = options.batchSize || DEFAULT_BATCH_SIZE;
  const delay = options.delay || DEFAULT_DELAY_MS;

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

  // 2. Load summaries (for summary-based input strategy)
  const defaultSummariesPath = options.projectId
    ? summariesFile(config.resolvedOutputDir, options.projectId, parsedRepo.name)
    : path.join(path.dirname(parsedRepoPath), `${parsedRepo.name}-summaries.json`);
  const summaryMap = loadSummaries(options.summariesPath, defaultSummariesPath);

  if (verbose) {
    console.log(`  Summaries loaded: ${summaryMap.size} items`);
  }

  // Warn if using summary strategy without summaries
  if ((options.inputStrategy === 'summary' || options.inputStrategy === 'both') && summaryMap.size === 0) {
    console.log(`  Warning: Using ${options.inputStrategy} strategy but no summaries found.`);
    console.log(`  Run 'coredoc summarize ${options.repo}' first for better embeddings.`);
  }

  // 3. Load existing embeddings (for incremental updates)
  const embeddingsOutputPath = options.projectId
    ? embeddingsFile(config.resolvedOutputDir, options.projectId, parsedRepo.name)
    : path.join(path.dirname(parsedRepoPath), `${parsedRepo.name}-embeddings.json`);

  const storage = new EmbeddingStorage(embeddingsOutputPath);
  const existing = storage.load();

  if (verbose && existing) {
    const counts = storage.getCounts();
    console.log(`  Existing embeddings found: ${counts.functions} functions, ${counts.endpoints} endpoints`);
  }

  // 4. Build items to embed
  const functionItems = options.noFunctions
    ? []
    : buildFunctionItems(parsedRepo.functions, options.inputStrategy, summaryMap);

  const endpointItems = options.noEndpoints
    ? []
    : buildEndpointItems(parsedRepo.entrypoints, parsedRepo.functions, options.inputStrategy, summaryMap);

  // 5. Filter items needing embedding
  const functionsToProcess = options.force
    ? functionItems
    : functionItems.filter((item: EmbedItem) => storage.needsEmbedding(item, false));

  const endpointsToProcess = options.force
    ? endpointItems
    : endpointItems.filter((item: EmbedItem) => storage.needsEmbedding(item, false));

  const allItemsToProcess = [...functionsToProcess, ...endpointsToProcess];

  console.log(`\nItems to embed:`);
  console.log(`  Functions: ${functionsToProcess.length} / ${functionItems.length}`);
  console.log(`  Endpoints: ${endpointsToProcess.length} / ${endpointItems.length}`);
  console.log(
    `  Cached (skipped): ${functionItems.length - functionsToProcess.length + (endpointItems.length - endpointsToProcess.length)}`,
  );

  if (options.dryRun) {
    console.log('\n[DRY RUN] Would embed:');
    const sample = allItemsToProcess.slice(0, 20);
    for (const item of sample) {
      console.log(`  - [${item.type}] ${item.name}`);
    }
    if (allItemsToProcess.length > 20) {
      console.log(`  ... and ${allItemsToProcess.length - 20} more`);
    }
    return;
  }

  if (allItemsToProcess.length === 0) {
    console.log('\nAll items are cached. Nothing to embed.');
    console.log(`  Use --force to re-embed all.`);
    return;
  }

  // 6. Initialize embedding provider
  const model = options.model || getDefaultModel(options.provider);
  console.log(`\nInitializing ${options.provider} provider with model: ${model}`);

  const provider = createEmbeddingProvider({
    provider: options.provider,
    model,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    dimensions: options.dimensions,
  });

  // Get dimensions from provider
  let dimensions: number;
  try {
    dimensions = await provider.getDimensions();
    console.log(`  Embedding dimensions: ${dimensions}`);
  } catch (error) {
    throw new Error(`Failed to connect to ${options.provider}: ${error instanceof Error ? error.message : error}`);
  }

  // 7. Process items in batches
  let functionsEmbedded = 0;
  let endpointsEmbedded = 0;
  let failed = 0;
  const totalBatches = Math.ceil(allItemsToProcess.length / batchSize);

  console.log(`\nProcessing ${allItemsToProcess.length} items in ${totalBatches} batches...`);

  for (let i = 0; i < allItemsToProcess.length; i += batchSize) {
    const batch = allItemsToProcess.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;

    if (!verbose) {
      const progress = Math.round((i / allItemsToProcess.length) * 100);
      process.stdout.write(`\r  Processing batch ${batchNum}/${totalBatches} (${progress}%)...`);
    } else {
      console.log(`\nBatch ${batchNum}/${totalBatches}:`);
    }

    try {
      // Get embeddings for batch
      const texts = batch.map((item: EmbedItem) => item.inputText);
      const embeddings = await provider.embedBatch(texts);

      // Save results
      for (let j = 0; j < batch.length; j++) {
        const item = batch[j]!;
        const embedding = embeddings[j]!;

        if (item.type === 'function') {
          storage.updateFunction(createFunctionEmbedding(item, embedding));
          functionsEmbedded++;
        } else {
          storage.updateEndpoint(createEndpointEmbedding(item, embedding));
          endpointsEmbedded++;
        }

        if (verbose) {
          console.log(`  ✓ [${item.type}] ${item.name}`);
        }
      }
    } catch (error) {
      failed += batch.length;
      const msg = error instanceof Error ? error.message : String(error);
      if (verbose) {
        console.error(`  ✗ Batch failed: ${msg}`);
      }
    }

    // Write intermediate results (crash recovery)
    if ((batchNum % 5 === 0 || batchNum === totalBatches) && (functionsEmbedded > 0 || endpointsEmbedded > 0)) {
      const stats: EmbedStats = {
        totalFunctions: functionItems.length,
        totalEndpoints: endpointItems.length,
        functionsEmbedded,
        endpointsEmbedded,
        functionsSkipped: functionItems.length - functionsToProcess.length,
        endpointsSkipped: endpointItems.length - endpointsToProcess.length,
        failed,
        processingTimeMs: Date.now() - startTime,
      };

      storage.save(parsedRepo.id, parsedRepo.name, options.provider, model, dimensions, options.inputStrategy, stats);
    }

    // Rate limiting delay between batches
    if (i + batchSize < allItemsToProcess.length && delay > 0) {
      await sleep(delay);
    }
  }

  if (!verbose) {
    process.stdout.write('\n');
  }

  // 8. Final save
  const finalStats: EmbedStats = {
    totalFunctions: functionItems.length,
    totalEndpoints: endpointItems.length,
    functionsEmbedded,
    endpointsEmbedded,
    functionsSkipped: functionItems.length - functionsToProcess.length,
    endpointsSkipped: endpointItems.length - endpointsToProcess.length,
    failed,
    processingTimeMs: Date.now() - startTime,
  };

  storage.save(parsedRepo.id, parsedRepo.name, options.provider, model, dimensions, options.inputStrategy, finalStats);

  // 9. Print summary
  console.log('\n' + '='.repeat(50));
  console.log('Embedding Generation Complete');
  console.log('='.repeat(50));
  console.log(`  Provider: ${options.provider}`);
  console.log(`  Model: ${model}`);
  console.log(`  Dimensions: ${dimensions}`);
  console.log(`  Input Strategy: ${options.inputStrategy}`);
  console.log('');
  console.log(`  Total functions: ${finalStats.totalFunctions}`);
  console.log(`  Total endpoints: ${finalStats.totalEndpoints}`);
  console.log(`  Functions embedded: ${finalStats.functionsEmbedded}`);
  console.log(`  Endpoints embedded: ${finalStats.endpointsEmbedded}`);
  console.log(`  Cached (skipped): ${finalStats.functionsSkipped + finalStats.endpointsSkipped}`);
  console.log(`  Failed: ${finalStats.failed}`);
  console.log(`  Time: ${(finalStats.processingTimeMs / 1000).toFixed(1)}s`);
  console.log(`  Output: ${embeddingsOutputPath}`);
  console.log('');
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-export types for use by CLI
export {
  EmbedOptions,
  EmbeddingsOutput,
  FunctionEmbedding,
  EndpointEmbedding,
  EmbedStats,
  EmbeddingProvider,
  InputStrategy,
} from './types.js';
