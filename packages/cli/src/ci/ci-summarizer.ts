/**
 * CI Summarizer — LLM caller using Vercel AI SDK or a local harness
 *
 * Provides three functions that call an LLM to summarize functions, repositories,
 * and packages. An AI SDK model goes through generateObject() with the strict Zod
 * schemas; a local harness (Claude Code / Codex subprocess, see text-generator.ts)
 * returns free text that is parsed leniently against the same shapes.
 */

import { generateObject } from 'ai';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import type { FunctionNode, ParsedRepo } from '@coredoc/core/types';
import type { FunctionSummary, RepositorySummary, CalleeSummaryContext, PackageSummary } from '../summarize/types.js';
import {
  FUNCTION_SUMMARIZER_SYSTEM_PROMPT,
  REPO_SUMMARIZER_SYSTEM_PROMPT,
  PACKAGE_SUMMARIZER_SYSTEM_PROMPT,
  buildFunctionPrompt,
  buildRepoPrompt,
  buildPackagePrompt,
} from '../summarize/prompts.js';

/** Free-text generation by a local harness subprocess (no structured output). */
export type GenerateText = (prompt: string, system: string) => Promise<string>;
/** An AI SDK model, or a local harness's text generator. */
export type SummaryLlm = LanguageModel | GenerateText;

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const sideEffectTypeSchema = z.enum(['logging', 'database', 'event', 'external_call', 'job', 'other']);
const confidenceSchema = z.enum(['high', 'medium', 'low']);

const sideEffectSchema = z.object({
  type: sideEffectTypeSchema,
  description: z.string(),
  isDirect: z.boolean(),
});

