import { basename } from 'node:path';
import type { CaseDef, StructuredFact, Target, VerifierScore } from '../harness/types.js';
import { extractFilePaths } from '../harness/citations.js';
import { scoreFilePaths } from '../harness/verifier.js';

export interface FeatureImplementationPlanParams {
  /** Free-text description of the feature an engineer wants to add. */
  feature: string;
  /**
   * Hand-curated list of files an engineer would touch to implement the
   * feature. Truth is always-required for this case — there is no graph
   * fallback (the agent's answer is scored against this list exclusively).
   */
  expectedFiles: string[];
  /** Optional target-native implementation layers (for example Rails-specific sections). */
  planSections?: string[];
  /**
   * Optional repo-specific scoping sentence appended to the prompt (e.g.
   * "Skip files outside `apps/web` and `packages/` unless clearly
   * required."). Keeps target-specific directory layouts out of the shared
   * prompt.
   */
  scopeHint?: string;
}

// Real-world scenario: "I need to add feature X. What files do I touch?"
// The agent must know the repo's CONVENTIONS across layers (data hooks /
// API routes / UI / types / tests) and identify the right precedents to
// follow. Tools the with-MCP arm should reach for: describe_repository,
// search_symbols, find_dependents (to locate similar features), and
// explain on convention-defining utilities.
//
// Scoring: recall-weighted (70 pts recall + 30 pts precision). The prompt
// asks the agent to "list every file" — over-citation (mentioning extra
// related files) is far less harmful than under-citation (missing a layer).
//
// Turn budget: this case is declared SYNTHESIS-HEAVY in the harness
// (`SYNTHESIS_HEAVY_CASES` / `turnBudgetFor` in harness/run.ts) and therefore
// runs on a raised turn cap. Enumerating the layers is only half the work — the
// plan itself is composed on top of everything found — and in an earlier paid run the MCP
// arm hit `error_max_turns` in 2 of 3 runs at the shared exploratory cap while
// the run that finished scored best in the matrix.
export const featureImplementationPlanCase: CaseDef<FeatureImplementationPlanParams> = {
  id: 'feature-implementation-plan',
  extraTools: [],
  buildPrompt(target: Target, p: FeatureImplementationPlanParams): string {
    const planSections = p.planSections?.length
      ? p.planSections
      : [
          'Type / schema definitions',
          'Backend / API routes (and any server-side helpers)',
          'Data-access layer (query hooks / repositories / services)',
          'UI pages / components',
          'Tests',
        ];
    return `Repo: "${target.name}".

You've been asked to add the following feature:
"""
${p.feature}
"""

Plan the implementation. List every file you'd need to create or modify, grouped by layer:
${planSections.map((section, index) => `${index + 1}. ${section}`).join('\n')}

For each file, give:
- The full repo-relative path in backticks
- A one-line note naming the exact symbol(s) and the relationship or effect to change

Don't invent paths — only cite files that exist in the repo (or that follow an existing path convention you can name).${p.scopeHint ? ` ${p.scopeHint}` : ''}`;
  },
  async verify(_target: Target, p: FeatureImplementationPlanParams, run): Promise<VerifierScore> {
    const cited = extractFilePaths(run.responseText);
    const truth = p.expectedFiles.map((f) => f.toLowerCase());
    // Whole-segment suffix matching: the plan's citations routinely carry a
    // different leading prefix (workspace or monorepo root) than the truth set.
    const r = scoreFilePaths(cited, truth);
    // Recall-weighted: the prompt asks "list EVERY file". Citing the right
    // 12 plus 5 plausible extras is a much better answer than citing only 8.
    const final = Math.round(r.recall * 70 + r.precision * 30);
    return {
      score: final,
      details: {
        truth,
        cited,
        precision: r.precision,
        recall: r.recall,
        truth_size: truth.length,
      },
    };
  },
  judgeRubric: {
    dimensions: ['layer_coverage', 'path_accuracy', 'convention_fit', 'completeness'],
    description:
      'layer_coverage: covers type / api / data / ui / test layers, not just one or two. path_accuracy: cited paths actually exist (no fabricated paths or wrong directories). convention_fit: proposed files match the repo\'s established naming + folder conventions for similar features. completeness: identifies every file you\'d realistically need to touch, not just the most obvious 2-3.',
  },
};

