/**
 * Repository Summarizer using Claude Agent SDK
 *
 * Generates high-level repository summaries after function summaries are complete.
 * Uses HTTP endpoints, database entities, and external integrations as context.
 */

import { ParsedRepo } from '@coredoc/core/types';
import { RepositorySummary, FunctionSummary } from './types.js';
import { REPO_SUMMARIZER_SYSTEM_PROMPT, buildRepoPrompt } from './prompts.js';
import { createTextGenerator, type TextGenerator, type TextGeneratorOptions } from './text-generator.js';

/**
 * Options for the repository summarizer
 */
export interface RepositorySummarizerOptions extends TextGeneratorOptions {
  /** Enable verbose logging */
  verbose?: boolean;
  /** Test/custom generation seam. */
  textGenerator?: TextGenerator;
}

/**
 * Parsed AI response for repository summary
 */
interface ParsedRepoSummary {
  overview: string;
  dataModel: string;
  externalIntegrations: string[];
}

/**
 * Summarizes a repository at a high level
 */
export class RepositorySummarizer {
  private verbose: boolean;
  private textGenerator: TextGenerator;

  constructor(options: RepositorySummarizerOptions = {}) {
    this.verbose = options.verbose ?? false;
    this.textGenerator = options.textGenerator ?? createTextGenerator(options);
  }

  /**
   * Generate a high-level repository summary
   *
   * @param parsedRepo - The parsed repository data
   * @param functionSummaries - Function summaries (for endpoint purposes)
   * @returns Repository summary
   */
  async summarize(parsedRepo: ParsedRepo, functionSummaries: FunctionSummary[]): Promise<RepositorySummary> {
    const prompt = this.buildPrompt(parsedRepo, functionSummaries);

    try {
      const responseText = await this.textGenerator.generate(prompt, this.getSystemPrompt());
      return this.parseResponse(responseText, parsedRepo);
    } catch (error) {
      const fullMsg = error instanceof Error ? error.message : String(error);
      if (this.verbose) {
        console.error(`Error summarizing repository ${parsedRepo.name}: ${fullMsg}`);
      }
      const enrichedError = new Error(fullMsg);
      if (error instanceof Error) enrichedError.stack = error.stack;
      throw enrichedError;
    }
  }

  /**
   * System prompt that instructs the model on output format
   */
  private getSystemPrompt(): string {
    return REPO_SUMMARIZER_SYSTEM_PROMPT;
  }

  /**
   * Build the prompt with repository context
   */
  private buildPrompt(parsedRepo: ParsedRepo, functionSummaries: FunctionSummary[]): string {
    return buildRepoPrompt(parsedRepo, functionSummaries);
  }

  /**
   * Parse the AI response into a RepositorySummary
   */
  private parseResponse(responseText: string, parsedRepo: ParsedRepo): RepositorySummary {
    // Try to extract JSON from response
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
      const parsed: ParsedRepoSummary = JSON.parse(jsonStr);

      return {
        overview: parsed.overview || `Repository ${parsedRepo.name}`,
        dataModel: parsed.dataModel || '',
        externalIntegrations: this.ensureStringArray(parsed.externalIntegrations),
        generatedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (this.verbose) {
        console.warn(`Failed to parse JSON response for repo ${parsedRepo.name}:`, error);
        console.warn(`Response was: ${responseText.slice(0, 500)}...`);
      }
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse AI response as JSON for repo ${parsedRepo.name}: ${msg}`);
    }
  }

  /**
   * Ensure value is a string array
   */
  private ensureStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string');
  }
}