const functionSummarySchema = z.object({
  detailed_summary: z.string(),
  purpose: z.string(),
  business_logic: z.array(z.string()),
  side_effects: z.array(sideEffectSchema),
  data_handling: z.string(),
  confidence_level: confidenceSchema,
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

// Lenient twins for harness free text: a malformed field falls back to a default
// (empty strings are replaced by name-based defaults below) instead of rejecting
// the whole response. Only unparseable JSON fails.
const lenientString = z.string().catch('');
const lenientStrings = z
  .array(z.unknown())
  .catch([])
  .transform((items) => items.filter((item): item is string => typeof item === 'string'));

const lenientFunctionSummarySchema = z.object({
  detailed_summary: lenientString,
  purpose: lenientString,
  business_logic: lenientStrings,
  side_effects: z
    .array(
      z
        .object({
          type: sideEffectTypeSchema.catch('other'),
          description: lenientString,
          isDirect: z.boolean().catch(true),
        })
        // A non-object entry is dropped (isDirect: false is filtered out below).
        .catch({ type: 'other', description: '', isDirect: false }),
    )
    .catch([]),
  data_handling: lenientString,
  confidence_level: confidenceSchema.catch('medium'),
  unknowns: lenientStrings,
});

const lenientRepoSummarySchema = z.object({
  overview: lenientString,
  dataModel: lenientString,
  externalIntegrations: lenientStrings,
});

// An invalid item becomes an empty one, which the package-id filter drops.
const lenientPackageSummariesSchema = z.array(packageSummaryItemSchema.catch({ packageId: '', purpose: '' }));

/** Pull the JSON payload out of free text: strip a markdown fence, then take the outermost object/array. */
function parseJsonResponse(text: string, shape: 'object' | 'array'): unknown {
  const unfenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim() || text.trim();
  const json = unfenced.match(shape === 'array' ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/)?.[0] ?? unfenced;
  try {
    return JSON.parse(json);
  } catch (error) {
    // No user symbol names here: the message can reach telemetry exception reports.
    throw new Error(`Failed to parse AI response as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

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
// Generation
// ---------------------------------------------------------------------------

/**
 * One structured call: generateObject with the strict schema for an AI SDK model,
 * or free text parsed against the lenient schema for a local harness.
 *
 * Some OpenAI-compatible backends (notably local Ollama models) reject OpenAI's
 * strict `json_schema` response format. Passing `strictJsonSchema: false` relaxes
 * it. When unspecified (CI/OpenRouter/Anthropic default), no override is sent and
 * the SDK's default strict structured output is used.
 */
async function generateStructured<T>(
  llm: SummaryLlm,
  call: {
    schema: z.ZodType<T>;
    lenientSchema: z.ZodType<T>;
    shape: 'object' | 'array';
    instructions: string;
    prompt: string;
    maxOutputTokens: number;
  },
  strictJsonSchema?: boolean,
): Promise<T> {
  if (typeof llm === 'function') {
    return call.lenientSchema.parse(parseJsonResponse(await llm(call.prompt, call.instructions), call.shape));
  }
  const { object } = await generateObject({
    model: llm,
    schema: call.schema,
    instructions: call.instructions,
    prompt: call.prompt,
    maxOutputTokens: call.maxOutputTokens,
    ...(strictJsonSchema === false && { providerOptions: { openai: { strictJsonSchema: false } } }),
  });
  return object as T;
}

// ---------------------------------------------------------------------------
// summarizeFunction
// ---------------------------------------------------------------------------

/**
 * Summarize a single function using the provided LLM.
 * On failure returns a low-confidence fallback summary (never throws).
 */
export async function summarizeFunction(
  fn: FunctionNode,
  calleeSummaries: CalleeSummaryContext[],
  llm: SummaryLlm,
  strictJsonSchema?: boolean,
): Promise<FunctionSummary> {
  try {
    const object = await generateStructured(
      llm,
      {
        schema: functionSummarySchema,
        lenientSchema: lenientFunctionSummarySchema,
        shape: 'object',
        instructions: FUNCTION_SUMMARIZER_SYSTEM_PROMPT,
        prompt: buildFunctionPrompt(fn, calleeSummaries),
        maxOutputTokens: FUNCTION_SUMMARY_MAX_OUTPUT_TOKENS,
      },
      strictJsonSchema,
    );

    return {
      functionId: fn.id,
      versionedId: fn.versionedId,
      detailed_summary: object.detailed_summary || `Item ${fn.name}`,
      purpose: object.purpose || `Performs operations in ${fn.name}`,
      business_logic: object.business_logic,
      side_effects: object.side_effects
        .filter((e) => e.isDirect)
        .map((e) => ({ type: e.type, description: e.description, isDirect: true })),
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
  llm: SummaryLlm,
  strictJsonSchema?: boolean,
): Promise<RepositorySummary> {
  const object = await generateStructured(
    llm,
    {
      schema: repoSummarySchema,
      lenientSchema: lenientRepoSummarySchema,
      shape: 'object',
      instructions: REPO_SUMMARIZER_SYSTEM_PROMPT,
      prompt: buildRepoPrompt(parsedRepo, functionSummaries),
      maxOutputTokens: REPO_AND_PACKAGE_SUMMARY_MAX_OUTPUT_TOKENS,
    },
    strictJsonSchema,
  );

  return {
    overview: object.overview || `Repository ${parsedRepo.name}`,
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
  llm: SummaryLlm,
  strictJsonSchema?: boolean,
): Promise<PackageSummary[]> {
  const object = await generateStructured(
    llm,
    {
      schema: packageSummariesSchema,
      lenientSchema: lenientPackageSummariesSchema,
      shape: 'array',
      instructions: PACKAGE_SUMMARIZER_SYSTEM_PROMPT,
      prompt: buildPackagePrompt(parsedRepo, functionSummaries),
      maxOutputTokens: REPO_AND_PACKAGE_SUMMARY_MAX_OUTPUT_TOKENS,
    },
    strictJsonSchema,
  );

  const generatedAt = new Date().toISOString();
  const validPackageIds = new Set(parsedRepo.packages.map((p) => p.id));
  const seen = new Set<string>();
  const results: PackageSummary[] = [];

  for (const item of object) {
    if (!item.purpose || !validPackageIds.has(item.packageId)) continue;
    if (seen.has(item.packageId)) continue;
    seen.add(item.packageId);
    results.push({ packageId: item.packageId, purpose: item.purpose, generatedAt });
  }

  return results;
}
