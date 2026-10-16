// =============================================================================
// Zig LanguageProvider.
//
// A thin wrapper over `parseSubstrate(zigSubstrate)` (the bespoke tree-sitter-CST
// substrate): types, functions, `@import` edges, Tier-B calls, `cli` entrypoints, egress,
// raw-SQL entities/ops, constants and aliases. No SCIP: Zig has no SCIP indexer, so every
// collection comes from the tree-sitter CST and the parse never throws on a missing index.
// =============================================================================
import { zigSourceSignals } from '../scoring/zig-signals.js';
import type { ScoreContext, SourceSignals } from '../scoring/score-core.js';
import { substrateEntry } from '../substrate/parse-substrate.js';
import { zigSubstrate } from '../substrate/zig/zig-parser.js';
import type { ZigProfile } from '../types/zig-profile.js';
import { hasLanguage } from './registry.js';
import type { LanguageProvider } from './types.js';

export const zigProvider: LanguageProvider<ZigProfile> = {
  language: 'zig',
  discovery: { extensions: ['.zig'] },
  isProfile: (v): v is ZigProfile => hasLanguage(v, 'zig'),

  ...substrateEntry(zigSubstrate),

  sourceSignals(ctx: ScoreContext): SourceSignals {
    return zigSourceSignals(ctx);
  },
  // No structuralChecks: like Swift/Ruby, Zig has no route/handler table to check a profile
  // against — its only entrypoint is `pub fn main`, whose handler is the emitted function
  // itself, so the TS handler-consistency checks are N/A rather than a permanent FAIL.
};
