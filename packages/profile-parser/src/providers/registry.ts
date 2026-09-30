// =============================================================================
// LanguageProvider registry — the single source of truth for which language
// parses a repo.
// =============================================================================
import type { BaseProfile } from '../types/profile-base.js';
import type { LanguageProvider } from './types.js';

const PROVIDERS = new Map<string, LanguageProvider>();

/** Register a provider under its `language` key plus any `aliases` (e.g. TS → 'ts','js'). */
export function registerLanguage(p: LanguageProvider): void {
  for (const key of [p.language, ...(p.aliases ?? [])]) {
    PROVIDERS.set(key, p);
  }
}

export function getLanguage(language: string): LanguageProvider | undefined {
  return PROVIDERS.get(language);
}

export function allLanguages(): LanguageProvider[] {
  // De-dupe: a provider registered under several keys appears once.
  return [...new Set(PROVIDERS.values())];
}

/**
 * Find the provider whose `isProfile` claims this exported value, keyed on
 * `substrate.language`.
 */
export function providerForExport(v: unknown): { provider: LanguageProvider; profile: BaseProfile } | undefined {
  if (typeof v !== 'object' || v === null || !('substrate' in v)) return undefined;
  const lang = (v as BaseProfile).substrate?.language;
  const provider = lang ? PROVIDERS.get(lang) : undefined;
  return provider?.isProfile(v) ? { provider, profile: v as BaseProfile } : undefined;
}

/** Test-only: clear the registry (the production registration is idempotent on re-import). */
export function __clearRegistryForTests(): void {
  PROVIDERS.clear();
}
