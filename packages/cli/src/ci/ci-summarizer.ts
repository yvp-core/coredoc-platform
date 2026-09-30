/**
 * CI Summarizer — LLM caller using Vercel AI SDK
 *
 * Provides three functions that call an LLM to summarize functions, repositories,
 * and packages. Uses generateObject() with Zod schemas for structured output.
 */

import { generateObject } from 'ai';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import type { FunctionNode, ParsedRepo } from '@coredoc/core/types';
import type { FunctionSummary, RepositorySummary, CalleeSummaryContext, SideEffectType } from '../summarize/types.js';
import type { PackageSummary } from '../summarize/package-summarizer.js';
import {
  FUNCTION_SUMMARIZER_SYSTEM_PROMPT,
  REPO_SUMMARIZER_SYSTEM_PROMPT,
  PACKAGE_SUMMARIZER_SYSTEM_PROMPT,
  buildFunctionPrompt,
  buildRepoPrompt,
  buildPackagePrompt,
} from '../summarize/prompts.js';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const sideEffectSchema = z.object({
  type: z.enum(['logging', 'database', 'event', 'external_call', 'job', 'other']),
  description: z.string(),
  isDirect: z.boolean(),
});

const functionSummarySchema = z.object({
  detailed_summary: z.string(),
  purpose: z.string(),
  business_logic: z.array(z.string()),
  side_effects: z.array(sideEffectSchema),
  data_handling: z.string(),
  confidence_level: z.enum(['high', 'medium', 'low']),
  unknowns: z.array(z.string()),
});

const repoSummarySchema = z.object({
  overview: z.string(),
  dataModel: z.string(),
  externalIntegrations: z.array(z.string()),
});

const packageSummaryItemSchema = z.object({
  packageId: z.string(),
  purpose: z.string(),
});

const packageSummariesSchema = z.array(packageSummaryItemSchema);

// ---------------------------------------------------------------------------
// Output budgets
// ---------------------------------------------------------------------------

// Explicit output cap: without max_tokens OpenRouter's credit precheck
// reserves the model's MAXIMUM completion budget per request, so a key whose
// remaining credit is below that ceiling rejects every call before running it
// — even when the actual summaries would cost a fraction of it.
// The caps must also cover REASONING tokens: for thinking models they count
// against max_tokens, and a function summary on haiku was observed near 6k
// output tokens with thinking included — a tight cap would truncate the JSON
// and turn the call into a fallback.
const FUNCTION_SUMMARY_MAX_OUTPUT_TOKENS = 16_384;
// Repo/package summaries narrate an entire large codebase (plus thinking), so
// they get most of the model's budget — the precheck win comes from the ~2k
// per-function calls, not from these few per-run calls.
const REPO_AND_PACKAGE_SUMMARY_MAX_OUTPUT_TOKENS = 49_152;

// ---------------------------------------------------------------------------
// Provider options
// ---------------------------------------------------------------------------

/**
 * Build the `providerOptions` for generateObject.
 *
 * Some OpenAI-compatible backends (notably local Ollama models) reject OpenAI's
 * strict `json_schema` response format. Passing `strictJsonSchema: false` relaxes
 * it. When unspecified (CI/OpenRouter/Anthropic default), no override is sent and
 * the SDK's default strict structured output is used.
 */
function objectProviderOptions(strictJsonSchema?: boolean): {
  providerOptions?: { openai: { strictJsonSchema: false } };
} {
  return strictJsonSchema === false ? { providerOptions: { openai: { strictJsonSchema: false } } } : {};
}

// ---------------------------------------------------------------------------
// summarizeFunction
// ---------------------------------------------------------------------------

/**
 * Summarize a single function using the provided LLM model.
 * On failure returns a low-confidence fallback summary (never throws).
 */
