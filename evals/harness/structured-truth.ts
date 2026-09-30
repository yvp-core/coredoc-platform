import type { StructuredFact, StructuredTruth, VerifierScore } from './types.js';

function includes(text: string, value: string | undefined): boolean {
  return value !== undefined && text.includes(value.toLowerCase());
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function factMatches(fact: StructuredFact, response: string): boolean {
  const text = response.toLowerCase();
  const file = fact.file.toLowerCase();
  if (!text.includes(file) && !text.includes(`${fact.repoKey.toLowerCase()}/${file}`)) return false;
  if (!includes(text, fact.qualifiedSymbol)) return fact.qualifiedSymbol === undefined
    ? semanticFieldsMatch(fact, text)
    : false;
  return semanticFieldsMatch(fact, text);
}

function semanticFieldsMatch(fact: StructuredFact, text: string): boolean {
  if (fact.relation && !includes(text, fact.relation)) return false;
  if (fact.method && fact.path) {
    if (!includes(text, fact.method) || !includes(text, fact.path)) return false;
  }
  if (fact.depth !== undefined) {
    const depth = escapeRegex(String(fact.depth));
    if (!new RegExp(`(?:\\bdepth\\s*[:=]?\\s*${depth}\\b|\\b${depth}\\s+hops?\\b)`, 'i').test(text)) {
      return false;
    }
  }
  if (fact.effect && !includes(text, fact.effect)) return false;
  if (fact.useKind && !includes(text, fact.useKind)) return false;
  return true;
}

function label(fact: StructuredFact): string {
  const semantic =
    fact.qualifiedSymbol ??
    fact.relation ??
    (fact.method && fact.path ? `${fact.method} ${fact.path}` : undefined) ??
    (fact.depth === undefined ? undefined : `depth ${fact.depth}`) ??
    fact.effect ??
    fact.useKind ??
    '<missing-semantic>';
  return `${fact.repoKey}@${fact.gitSha.slice(0, 12)}:${fact.file}#${semantic}`;
}

/**
 * Programmatic endpoint for admitted primary cells. Required facts earn the
 * score; forbidden claims proportionally reduce it. Accepted facts are
 * recorded as optional alternatives and never inflate required coverage.
 */
export function scoreStructuredTruth(
  truth: StructuredTruth,
  responseText: string,
): VerifierScore {
  if (truth.required.length === 0) {
    throw new Error('Structured primary truth requires at least one required fact.');
  }
  const requiredHits = truth.required.filter((fact) => factMatches(fact, responseText));
  const acceptedHits = truth.accepted.filter((fact) => factMatches(fact, responseText));
  const forbiddenHits = truth.forbidden.filter((fact) => factMatches(fact, responseText));
  const requiredCoverage = requiredHits.length / truth.required.length;
  const forbiddenPenalty =
    truth.forbidden.length === 0 ? 0 : forbiddenHits.length / truth.forbidden.length;
  return {
    score: Math.round(requiredCoverage * (1 - forbiddenPenalty) * 100),
    details: {
      requiredHits: requiredHits.length,
      requiredTotal: truth.required.length,
      acceptedHits: acceptedHits.length,
      acceptedTotal: truth.accepted.length,
      forbiddenHits: forbiddenHits.length,
      forbiddenTotal: truth.forbidden.length,
      missingRequired: truth.required
        .filter((fact) => !requiredHits.includes(fact))
        .map(label),
      matchedForbidden: forbiddenHits.map(label),
    },
  };
}
