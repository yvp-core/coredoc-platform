// =============================================================================
// LanguageProvider — the single per-language extension seam.
//
// "Add a language" = implement one of these + register it (providers/index.ts).
// "Add a framework" = author a profile for an already-registered language (no code).
// See docs/ADDING-A-LANGUAGE.md and the design at
// docs/superpowers/specs/2026-06-21-phase4-extension-model-design.md.
// =============================================================================
import type { ParsedRepo } from '@coredoc/core/types';
import type { ScoreContext, SourceSignals, StructuralResult } from '../scoring/score-core.js';
import type { SourceFileScope } from '../substrate/source-file-scope.js';
import type { BaseProfile } from '../types/profile-base.js';

/** Per-language file discovery. Consumed by facts/discovery. */
export interface LanguageDiscovery {
  /** Source extensions this language claims, e.g. ['.ts','.tsx'] or ['.rb']. */
  readonly extensions: readonly string[];
}

/** Inputs to a single parse. `repoKey` MUST reach idGen (the two-ID invariant). */
export interface ParseOptions {
  repoRoot: string;
  repoName: string;
  /** Path-independent hash seed for StableIdGenerator (repoHash = hash(repoKey ?? repoName)). */
  repoKey?: string;
  /**
   * Where the SCIP indexer writes its index files (a repo-local default when unset). Must be
   * unique per concurrent parse: a multi-target run passes one directory per target.
   */
  scipOutDir?: string;
}

/**
 * The contract a language implements. `language` is the primary registry key and the
 * value of `profile.substrate.language`; `aliases` register the same provider under
 * additional keys (the TS provider serves both 'ts' and 'js').
 */
export interface LanguageProvider<P extends BaseProfile = BaseProfile> {
  /** Primary discriminant / registry key. */
  readonly language: string;
  /** Additional registry keys served by this same provider (e.g. TS → ['js']). */
  readonly aliases?: readonly string[];

  readonly discovery: LanguageDiscovery;

  /** Does this exported value belong to THIS provider? (Positive language check.) */
  isProfile(v: unknown): v is P;

  /**
   * Enumerate the exact source set this provider intends to parse after its effective
   * include, built-in-default-exclude, and profile-exclude policy. The scorer uses this
   * provider-owned contract for whole-repo scope auditing; ParsedRepo.files is not a
   * suitable proxy because some substrates intentionally emit no FileNodes.
   */
  sourceFiles(profile: P, repoRoot: string): SourceFileScope;

  /**
   * The one parse entry point. Returns a full ParsedRepo whose node/edge IDs all flow
   * through a StableIdGenerator seeded with opts.repoKey (never hand-built).
   */
  parse(profile: P, opts: ParseOptions): Promise<ParsedRepo>;

  /** Coverage-scorer source-signal denominators (the language-specific grep/schema counts). */
  sourceSignals(ctx: ScoreContext): SourceSignals;

  /**
   * Optional structural integrity checks (validate-output errors + consistency red flags).
   * TS implements it; languages where it is N/A (e.g. Ruby's synthetic handlers) omit it.
   */
  structuralChecks?(ctx: ScoreContext): StructuralResult;
}
