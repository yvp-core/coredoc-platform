import type { CaseDef, Target, VerifierScore } from '../harness/types.js';
import { extractFilePaths } from '../harness/citations.js';
import { checkPathsExist, scoreFromExistence } from '../harness/verifier.js';

export const explainRepoCase: CaseDef<Record<string, never>> = {
  id: 'explain-repo',
  extraTools: [],
  buildPrompt(target: Target): string {
    return `You are reviewing the repository "${target.name}".

Produce a 300–500 word overview covering:
- Top-level purpose and what problem this repo solves
- Package or module boundaries (if applicable)
- Primary entrypoints (HTTP routes, CLI commands, public APIs, event handlers)
- Key data models and how data flows between packages
- Notable cross-package call paths or integration points

Cite specific file paths inline using backticks (e.g. \`packages/x/src/y.ts\`). Only cite paths that actually exist.`;
  },
  async verify(target: Target, _params, run): Promise<VerifierScore> {
    const cited = extractFilePaths(run.responseText);
    const flags = checkPathsExist(target, cited);
    const score = scoreFromExistence(flags);
    return {
      score,
      details: {
        cited,
        existing: cited.filter((_, i) => flags[i]),
        missing: cited.filter((_, i) => !flags[i]),
      },
    };
  },
  judgeRubric: {
    dimensions: ['accuracy', 'completeness', 'structural_clarity', 'depth'],
    description:
      'accuracy: claims match reality. completeness: covers purpose, packages, entrypoints, data models, cross-package paths. structural_clarity: well organized, easy to follow. depth: goes beyond surface restatement.',
  },
};
