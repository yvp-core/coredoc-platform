import type { CaseDef, Target, VerifierScore } from '../harness/types.js';
import { extractFilePaths } from '../harness/citations.js';
import { matchesPath } from '../harness/verifier.js';

export interface BackendFrontendPairParams {
  /** Backend endpoint to trace from — method + path with placeholders kept literal. */
  endpoint: { method: string; path: string };
  /**
   * Hand-curated files that consume the endpoint: the data hook that wraps
   * it, the page(s) that render results, and the component(s) that trigger
   * the call. 3-7 entries typically.
   */
  expectedFiles: string[];
}

const FRONTEND_ROLES = ['hook', 'page', 'component'] as const;
type FrontendRole = (typeof FRONTEND_ROLES)[number];

function normalizeFilePath(path: string): string {
  return path.replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase();
}

// One-to-one variant of the shared file-path scorer: a single citation may
// only satisfy one truth entry here, so duplicated citations cannot inflate
// recall. The equivalence rule itself is the harness-wide `matchesPath`.
function scoreFilePaths(cited: string[], truth: string[]) {
  const availableCitations = new Set(cited.map((_, index) => index));
  const matchedTruth: string[] = [];
  const matchedCited: string[] = [];

  for (const truthPath of truth) {
    const match = [...availableCitations].find((index) =>
      matchesPath(cited[index] ?? '', truthPath),
    );
    if (match === undefined) continue;
    availableCitations.delete(match);
    matchedTruth.push(truthPath);
    matchedCited.push(cited[match] ?? '');
  }

  return {
    matchedTruth,
    matchedCited,
    precision: cited.length === 0 ? 0 : matchedCited.length / cited.length,
    recall: truth.length === 0 ? 0 : matchedTruth.length / truth.length,
  };
}

// Current manifests carry only file paths, not structured frontend roles.
// These stable path conventions are therefore the narrowest deterministic
// check that distinguishes a UI trace from a backend-only service chain.
function rolesForPath(path: string): FrontendRole[] {
  const normalized = `/${normalizeFilePath(path)}`;
  const roles: FrontendRole[] = [];

  if (
    /\/(?:hooks?|data|api)\//.test(normalized) ||
    /(?:query|logic)\.[a-z]+$/.test(normalized)
  ) {
    roles.push('hook');
  }
  if (/\/(?:pages?|routes?|scenes?)\//.test(normalized)) roles.push('page');
  if (/\/components?\//.test(normalized) || /\.(?:tsx|jsx)$/.test(normalized)) {
    roles.push('component');
  }

  return roles;
}

// Real-world scenario: "Backend endpoint X is hit. Who in the UI calls it?"
// Reverse-trace from server to client. Tools the with-MCP arm should reach
// for: search_symbols (locate the hook by url string), find_dependents
// (walk who imports the hook), describe_repository (orient).
//
// Why MCP wins here vs grep: grep finds the literal URL in one file (the
// hook). Then the agent must grep the hook's exported name to find pages.
// Pages may use the hook via re-exports or via context — multiple hops.
// MCP's `find_dependents` walks the import + usage graph in one query.
//
// Scoring: recall-weighted F1 on file paths (50/50 recall/precision unlike
// feature-implementation-plan, because the truth set is small (3-7) and a
// precision-weighted score keeps the bar honest).
export const backendFrontendPairCase: CaseDef<BackendFrontendPairParams> = {
  id: 'backend-frontend-pair',
  extraTools: [],
  buildPrompt(target: Target, p: BackendFrontendPairParams): string {
    return `In repo "${target.name}", the backend endpoint **${p.endpoint.method} \`${p.endpoint.path}\`** is consumed somewhere in the studio UI.

Trace the endpoint from server to client. Identify:
1. The data hook (file + exported name in backticks) that wraps this endpoint
2. The page(s) (URL + file path) that ultimately render data from this endpoint
3. The component(s) responsible for triggering the call or rendering the result (file path + component name)

Cite every file path in backticks. Don't invent paths.`;
  },
  async verify(_target: Target, p: BackendFrontendPairParams, run): Promise<VerifierScore> {
    const cited = extractFilePaths(run.responseText);
    const truth = p.expectedFiles.map((f) => f.toLowerCase());
    const fileScore = scoreFilePaths(cited, truth);
    const matchedRoles = new Set<FrontendRole>();
    for (const path of fileScore.matchedTruth) {
      for (const role of rolesForPath(path)) matchedRoles.add(role);
    }
    const frontendRoles = FRONTEND_ROLES.filter((role) => matchedRoles.has(role));
    const frontendRoleCoverage = frontendRoles.length / FRONTEND_ROLES.length;
    // 60/40 recall/precision — recall matters most ("did you find the
    // consumers?") but precision matters too (the case asks for THE hook,
    // THE pages — not a fan-out of related files). Role coverage gates that
    // path score so an exact backend-only chain cannot pass as a UI trace.
    const pathScore = fileScore.recall * 60 + fileScore.precision * 40;
    const final = Math.round(pathScore * frontendRoleCoverage);
    return {
      score: final,
      details: {
        truth,
        cited,
        matched_truth_files: fileScore.matchedTruth,
        matched_cited_files: fileScore.matchedCited,
        file_precision: fileScore.precision,
        file_recall: fileScore.recall,
        precision: fileScore.precision,
        recall: fileScore.recall,
        frontend_roles: frontendRoles,
        frontend_role_coverage: frontendRoleCoverage,
        endpoint: `${p.endpoint.method} ${p.endpoint.path}`,
      },
    };
  },
  judgeRubric: {
    dimensions: ['hook_identification', 'page_traceback', 'component_naming', 'accuracy'],
    description:
      'hook_identification: correctly names the data hook (file + exported function) wrapping the endpoint. page_traceback: identifies the page(s) that ultimately consume the hook, not just the immediate caller. component_naming: names the component(s) that trigger the call or render results. accuracy: no fabricated file paths, hook names, or pages.',
  },
};
