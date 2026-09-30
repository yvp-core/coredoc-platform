/**
 * Summarizer using Claude Agent SDK
 *
 * Uses the Claude Agent SDK (headless Claude Code) for summarization.
 * Dynamic import is used since the Agent SDK is ESM-only.
 */

import { FunctionNode } from '@coredoc/core/types';
import {
  FunctionSummary,
  SideEffect,
  SideEffectType,
  ConfidenceLevel,
  CalleeSummaryContext,
  ParsedAISummary,
} from './types.js';
import { FUNCTION_SUMMARIZER_SYSTEM_PROMPT, buildFunctionPrompt } from './prompts.js';
import { createTextGenerator, type TextGenerator, type TextGeneratorOptions } from './text-generator.js';

/**
 * Options for the summarizer
 */
export interface SummarizerOptions extends TextGeneratorOptions {
  /** Enable verbose logging */
  verbose?: boolean;
  /** Test/custom generation seam. */
  textGenerator?: TextGenerator;
}

/**
 * Summarizes code using Claude Agent SDK
 */
export class FunctionSummarizer {
  private verbose: boolean;
  private textGenerator: TextGenerator;

  constructor(options: SummarizerOptions) {
    this.verbose = options.verbose ?? false;
    this.textGenerator = options.textGenerator ?? createTextGenerator(options);
  }

  /**
   * Summarize a single item
   *
   * @param fn - The item to summarize
   * @param calleeSummaries - Summaries of called items (for context)
   * @returns Generated summary
   */
  async summarize(fn: FunctionNode, calleeSummaries: CalleeSummaryContext[]): Promise<FunctionSummary> {
    const prompt = this.buildPrompt(fn, calleeSummaries);

    try {
      const responseText = await this.textGenerator.generate(prompt, this.getSystemPrompt());
      return this.parseResponse(responseText, fn);
    } catch (error) {
      const fullMsg = error instanceof Error ? error.message : String(error);
      if (this.verbose) {
        console.error(`Error summarizing ${fn.name}: ${fullMsg}`);
      }
      const enrichedError = new Error(fullMsg);
      if (error instanceof Error) enrichedError.stack = error.stack;
      throw enrichedError;
    }
  }

  /**
   * System prompt that instructs the model on output format and rules
   */
  private getSystemPrompt(): string {
    return FUNCTION_SUMMARIZER_SYSTEM_PROMPT;
  }

  /**
   * Build the prompt for a specific item
   */
  private buildPrompt(fn: FunctionNode, calleeSummaries: CalleeSummaryContext[]): string {
    return buildFunctionPrompt(fn, calleeSummaries);
  }

  /**
   * Parse the AI response into a summary
   */
  private parseResponse(responseText: string, fn: FunctionNode): FunctionSummary {
    // Try to extract JSON from response
    // It may be wrapped in markdown code blocks
    let jsonStr = responseText.trim();

    // Remove markdown code block if present
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch?.[1]) {
      jsonStr = jsonMatch[1].trim();
    }

    // Try to find JSON object in the response
    const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      jsonStr = objectMatch[0];
    }

    try {
      const parsed: ParsedAISummary = JSON.parse(jsonStr);

      return {
        functionId: fn.id,
        versionedId: fn.versionedId,
        detailed_summary: parsed.detailed_summary || `Item ${fn.name}`,
        purpose: parsed.purpose || `Performs operations in ${fn.name}`,
        business_logic: this.ensureStringArray(parsed.business_logic),
        side_effects: this.parseSideEffects(parsed.side_effects),
        data_handling: parsed.data_handling || '',
        confidence_level: this.validateConfidence(parsed.confidence_level),
        unknowns: this.ensureStringArray(parsed.unknowns),
        generatedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (this.verbose) {
        console.warn(`Failed to parse JSON response for ${fn.name}:`, error);
        console.warn(`Response was: ${responseText.slice(0, 500)}...`);
      }
      const msg = error instanceof Error ? error.message : String(error);
      // No `fn.name` here: the message reaches the telemetry exception report,
      // and user symbol names are never sent. The verbose log above names the item.
      throw new Error(`Failed to parse AI response as JSON: ${msg}`);
    }
  }

  /**
   * Parse and validate side effects array
   */
  private parseSideEffects(effects: unknown): SideEffect[] {
    if (!Array.isArray(effects)) return [];

    const validTypes: SideEffectType[] = ['logging', 'database', 'event', 'external_call', 'job', 'other'];

    return effects
      .map((e: unknown): SideEffect | null => {
        if (typeof e !== 'object' || e === null) return null;

        const effect = e as Record<string, unknown>;
        const type = validTypes.includes(effect.type as SideEffectType) ? (effect.type as SideEffectType) : 'other';

        return {
          type,
          description: String(effect.description || ''),
          isDirect: effect.isDirect !== false, // Default to true
        };
      })
      .filter((e): e is SideEffect => !!e?.isDirect);
  }

  /**
   * Validate confidence level
   */
  private validateConfidence(level: unknown): ConfidenceLevel {
    const validLevels: ConfidenceLevel[] = ['high', 'medium', 'low'];
    if (typeof level === 'string' && validLevels.includes(level as ConfidenceLevel)) {
      return level as ConfidenceLevel;
    }
    return 'medium';
  }

  /**
   * Ensure value is a string array
   */
  private ensureStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string');
  }
}
