import type {
  GithubRepositoryIneligibleReason,
  GithubRepositoryResolution,
} from '../../libs/github/github-repository.js';

export const REPOSITORY_LABEL_PREFIX = 'coredoc-repo:';

export interface SeedCandidate {
  repo: { intentRepoKey: string | null };
  resolution: GithubRepositoryResolution;
}

export type SeedResolution =
  | { status: 'ok'; seeds: string[]; ineligible: Array<{ key: string; reason: GithubRepositoryIneligibleReason }> }
  | { status: 'too_many'; count: number }
  | { status: 'unknown' | 'ambiguous'; key: string };

/**
 * An exact key wins; otherwise a key matches case-insensitively, and more than
 * one such match is ambiguous. The caller decides whether ineligibility refuses.
 */
export function resolveSeeds(
  keys: readonly string[],
  candidates: readonly SeedCandidate[],
  cap: number,
): SeedResolution {
  const unique = [...new Set(keys)];
  if (unique.length > cap) return { status: 'too_many', count: unique.length };
  const seeds: string[] = [];
  const ineligible: Array<{ key: string; reason: GithubRepositoryIneligibleReason }> = [];
  for (const key of unique) {
    const exact = candidates.filter((candidate) => candidate.repo.intentRepoKey === key);
    const matches = exact.length
      ? exact
      : candidates.filter((candidate) => candidate.repo.intentRepoKey?.toLowerCase() === key.toLowerCase());
    if (matches.length === 0) return { status: 'unknown', key };
    if (matches.length > 1) return { status: 'ambiguous', key };
    const match = matches[0]!;
    if (match.resolution.status !== 'resolved') ineligible.push({ key, reason: match.resolution.reason });
    seeds.push(match.repo.intentRepoKey!);
  }
  return { status: 'ok', seeds: [...new Set(seeds)], ineligible };
}

export function seedKeysFromLabels(labels: readonly string[]): string[] {
  return labels
    .filter((label) => label.startsWith(REPOSITORY_LABEL_PREFIX))
    .map((label) => label.slice(REPOSITORY_LABEL_PREFIX.length));
}
