import type { CaseDef, Target, VerifierScore } from '../harness/types.js';
import { extractIdentifiers } from '../harness/citations.js';
import { f1 } from '../harness/verifier.js';

export interface CallerIntersectionParams {
  hookA: string;
  hookB: string;
  /**
   * Hand-curated components/functions that invoke BOTH hooks in the same
   * enclosing function.
   */
  expectedComponents: string[];
}

// Real-world scenario: "Show me every component that does the X+Y pattern."
// Classic code-review / audit question. MCP wins: two find_callers, intersect
// by caller name. Without MCP: two `rg -l` lists, intersect file paths,
// then Read each file to identify the enclosing function name. Tedious AND
// error-prone when a file has multiple components.
//
// Scoring: recall-weighted F1. The truth set is small enough (5-20) that
// recall matters most; precision is tracked but lightly weighted.
export const callerIntersectionCase: CaseDef<CallerIntersectionParams> = {
  id: 'caller-intersection',
  extraTools: [],
  buildPrompt(target: Target, p: CallerIntersectionParams): string {
    return `In repo "${target.name}", find every component (or function) that invokes BOTH \`${p.hookA}\` AND \`${p.hookB}\` within the same enclosing function body.

**Goal: COMPLETE enumeration.** There may be 10-25 matches. List every one.

**Strategy (do in this order — don't skip the enumeration step to "verify deeper"):**
1. Get the caller set for \`${p.hookA}\`.
2. Get the caller set for \`${p.hookB}\`.
3. Compute the intersection by enclosing-function name (or by file path, if names are ambiguous).
4. List **EVERY name in the intersection** in the response BEFORE any deep verification.
5. Only after listing all matches: spot-check any ambiguous cases (e.g., a file with two components, only one of which uses both hooks).

For each match, give:
1. The enclosing component / function name in backticks
2. The file path
3. A short phrase (5-10 words) on what the combination does — \`'gates restore by entitlement'\`, \`'project-scoped feature flag'\`, etc.

Do NOT spend the entire budget verifying individual matches in detail. Breadth over depth — every match named is better than a few matches deeply explained.

Don't include files that import both hooks but use them in different functions. Don't include tests, stories, mocks. Don't speculate.`;
  },
  async verify(_target: Target, p: CallerIntersectionParams, run): Promise<VerifierScore> {
    const bareName = (s: string): string => s.split('.').slice(-1)[0] ?? s;
    const cited = extractIdentifiers(run.responseText)
      // Drop the hooks themselves — agents repeat them across the response.
      .filter((s) => bareName(s) !== p.hookA && bareName(s) !== p.hookB);
    const truth = p.expectedComponents;
    const r = f1(cited.map(bareName), truth.map(bareName));
    // 65 recall + 25 precision + 10 floor. The case asks the agent to find
    // EVERY intersection match — recall drives the score.
    const final = Math.round(r.recall * 65 + r.precision * 25 + 10);
    return {
      score: final,
      details: {
        hookA: p.hookA,
        hookB: p.hookB,
        truth,
        cited,
        precision: r.precision,
        recall: r.recall,
      },
    };
  },
  judgeRubric: {
    dimensions: ['intersection_coverage', 'pattern_specificity', 'accuracy', 'no_fabrication'],
    description:
      'intersection_coverage: identifies every component that uses BOTH hooks together. pattern_specificity: distinguishes "both hooks in the same function" from "both hooks imported but used separately". accuracy: each cited component genuinely invokes both hooks. no_fabrication: every cited component exists.',
  },
};
