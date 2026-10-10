/**
 * Summary types — single source of truth lives in @coredoc/core
 * (packages/core/src/types/summary.ts). This module re-exports them so the CLI's many
 * `../summarize/types.js` importers keep working without a hand-synced fork.
 */
import type { SummaryOutput } from '@coredoc/core';
export type {
  ConfidenceLevel,
  SideEffectType,
  SideEffect,
  FunctionSummary,
  SummaryStats,
  RepositorySummary,
  SummaryOutput,
  CalleeSummaryContext,
} from '@coredoc/core';

export type PackageSummary = NonNullable<SummaryOutput['packageSummaries']>[number];

/**
 * Stamped into every `SummaryOutput.summarizerVersion`, and part of the summary
 * artifact identity used for push reuse — so the local and CI pipelines must
 * agree on it. Lives here, the leaf both of them already import.
 */
export const SUMMARIZER_VERSION = '1.0.0';
