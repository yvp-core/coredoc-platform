/**
 * Package Summarizer using Claude Agent SDK
 *
 * Generates AI-powered one-sentence purpose descriptions for each package in a monorepo.
 * Batches all packages in a single prompt since package context is small.
 */

import { ParsedRepo } from '@coredoc/core/types';
import { FunctionSummary } from './types.js';
import { PACKAGE_SUMMARIZER_SYSTEM_PROMPT, buildPackagePrompt } from './prompts.js';
import { createTextGenerator, type TextGenerator, type TextGeneratorOptions } from './text-generator.js';

/**
 * Summary for a single package
 */
export interface PackageSummary {
  packageId: string;
  purpose: string;
  generatedAt: string;
}

/**
 * Options for the package summarizer
 */
export interface PackageSummarizerOptions extends TextGeneratorOptions {
  /** Enable verbose logging */
  verbose?: boolean;
  /** Test/custom generation seam. */
  textGenerator?: TextGenerator;
}

/**
 * Parsed AI response item for a single package
 */
interface ParsedPackageSummaryItem {
  packageId: string;
  purpose: string;
}

/**
 * Summarizes packages in a monorepo at a high level
 */
export class PackageSummarizer {
  private verbose: boolean;
  private textGenerator: TextGenerator;

  constructor(options: PackageSummarizerOptions = {}) {
    this.verbose = options.verbose ?? false;
    this.textGenerator = options.textGenerator ?? createTextGenerator(options);
  }

  /**
   * Generate one-sentence purpose descriptions for all packages
   *
   * @param parsedRepo - The parsed repository data
   * @param functionSummaries - Function summaries (for context)
   * @returns Array of package summaries
   */
  async summarize(parsedRepo: ParsedRepo, functionSummaries: FunctionSummary[]): Promise<PackageSummary[]> {
    const prompt = this.buildPrompt(parsedRepo, functionSummaries);

    try {
      const responseText = await this.textGenerator.generate(prompt, this.getSystemPrompt());
      return this.parseResponse(responseText, parsedRepo);
    } catch (error) {
      const fullMsg = error instanceof Error ? error.message : String(error);
      if (this.verbose) {
        console.error(`Error summarizing packages for ${parsedRepo.name}: ${fullMsg}`);
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
    return PACKAGE_SUMMARIZER_SYSTEM_PROMPT;
  }

  /**
   * Build the prompt with per-package context
   */
  private buildPrompt(parsedRepo: ParsedRepo, functionSummaries: FunctionSummary[]): string {
    return buildPackagePrompt(parsedRepo, functionSummaries);
  }

  /**
   * Parse the AI response into PackageSummary array
   */
  private parseResponse(responseText: string, parsedRepo: ParsedRepo): PackageSummary[] {
    // Try to extract JSON from response
    let jsonStr = responseText.trim();

    // Remove markdown code block if present
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch?.[1]) {
      jsonStr = jsonMatch[1].trim();
    }

    // Try to find JSON array in the response
    const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      jsonStr = arrayMatch[0];
    }

    const generatedAt = new Date().toISOString();

    try {
      const parsed: ParsedPackageSummaryItem[] = JSON.parse(jsonStr);

      if (!Array.isArray(parsed)) {
        throw new Error('Response is not an array');
      }

      // Validate against real package IDs and deduplicate
      const validPackageIds = new Set(parsedRepo.packages.map((p) => p.id));
      const seen = new Set<string>();
      const results: PackageSummary[] = [];

      for (const item of parsed) {
        if (!item.packageId || !item.purpose) continue;
        if (!validPackageIds.has(item.packageId)) continue;
        if (seen.has(item.packageId)) continue;
        seen.add(item.packageId);
        results.push({ packageId: item.packageId, purpose: item.purpose, generatedAt });
      }

      if (results.length < parsedRepo.packages.length && this.verbose) {
        console.warn(`  Warning: AI returned ${results.length}/${parsedRepo.packages.length} valid package summaries`);
      }

      return results;
    } catch (error) {
      if (this.verbose) {
        console.warn(`Failed to parse JSON response for packages:`, error);
        console.warn(`Response was: ${responseText.slice(0, 500)}...`);
      }
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse AI response as JSON for packages: ${msg}`);
    }
  }
}
