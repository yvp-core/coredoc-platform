import type { CaseDef, Target, VerifierScore } from '../harness/types.js';
import { extractFilePaths } from '../harness/citations.js';
import { scoreFilePaths } from '../harness/verifier.js';

export interface ImpactDiffParams {
  /** Unified diff (real hunk(s), trimmed to what matters — presented verbatim in the prompt). */
  diff: string;
  /** One-line human summary of the change ("renames X", "changes the return shape of Y"). */
  changeSummary: string;
  /** Files (repo-prefixed where cross-repo) that a reviewer must be pointed at. */
  expectedImpactedFiles: string[];
  /** Optional surfaces that must be NAMED (entrypoint paths, route paths, entity names). */
  expectedImpactedSurfaces?: string[];
}

// Real-world scenario: a PR diff is about to land and the reviewer (or a CI
// gate) needs the blast radius BEFORE merge — across the whole workspace, not
// just the repo the diff touches. This is the machine-consumer slice:
// blast-radius asks about a *described* change inside one repo, this asks about
// a *concrete diff* whose ripple crosses repo boundaries. Tools the with-MCP
// arm should reach for: find_callers / find_dependents (direct + transitive
// consumers of the changed symbols), analyze_change_impact (the whole-file
// blast radius in one call), trace_cross_repo_call (the hop out of the diffed
// repo). Without MCP the agent has to grep the diff's identifiers outward,
// repo by repo, and has no cheap way to know when it has stopped finding.
export const impactDiffCase: CaseDef<ImpactDiffParams> = {
  id: 'impact-diff',
  extraTools: [],
  buildPrompt(target: Target, p: ImpactDiffParams): string {
    return `Repo: "${target.name}".

The following diff is about to be merged. It ${p.changeSummary}.

\`\`\`diff
${p.diff}
\`\`\`

Report the blast radius of this diff BEFORE it lands:
1. Every impacted file and function across the ENTIRE workspace — all repos, not only the repo the diff touches. For each, say in one clause why the diff reaches it.
2. Every impacted public surface — HTTP endpoints, routes, entities/tables — that a consumer could observe changing.
3. What has to be re-tested, keyed to the impacted surfaces above.

Name every file, function, endpoint, route and entity in backticks and cite the path of each file you name. List only what this diff can actually affect — do not pad the answer with files that merely live nearby or with speculative "might also want to check" entries.`;
  },
  async verify(_target: Target, p: ImpactDiffParams, run): Promise<VerifierScore> {
    const citedFiles = extractFilePaths(run.responseText);
    const fileScore = scoreFilePaths(citedFiles, p.expectedImpactedFiles);

    // Surfaces are endpoint/route/entity strings that rarely survive intact
    // inside backticks (`POST /v1/foo` vs `/v1/foo`), so they're matched as a
    // case-insensitive substring over the whole response.
    const responseLower = run.responseText.toLowerCase();
    const surfaces = p.expectedImpactedSurfaces ?? [];
    const surfaceHits = surfaces.filter((s) => responseLower.includes(s.toLowerCase()));
    const surfaceCoverage = surfaces.length === 0 ? 0 : surfaceHits.length / surfaces.length;

    // 70/30 split: getting the file set right (both recall AND precision — the
    // padding penalty lives in the F1) is the primary signal; naming the
    // observable surfaces is the secondary one. When a target supplies no
    // surfaces, that half is dropped and files carry 100%.
    const final =
      surfaces.length === 0
        ? Math.round(fileScore.f1 * 100)
        : Math.round(fileScore.f1 * 70 + surfaceCoverage * 30);

    return {
      score: final,
      details: {
        citedFiles,
        truthFiles: p.expectedImpactedFiles,
        matched_truth_files: fileScore.matchedTruth,
        missed_truth_files: p.expectedImpactedFiles.filter(
          (t) => !fileScore.matchedTruth.includes(t),
        ),
        file_precision: fileScore.precision,
        file_recall: fileScore.recall,
        file_f1: fileScore.f1,
        expectedSurfaces: surfaces,
        surfaceHits,
        missedSurfaces: surfaces.filter((s) => !surfaceHits.includes(s)),
        surfaceCoverage,
      },
    };
  },
  judgeRubric: {
    dimensions: [
      'impact_coverage',
      'cross_repo_awareness',
      'precision_no_padding',
      'retest_actionability',
    ],
    description:
      'impact_coverage: enumerates the files, functions and public surfaces the diff actually reaches, including second-order consumers rather than only the files the diff edits. cross_repo_awareness: looks past the repo the diff lives in and reports (or explicitly rules out) impact in the other repos of the workspace. precision_no_padding: everything listed is genuinely reachable from this diff — no nearby-but-unaffected files, no speculative "might also check" filler, no invented paths. retest_actionability: the re-test list is specific enough to act on (names the endpoints, routes, or suites to exercise) and is tied to the impacts identified above rather than generic advice.',
  },
};
