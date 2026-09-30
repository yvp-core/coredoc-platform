import type { CaseDef, Target, VerifierScore } from '../harness/types.js';
import { extractIdentifiers } from '../harness/citations.js';

// Recall-weighted Fβ. We prefer β=2 here because the prompt asks the agent to
// "list every reusable piece" — extra correct suggestions beyond the curated
// truth set are valuable signal, not noise. β=2 weights recall 4× higher than
// precision, so an agent that names all expected reusables plus a handful of
// additional plausible ones still scores well.
export function fBeta(
  cited: string[],
  truth: string[],
  beta = 2,
): { precision: number; recall: number; fBeta: number } {
  if (truth.length === 0) return { precision: 0, recall: 0, fBeta: 0 };
  if (cited.length === 0) return { precision: 0, recall: 0, fBeta: 0 };
  const truthSet = new Set(truth.map((t) => t.toLowerCase()));
  const citedSet = new Set(cited.map((c) => c.toLowerCase()));
  const tp = [...citedSet].filter((c) => truthSet.has(c)).length;
  const precision = tp / citedSet.size;
  const recall = tp / truthSet.size;
  const b2 = beta * beta;
  const denom = b2 * precision + recall;
  const fBetaVal = denom === 0 ? 0 : ((1 + b2) * precision * recall) / denom;
  return { precision, recall, fBeta: fBetaVal };
}

export interface ComponentDecisionParams {
  /** Free-text description of the UI need (one or two sentences). */
  feature: string;
  /** Hand-curated list of components, hooks, and utilities the agent SHOULD propose reusing. */
  expectedComponents: string[];
}

// Real-world scenario: "I need to add feature X — what already exists that I
// can reuse instead of building from scratch?" The truth set is hand-curated
// (no graph query can capture semantic fit), exactly like blastRadius's
// expectedTouchedFiles. Tools the with-MCP arm should reach for:
// search_symbols (find components by name/shape), describe_repository (get the
// component inventory), find_dependents (gauge maturity of a candidate).
export const componentDecisionCase: CaseDef<ComponentDecisionParams> = {
  id: 'component-decision',
  extraTools: [],
  buildPrompt(target: Target, p: ComponentDecisionParams): string {
    return `Repo: "${target.name}".

You need to add the following feature:
"""
${p.feature}
"""

List the existing components, hooks, and utilities in this repo that should be REUSED or EXTENDED rather than built from scratch. For each, give:
1. The name (in backticks, e.g. \`DatePicker\`)
2. The file path
3. One sentence on what role it plays in your proposed implementation

Don't invent components — only ones that actually exist in the repo. Group by certainty: "must reuse" vs "probably reuse".`;
  },
  async verify(_target: Target, p: ComponentDecisionParams, run): Promise<VerifierScore> {
    const bareName = (s: string): string => s.split('.').slice(-1)[0] ?? s;
    const cited = extractIdentifiers(run.responseText).map(bareName);
    const truth = p.expectedComponents.map(bareName);
    const beta = 2;
    const r = fBeta(cited, truth, beta);
    return {
      score: Math.round(r.fBeta * 100),
      details: {
        truth,
        cited,
        beta: String(beta),
        precision: r.precision,
        recall: r.recall,
      },
    };
  },
  judgeRubric: {
    dimensions: ['reuse_accuracy', 'coverage', 'role_explanation', 'no_fabrication'],
    description:
      'reuse_accuracy: cited components are genuinely fit for the proposed feature. coverage: identifies the major reusable pieces, not just one. role_explanation: each citation comes with a clear "why this fits". no_fabrication: every citation actually exists in the repo (no invented helpers).',
  },
};
