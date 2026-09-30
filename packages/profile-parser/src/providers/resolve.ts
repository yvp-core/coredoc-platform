// =============================================================================
// Profile-export resolution — the one place that turns a profile module's
// exports into dispatchable work: either a single-language profile (one
// provider) or a multi-target composite (one provider per target).
// Shared by score.ts, run.ts, and the CLI parser-loader.
// =============================================================================
import type { MultiTargetProfile } from '../types/multi-profile.js';
import type { BaseProfile } from '../types/profile-base.js';
import { getLanguage, providerForExport } from './registry.js';
import type { LanguageProvider } from './types.js';

export interface ResolvedTarget {
  name: string;
  provider: LanguageProvider;
  /** The target with the composite's parserId stamped on — a full BaseProfile. */
  profile: BaseProfile;
}

export type ResolvedProfileExport =
  | { kind: 'single'; provider: LanguageProvider; profile: BaseProfile }
  | { kind: 'multi'; profile: MultiTargetProfile; targets: ResolvedTarget[] };

/** A composite has parserId + a targets array and NO top-level substrate. */
export function isMultiTargetProfile(v: unknown): v is MultiTargetProfile {
  if (typeof v !== 'object' || v === null) return false;
  if (!('parserId' in v) || !('targets' in v) || 'substrate' in v) return false;
  return Array.isArray((v as MultiTargetProfile).targets);
}

/**
 * Validate and resolve every target to its provider. Throws (fail fast) on empty
 * targets, missing/duplicate names, duplicate canonical providers, an unregistered
 * language, or a target the matched provider does not recognize as its profile shape.
 */
export function resolveTargets(profile: MultiTargetProfile): ResolvedTarget[] {
  if (profile.targets.length === 0) {
    throw new Error(`Multi-target profile '${profile.parserId}' has no targets`);
  }
  const seen = new Set<string>();
  const providerOwners = new Map<LanguageProvider, { name: string; language: string }>();
  return profile.targets.map((t, i) => {
    if (!t.name) throw new Error(`targets[${i}] is missing a name`);
    if (seen.has(t.name)) throw new Error(`Duplicate target name '${t.name}'`);
    seen.add(t.name);
    const lang = t.substrate?.language;
    const provider = lang ? getLanguage(lang) : undefined;
    if (!provider) {
      throw new Error(`Target '${t.name}': no registered language provider for '${lang}'`);
    }
    const stamped: BaseProfile = { ...t, parserId: profile.parserId };
    if (!provider.isProfile(stamped)) {
      throw new Error(`Target '${t.name}': not a valid '${provider.language}' profile shape`);
    }
    const owner = providerOwners.get(provider);
    if (owner) {
      throw new Error(
        `Targets '${owner.name}' (language '${owner.language}') and '${t.name}' (language '${lang}') ` +
          `resolve to the same canonical '${provider.language}' language provider. Multi-target profiles ` +
          `require exactly one target per language provider; combine their include/exclude scopes into one ` +
          `target to preserve a single cross-package index.`,
      );
    }
    providerOwners.set(provider, { name: t.name, language: lang });
    return { name: t.name, provider, profile: stamped };
  });
}

/** Resolve one exported value: composite first (it has no substrate, so the two checks can't overlap), then single. */
export function resolveProfileExport(v: unknown): ResolvedProfileExport | undefined {
  if (isMultiTargetProfile(v)) return { kind: 'multi', profile: v, targets: resolveTargets(v) };
  const single = providerForExport(v);
  return single ? { kind: 'single', ...single } : undefined;
}

/** Scan a dynamically-imported profile module's exports for the first dispatchable profile. */
export function resolveProfileModule(mod: Record<string, unknown>): ResolvedProfileExport | undefined {
  for (const v of Object.values(mod)) {
    const r = resolveProfileExport(v);
    if (r) return r;
  }
  return undefined;
}
