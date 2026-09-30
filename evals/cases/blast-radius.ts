import type { CaseDef, Target, VerifierScore } from '../harness/types.js';
import { extractTouchedFiles } from '../harness/citations.js';
import { scoreFilePaths } from '../harness/verifier.js';

export interface BlastRadiusParams {
  change: string;
  expectedTouchedFiles: string[];
}

export const blastRadiusCase: CaseDef<BlastRadiusParams> = {
  id: 'blast-radius',
  extraTools: [],
  buildPrompt(target: Target, p: BlastRadiusParams): string {
    return `Repo: "${target.name}".

A change is proposed:
"""
${p.change}
"""

Enumerate every file that would need to be touched and every caller that would be affected. Group by certainty (must-touch vs probably-touch). Cite each file as a backticked path. When more than one repository is involved, write every backticked file citation as \`repo-name/repo-relative/path\`, including files in the target repository.`;
  },
  async verify(_target: Target, p: BlastRadiusParams, run): Promise<VerifierScore> {
    const cited = extractTouchedFiles(run.responseText);
    const truth = p.expectedTouchedFiles.map((f) => f.toLowerCase());
    // The prompt asks for `repo-name/repo-relative/path`, and agents also
    // prepend the workspace directory. Exact equality scored those citations 0
    // against an otherwise perfect answer, so match on whole-segment suffixes.
    const r = scoreFilePaths(cited, truth);
    return {
      score: Math.round(r.f1 * 100),
      details: {
        truth,
        cited,
        matched_truth_files: r.matchedTruth,
        precision: r.precision,
        recall: r.recall,
      },
    };
  },
  judgeRubric: {
    dimensions: ['accuracy', 'completeness', 'certainty_calibration', 'ripple_coverage'],
    description:
      "accuracy: cited files would actually need editing. completeness: doesn't miss obvious files. certainty_calibration: correctly distinguishes must vs probably-touch. ripple_coverage: traces non-obvious second-order effects.",
  },
};