export interface FeaturePlanPrimaryEvidence extends StructuredFact {
  /** Every group requires one alternative in the same path-bound evidence unit. */
  semanticGroups: string[][];
}

export interface FeaturePlanUnsafeMatcher {
  label: string;
  /** Every group requires one alternative in the same path-bound evidence unit. */
  semanticGroups: string[][];
  /** Legacy verifier metadata; generic clause-local negation is authoritative. */
  safeNegations?: string[];
}

export interface FeaturePlanPrimaryVerifier {
  required: FeaturePlanPrimaryEvidence[];
  acceptedFiles: string[];
  unsafeClaims: FeaturePlanUnsafeMatcher[];
}

function normalized(value: string): string {
  return value.toLowerCase();
}

function containsTerm(text: string, term: string): boolean {
  const candidates = [
    text.toLowerCase(),
    text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').toLowerCase(),
  ];
  return candidates.some((candidate, index) => {
    const needle = index === 0
      ? term.toLowerCase()
      : term.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').toLowerCase();
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![a-z0-9_])${escaped}(?![a-z0-9_])`).test(candidate);
  });
}

const LOCAL_NEGATION_RE = /\b(?:do\s+not|must\s+not|never|not)\b/;
const CLAUSE_BOUNDARY_RE = /[;!?]|\.(?:\s|$)|\b(?:but|however|instead)\b/;

function matchedSemanticTerms(text: string, groups: string[][]): string[] | null {
  const matches = groups.map((alternatives) =>
    alternatives.map(normalized).filter((alternative) => containsTerm(text, alternative)),
  );
  return matches.some((group) => group.length === 0) ? null : matches.flat();
}

function hasLocalNegation(text: string, semanticTerms: readonly string[]): boolean {
  return text
    .split(CLAUSE_BOUNDARY_RE)
    .some((clause) => {
      const negation = clause.match(LOCAL_NEGATION_RE);
      if (negation?.index === undefined) return false;
      const afterNegation = clause.slice(negation.index + negation[0].length);
      return semanticTerms.some((term) => afterNegation.includes(term));
    });
}

function evidenceLabel(fact: StructuredFact): string {
  const discriminator =
    fact.qualifiedSymbol ??
    fact.relation ??
    (fact.method && fact.path ? `${fact.method} ${fact.path}` : undefined) ??
    fact.effect ??
    fact.useKind ??
    '<missing-semantic>';
  return `${fact.file}#${discriminator}`;
}

function evidenceUnits(responseText: string): string[] {
  const units: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) units.push(current.join(' '));
    current = [];
  };
  for (const rawLine of responseText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    const startsTopLevelItem = /^(?:[-*+] |\d+[.)] )/.test(rawLine);
    const startsHeading = /^#{1,6}\s/.test(line);
    const isIndentedContinuation = /^\s+/.test(rawLine) && !startsTopLevelItem;
    if (!isIndentedContinuation || startsHeading) flush();
    current.push(line);
  }
  flush();
  return units;
}

function evidenceUnitMatches(
  fact: FeaturePlanPrimaryEvidence,
  unit: string,
  pathAliases: ReadonlySet<string>,
): boolean {
  const cited = new Set(extractFilePaths(unit).map(normalized));
  if (![...pathAliases].some((path) => cited.has(path))) return false;
  const text = normalized(unit);
  const boundIdentity = [fact.qualifiedSymbol, fact.method, fact.path].filter(
    (part): part is string => part !== undefined,
  ).map(normalized);
  if (!boundIdentity.every((part) => text.includes(part))) return false;
  const semanticTerms = matchedSemanticTerms(unit, fact.semanticGroups);
  if (!semanticTerms) return false;
  return !hasLocalNegation(text, [...boundIdentity, ...semanticTerms]);
}

