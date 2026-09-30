import type { CaseDef, Target, VerifierScore } from '../harness/types.js';

export interface EntrypointPermissionAuditParams {
  /**
   * Per-target hint describing the repo's auth pattern. The case prompt
   * embeds this verbatim. Examples:
   *   "Pages API routes use `apiWrapper(req, res, handler, { withAuth: true })`
   *    in pages/api/ to require auth; public routes either omit
   *    apiWrapper or omit { withAuth: true }."
   *   "Django REST ViewSets inheriting `TeamAndOrgViewSetMixin` (defined in
   *    app/api/routing.py) require authentication; views with
   *    `permission_classes = [AllowAny]` are public."
   */
  authPatternHint: string;
  expectedAuthenticated: string[];
  expectedUnauthenticated: string[];
}

// Real-world scenario: security audit — which routes are protected, which
// aren't? MCP wins via list_entrypoints + per-entrypoint metadata
// (the parser captures the auth annotation). Without MCP, the agent must
// glob-enumerate route files and read each to check the apiWrapper pattern.
//
// Scoring: per-route recall on each list separately, then averaged. We
// don't punish for ordering or extra commentary — only "did the agent
// correctly classify every route?".
export const entrypointPermissionAuditCase: CaseDef<EntrypointPermissionAuditParams> = {
  id: 'entrypoint-permission-audit',
  extraTools: [],
  buildPrompt(target: Target, p: EntrypointPermissionAuditParams): string {
    return `In repo "${target.name}", audit every HTTP API entrypoint. Determine which require authentication and which are public.

**Auth pattern hint for this repo:** ${p.authPatternHint}

Produce TWO grouped lists, in this exact order:
1. **Authenticated routes** — every URL path that requires auth
2. **Unauthenticated routes** — every URL path that is public

For each list, give the full count, then enumerate every route path. Cite paths in backticks, using the canonical URL form for this repo's router, including any path parameters (e.g. \`/api/things/{id}/\`).

Don't include test files. Completeness matters. Don't speculate — every cited path must correspond to a real registered route.`;
  },
  async verify(_target: Target, p: EntrypointPermissionAuditParams, run): Promise<VerifierScore> {
    // Section-aware scoring: a path counts as "correctly classified" only
    // if it appears in the response in the same logical section the truth
    // says it belongs to. Previous version did pure substring match and
    // both arms hit 100% trivially because they listed every path — but
    // the classification (auth vs not) was invisible to the score. The
    // 2026-05-15T23-11-09 eval showed both arms at 100/100; misclassifications
    // would have been lost in the noise. Tighten by splitting the
    // response at the first unauthenticated-section marker.
    const text = run.responseText;
    const lower = text.toLowerCase();

    // Find the boundary between the auth and unauth sections. Order of
    // patterns matters — Markdown headers / bold labels first, then any
    // standalone occurrence of the section keyword.
    const boundaryPatterns: RegExp[] = [
      /(^|\n)\s*#+\s*(?:unauthenticated|public|no\s*auth|without\s*auth)/i,
      /(^|\n)\s*\*\*(?:unauthenticated|public|no\s*auth|without\s*auth)/i,
      /(^|\n)\s*\d+[.)]\s*(?:unauthenticated|public|no\s*auth|without\s*auth)/i,
      /\bunauthenticated\s+routes?\b/i,
      /\bunauthenticated\s+\(/i,
      /\bunauthenticated\b/i,
    ];
    let boundary = -1;
    for (const re of boundaryPatterns) {
      const m = lower.match(re);
      if (m && m.index !== undefined) {
        boundary = m.index;
        break;
      }
    }

    // If no boundary found, treat the whole response as the auth section.
    // Truth-unauth paths will all count as misclassified, which is the
    // right verdict — the agent didn't actually distinguish.
    const authSection = boundary >= 0 ? lower.slice(0, boundary) : lower;
    const unauthSection = boundary >= 0 ? lower.slice(boundary) : '';

    const classify = (path: string): 'auth' | 'unauth' | 'missing' => {
      const pl = path.toLowerCase();
      const inAuth = authSection.includes(pl);
      const inUnauth = unauthSection.includes(pl);
      if (inAuth && !inUnauth) return 'auth';
      if (inUnauth && !inAuth) return 'unauth';
      if (inAuth && inUnauth) {
        // Mentioned in both sections — judge by which mention is closer
        // to the path's truth section. Conservatively count as "missing"
        // because the agent didn't commit to a classification.
        return 'missing';
      }
      return 'missing';
    };

    let correctAuth = 0;
    let wrongAuth = 0;
    for (const path of p.expectedAuthenticated) {
      const c = classify(path);
      if (c === 'auth') correctAuth += 1;
      else if (c === 'unauth') wrongAuth += 1;
    }
    let correctUnauth = 0;
    let wrongUnauth = 0;
    for (const path of p.expectedUnauthenticated) {
      const c = classify(path);
      if (c === 'unauth') correctUnauth += 1;
      else if (c === 'auth') wrongUnauth += 1;
    }

    const totalTruth = p.expectedAuthenticated.length + p.expectedUnauthenticated.length;
    const correct = correctAuth + correctUnauth;
    const wrong = wrongAuth + wrongUnauth;
    // Score = correct - wrong (each misclassification cancels a correct).
    // Floor at 0. A response that lists every path but doesn't section
    // them scores ~50 (one class right, the other wrong). A response
    // that perfectly sections + lists every path scores 100.
    const netCorrect = Math.max(0, correct - wrong);
    const finalRaw = totalTruth === 0 ? 0 : netCorrect / totalTruth;
    const final = Math.round(finalRaw * 90 + 10);

    return {
      score: final,
      details: {
        truth_authed_count: p.expectedAuthenticated.length,
        truth_unauthed_count: p.expectedUnauthenticated.length,
        correct_auth: correctAuth,
        correct_unauth: correctUnauth,
        misclassified_auth_as_unauth: wrongAuth,
        misclassified_unauth_as_auth: wrongUnauth,
        boundary_found: boundary >= 0 ? 'yes' : 'no',
        net_correct_pct: finalRaw,
      },
    };
  },
  judgeRubric: {
    dimensions: ['enumeration_coverage', 'auth_classification', 'list_completeness', 'no_fabrication'],
    description:
      "enumeration_coverage: lists every HTTP API entrypoint in the repo's route surface. auth_classification: correctly labels each as authenticated or not. list_completeness: counts match the actual file inventory. no_fabrication: every cited route exists as a real file.",
  },
};
