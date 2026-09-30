// =============================================================================
// BaseProfile — the minimal shape every language profile shares.
//
// `substrate.language` is the dispatch discriminant: it keys the LanguageProvider
// registry (see providers/registry.ts) and selects which provider parses a repo.
// Both `ExtractionProfile` (TS/JS) and `RubyProfile` extend this — they keep their
// distinct rule vocabularies; only the discriminant + dispatch are unified.
// =============================================================================
import type { RepoType } from '@coredoc/core/types';

export interface BaseProfile {
  parserId: string;
  /**
   * Declarative repo classification (backend | frontend | mobile | library | monorepo),
   * set by the profile author who knows the repo — not inferred from fact counts. Surfaces
   * as `ParsedRepo.type`. Omit when unknown; the parser then leaves `type` unset.
   */
  repoType?: RepoType;
  /**
   * Set when the repo's entity set mirrors the whole DB schema (e.g.
   * `@mikro-orm/entity-generator` output) while only a subset is operated on.
   * Switches the scorer's dbOperations denominator from all emitted entities to
   * the distinct operated entities, so an honest profile isn't a permanent FAIL.
   */
  schemaMirror?: boolean;
  substrate: {
    /** Dispatch discriminant — the registry key (e.g. 'ts', 'js', 'ruby'). */
    language: string;
    include?: string[];
    exclude?: string[];
  };
}