/**
 * Held-out feature-plan scorer. A fact only matches when its exact path and
 * semantic discriminator occur in the same bullet/evidence unit; this keeps
 * a right symbol in the wrong file from receiving credit.
 */
export function scorePrimaryFeaturePlan(
  verifier: FeaturePlanPrimaryVerifier,
  responseText: string,
  pathExists: (repoRelativePath: string) => boolean,
): VerifierScore {
  if (verifier.required.length === 0) {
    throw new Error('Registered feature-plan verifier requires at least one evidence unit.');
  }
  const lines = evidenceUnits(responseText);
  const expectedPathList = [
    ...verifier.required.map((fact) => normalized(fact.file)),
    ...verifier.acceptedFiles.map(normalized),
  ];
  const pathsByBasename = new Map<string, string[]>();
  for (const path of new Set(expectedPathList)) {
    const key = normalized(basename(path));
    pathsByBasename.set(key, [...(pathsByBasename.get(key) ?? []), path]);
  }
  const requiredHits = verifier.required.filter((fact) =>
    lines.some((line) => {
      const path = normalized(fact.file);
      const aliases = new Set([path, `${normalized(fact.repoKey)}/${path}`]);
      if (pathsByBasename.get(normalized(basename(path)))?.length === 1) {
        aliases.add(normalized(basename(path)));
      }
      return evidenceUnitMatches(fact, line, aliases);
    }),
  );
  const citedPaths = [...new Set(extractFilePaths(responseText))];
  const expectedPaths = new Set(expectedPathList);
  const repoKeys = [...new Set(verifier.required.map((fact) => normalized(fact.repoKey)))];
  const citationCandidates = citedPaths.map((exactPath) => {
    const comparisonPath = normalized(exactPath);
    if (expectedPaths.has(comparisonPath)) return { comparisonPath, exactPath };
    const basenameMatches = pathsByBasename.get(normalized(basename(exactPath)));
    if (!exactPath.includes('/') && basenameMatches?.length === 1) {
      return { comparisonPath: basenameMatches[0]!, exactPath };
    }
    const repoKey = repoKeys.find((candidate) =>
      comparisonPath.startsWith(`${candidate}/`),
    );
    const stripped = repoKey ? exactPath.slice(repoKey.length + 1) : exactPath;
    const strippedComparison = normalized(stripped);
    return expectedPaths.has(strippedComparison)
      ? { comparisonPath: strippedComparison, exactPath: stripped }
      : { comparisonPath, exactPath };
  });
  const fabricatedPaths = citationCandidates
    .filter(
      ({ comparisonPath, exactPath }) =>
        !expectedPaths.has(comparisonPath) &&
        !pathExists(exactPath) &&
        exactPath.includes('/') &&
        !lines.some(
          (line) =>
            extractFilePaths(line).includes(exactPath) &&
            /\b(?:new file|create a new|add a new)\b/i.test(line),
        ),
    )
    .map(({ exactPath }) => exactPath);
  const matchedUnsafeClaims = verifier.unsafeClaims.filter((claim) =>
    lines.some((line) => {
      const text = normalized(line);
      const semanticTerms = matchedSemanticTerms(line, claim.semanticGroups);
      return semanticTerms !== null && !hasLocalNegation(text, semanticTerms);
    }),
  );
  const coverage = requiredHits.length / verifier.required.length;
  const score = Math.max(
    0,
    Math.round(coverage * 100 - fabricatedPaths.length * 10 - matchedUnsafeClaims.length * 20),
  );
  return {
    score,
    details: {
      requiredHits: requiredHits.length,
      requiredTotal: verifier.required.length,
      missingRequired: verifier.required
        .filter((fact) => !requiredHits.includes(fact))
        .map(evidenceLabel),
      fabricatedPaths,
      matchedUnsafeClaims: matchedUnsafeClaims.map((claim) => claim.label),
    },
  };
}