export async function summarizeFunction(
  fn: FunctionNode,
  calleeSummaries: CalleeSummaryContext[],
  model: LanguageModel,
  strictJsonSchema?: boolean,
): Promise<FunctionSummary> {
  try {
    const { object } = await generateObject({
      model,
      schema: functionSummarySchema,
      instructions: FUNCTION_SUMMARIZER_SYSTEM_PROMPT,
      prompt: buildFunctionPrompt(fn, calleeSummaries),
      maxOutputTokens: FUNCTION_SUMMARY_MAX_OUTPUT_TOKENS,
      ...objectProviderOptions(strictJsonSchema),
    });

    return {
      functionId: fn.id,
      versionedId: fn.versionedId,
      detailed_summary: object.detailed_summary,
      purpose: object.purpose,
      business_logic: object.business_logic,
      side_effects: object.side_effects
        .filter((e) => e.isDirect)
        .map((e) => ({
          type: e.type as SideEffectType,
          description: e.description,
          isDirect: true,
        })),
      data_handling: object.data_handling,
      confidence_level: object.confidence_level,
      unknowns: object.unknowns,
      generatedAt: new Date().toISOString(),
    };
  } catch (error) {
    return createFallbackFunctionSummary(fn, error);
  }
}

// Prefix of the `unknowns` entry that marks a fallback summary. The producer
// below and isFallbackFunctionSummary share it so they cannot drift.
const FALLBACK_UNKNOWN_PREFIX = 'LLM call failed';

function createFallbackFunctionSummary(fn: FunctionNode, error: unknown): FunctionSummary {
  const msg = error instanceof Error ? error.message : String(error);
  return {
    functionId: fn.id,
    versionedId: fn.versionedId,
    detailed_summary: `Item ${fn.name} (summarization failed)`,
    purpose: `Performs operations defined in ${fn.name}`,
    business_logic: [],
    side_effects: [],
    data_handling: '',
    confidence_level: 'low',
    unknowns: [`${FALLBACK_UNKNOWN_PREFIX}: ${msg}`],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Whether a summary is the low-confidence fallback minted above when the LLM
 * call failed (summarizeFunction never throws). Fallbacks must be neither
 * served from the cache nor persisted into the summary artifact — a cached
 * fallback pins the failure until the function's source changes.
 */
export function isFallbackFunctionSummary(summary: FunctionSummary): boolean {
  return summary.confidence_level === 'low' && summary.unknowns.some((u) => u.startsWith(FALLBACK_UNKNOWN_PREFIX));
}

// ---------------------------------------------------------------------------
// summarizeRepository
// ---------------------------------------------------------------------------

/**
 * Summarize a repository at a high level. Throws on failure.
 */
export async function summarizeRepository(
  parsedRepo: ParsedRepo,
  functionSummaries: FunctionSummary[],
  model: LanguageModel,
  strictJsonSchema?: boolean,
): Promise<RepositorySummary> {
  const { object } = await generateObject({
    model,
    schema: repoSummarySchema,
    instructions: REPO_SUMMARIZER_SYSTEM_PROMPT,
    prompt: buildRepoPrompt(parsedRepo, functionSummaries),
    maxOutputTokens: REPO_AND_PACKAGE_SUMMARY_MAX_OUTPUT_TOKENS,
    ...objectProviderOptions(strictJsonSchema),
  });

  return {
    overview: object.overview,
    dataModel: object.dataModel,
    externalIntegrations: object.externalIntegrations,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// summarizePackages
// ---------------------------------------------------------------------------

/**
 * Summarize all packages in a monorepo. Throws on failure.
 */
export async function summarizePackages(
  parsedRepo: ParsedRepo,
  functionSummaries: FunctionSummary[],
  model: LanguageModel,
  strictJsonSchema?: boolean,
): Promise<PackageSummary[]> {
  const { object } = await generateObject({
    model,
    schema: packageSummariesSchema,
    instructions: PACKAGE_SUMMARIZER_SYSTEM_PROMPT,
    prompt: buildPackagePrompt(parsedRepo, functionSummaries),
    maxOutputTokens: REPO_AND_PACKAGE_SUMMARY_MAX_OUTPUT_TOKENS,
    ...objectProviderOptions(strictJsonSchema),
  });

  const generatedAt = new Date().toISOString();
  const validPackageIds = new Set(parsedRepo.packages.map((p) => p.id));
  const seen = new Set<string>();
  const results: PackageSummary[] = [];

  for (const item of object) {
    if (!validPackageIds.has(item.packageId)) continue;
    if (seen.has(item.packageId)) continue;
    seen.add(item.packageId);
    results.push({ packageId: item.packageId, purpose: item.purpose, generatedAt });
  }

  return results;
}
