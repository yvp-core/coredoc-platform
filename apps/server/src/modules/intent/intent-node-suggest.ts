/**
 * Refusals for a domain or feature id the workspace does not declare.
 *
 * An agent that guesses a scope id (`attendance` for a domain called
 * `time-tracking`) must learn the right id from the refusal itself, not lose
 * the read. The message stays inside the public bound and names the nearest
 * declared ids; each suggestion is also a structured detail, so a list longer
 * than the message bound is never cut mid-id.
 */
import type { IntentPublicException } from './contract/index.js';
import { IntentErrorCode } from './contract/index.js';
import { intentStateError } from './intent-state-errors.js';

export interface IntentNodeCandidate {
  id: string;
  title: string;
}

/** Declared nodes scanned for suggestions. Far above any real tree; a bound, not a page. */
export const INTENT_NODE_SCAN = 2000;

/** Suggestions per refusal. A short list is read; a long one is a second tree dump. */
export const INTENT_NODE_SUGGESTIONS = 5;

/** Below this a suggestion is noise: one shared short word or a few shared letters. */
const MIN_SCORE = 0.6;

/** Declared ids carried as details when nothing is close; the public error caps details at 20. */
const INTENT_NODE_DETAILS = 20;

function words(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0] as number;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j] as number;
      previous[j] = Math.min(above + 1, (previous[j - 1] as number) + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length] as number;
}

function wordSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return 0.9;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length);
}

/**
 * How close a guessed id is to one declared node, in [0, 1]: the best word
 * match of each guessed word against the candidate's id and title words,
 * averaged over the guessed words.
 */
export function nodeSimilarity(guess: string, candidate: IntentNodeCandidate): number {
  const guessed = words(guess);
  const known = [...new Set([...words(candidate.id), ...words(candidate.title)])];
  if (guessed.length === 0 || known.length === 0) return 0;
  const total = guessed.reduce((sum, word) => sum + Math.max(...known.map((other) => wordSimilarity(word, other))), 0);
  return total / guessed.length;
}

export function nearestNodes(guess: string, candidates: readonly IntentNodeCandidate[]): IntentNodeCandidate[] {
  return candidates
    .map((candidate) => ({ candidate, score: nodeSimilarity(guess, candidate) }))
    .filter((entry) => entry.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id))
    .slice(0, INTENT_NODE_SUGGESTIONS)
    .map((entry) => entry.candidate);
}

/** `domain_not_found` / `feature_not_found` naming the nearest declared ids. */
export function unknownNodeError(
  kind: 'domain' | 'feature',
  id: string,
  candidates: readonly IntentNodeCandidate[],
  path: string[],
): IntentPublicException {
  const nearest = nearestNodes(id, candidates);
  const code = kind === 'domain' ? IntentErrorCode.DomainNotFound : IntentErrorCode.FeatureNotFound;
  // No close match: name the declared ids instead, as many as the bounds hold.
  const named = nearest.length > 0 ? nearest : [...candidates].sort((a, b) => a.id.localeCompare(b.id));
  const hint =
    nearest.length > 0
      ? `nearest: ${nearest.map((node) => node.id).join(', ')}`
      : `declared: ${named.map((node) => node.id).join(', ') || '<none declared>'}`;
  return intentStateError(
    code,
    `intent ${kind} '${id}' is not declared in this workspace; ${hint}. intent_read action 'tree' lists every id`,
    path,
    undefined,
    named.slice(0, INTENT_NODE_DETAILS).map((node) => ({ code, message: `${node.id}: ${node.title}`, path })),
  );
}
