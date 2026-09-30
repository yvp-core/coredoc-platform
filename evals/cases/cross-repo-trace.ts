import type { CaseDef, Target, VerifierScore } from '../harness/types.js';
import { extractFilePaths } from '../harness/citations.js';
// Path matching lives in the harness so every file-list verifier shares one
// rule (see harness/verifier.ts `matchesPath`).
import { scoreFilePaths } from '../harness/verifier.js';

export interface CrossRepoTraceParams {
  /** HTTP method of the UI-originated call. */
  method: string;
  /** Path template of the UI call (placeholders allowed, e.g. `/v3/.../{companyUuid}/...`). */
  path: string;
  /** Repo names that should appear in the response (chain order: origin → gateway → downstream). */
  expectedRepos: string[];
  /** Optional hand-curated file paths the agent should cite across the chain. */
  expectedTouchedFiles?: string[];
  /**
   * When true, the prompt does NOT presuppose that the target repo's UI issues the call.
   * The default prompt commands "trace ... from the UI", which on a negative-existence cell
   * (curated truth: no UI caller exists) forces an honest agent to either restate a premise
   * the forbidden tier bans or burn its turn budget proving a negative it was told to assume
   * (both observed on the authgate cell, 2026-08-30). This variant asks the agent to first
   * ESTABLISH whether any code in the target repo issues the call, then trace whatever
   * really handles it, and to say where the flow actually goes if the premise fails.
   */
  originUnverified?: boolean;
}

// Real-world scenario: "I want to change behavior X. The UI sends POST /foo.
// What's the full chain — which gateway controller picks it up, which
// downstream service handles it, what files do I have to read?" Tests the
// agent's ability to compose information across repos. Tools the with-MCP arm
// should reach for: list_service_dependencies (find the gateway), search_symbols
// (find the controller across scopes), trace_cross_repo_call (resolve UI call
// to gateway entrypoint), explain (downstream handler details).
export const crossRepoTraceCase: CaseDef<CrossRepoTraceParams> = {
  id: 'cross-repo-trace',
  extraTools: [],
  buildPrompt(target: Target, p: CrossRepoTraceParams): string {
    if (p.originUnverified) {
      return `In repo "${target.name}", investigate the HTTP endpoint \`${p.method} ${p.path}\`.

Cover, in order:
1. Origin — establish whether any code in this repo actually issues this call, and cite it if so. If nothing does, say so explicitly and name where this repo's equivalent flow really goes instead.
2. Handling chain — regardless of the origin answer, trace what serves \`${p.method} ${p.path}\`: which gateway/controller picks it up, which downstream client it forwards to, and which downstream controller + service method ultimately runs.
3. Across-repo data flow — the request input and the response shape along that chain.

Do not assume the origin; verify it. For each hop, name the repo, the file path, and the function/method in backticks. Cite paths to files in each repo.`;
    }
    return `In repo "${target.name}", trace the HTTP call \`${p.method} ${p.path}\` from the UI all the way to the service that actually handles it.

Cover the full chain:
1. UI origin — which component/hook/service issues the call, and in which file
2. API gateway — which controller picks it up, and which downstream client it forwards to
3. Downstream service — which controller + service method ultimately runs
4. Across-repo data flow — the input the UI sends and the response it gets back

For each hop, name the repo, the file path, and the function/method in backticks. Cite paths to files in each repo.`;
  },
  async verify(_target: Target, p: CrossRepoTraceParams, run): Promise<VerifierScore> {
    const responseLower = run.responseText.toLowerCase();
    // Repo names like "demo-shifts" / "sample-admin" / "api-gateway" rarely
    // appear inside backticks, so we substring-match the whole response.
    const repoHits = p.expectedRepos.filter((r) => responseLower.includes(r.toLowerCase()));
    const repoCoverage = p.expectedRepos.length === 0 ? 0 : repoHits.length / p.expectedRepos.length;

    const citedFiles = extractFilePaths(run.responseText);
    const fileScore = scoreFilePaths(citedFiles, p.expectedTouchedFiles ?? []);

    // 50/50 split between "did the agent name every repo in the chain" and
    // "did the agent cite the right files." If no expectedTouchedFiles is
    // supplied, the file half is dropped and repo coverage carries 100%.
    const final = p.expectedTouchedFiles
      ? Math.round(repoCoverage * 50 + fileScore.f1 * 50)
      : Math.round(repoCoverage * 100);

    return {
      score: final,
      details: {
        expectedRepos: p.expectedRepos,
        repoHits,
        repoCoverage,
        citedFiles,
        truthFiles: p.expectedTouchedFiles ?? [],
        matched_truth_files: fileScore.matchedTruth,
        file_precision: fileScore.precision,
        file_recall: fileScore.recall,
      },
    };
  },
  judgeRubric: {
    dimensions: ['chain_completeness', 'repo_identification', 'handler_accuracy', 'no_fabrication'],
    description:
      'chain_completeness: covers every hop UI → gateway → downstream service, not just one end. repo_identification: names each repo in the chain correctly. handler_accuracy: the controllers / service methods named actually handle this path. no_fabrication: no invented files, functions, or repos.',
  },
};
