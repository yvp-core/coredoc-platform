import type { CaseDef, Target, VerifierScore } from '../harness/types.js';
import { extractFilePaths, extractIdentifiers } from '../harness/citations.js';
import { f1, getEvalRepository, repoHashFor } from '../harness/verifier.js';

export interface EntrypointDeepDiveParams {
  /** HTTP method (e.g. "POST") or omit for non-HTTP entrypoints. */
  method?: string;
  /** Route path ("/workspaces/{workspaceId}/members/invites") or CLI command name. */
  path: string;
  expectedReachableFunctions?: string[];
  expectedReachableFiles?: string[];
}

// Real-world scenario: "I see POST /v1/X in the gateway logs — what does it
// actually do?" The agent must locate the entrypoint, identify its handler,
// and surface the downstream work (callees, entities touched, side effects).
// Tools the with-MCP arm should naturally reach for: list_entrypoints (find
// the route), explain (handler details, detailLevel: full — entrypoint →
// terminals).
export const entrypointDeepDiveCase: CaseDef<EntrypointDeepDiveParams> = {
  id: 'entrypoint-deep-dive',
  extraTools: [],
  buildPrompt(target: Target, p: EntrypointDeepDiveParams): string {
    const label = p.method ? `${p.method} \`${p.path}\`` : `\`${p.path}\``;
    return `In repo "${target.name}", explain the entrypoint ${label}.

Cover:
1. Handler function name and file
2. What the handler does (one paragraph)
3. Downstream calls — every function the handler reaches via the call chain (depth 3 is fine)
4. Database entities touched and how (read/write/delete)
5. External services called (HTTP, queue, etc.) if any
6. Auth / permission checks at the boundary

Cite handler and downstream function names in backticks. Cite file paths in backticks too.`;
  },
  async verify(target: Target, p: EntrypointDeepDiveParams, run): Promise<VerifierScore> {
    const truthFunctions: string[] = [];
    const truthFiles: string[] = [];
    let handlerName = '';
    let entrypointFound = false;

    if (p.expectedReachableFunctions || p.expectedReachableFiles) {
      // Hand-curated override — first function in the curated list is treated
      // as the handler; first file is the entry file (for handler-file-hit
      // scoring). Both lists fully replace graph BFS truth.
      if (p.expectedReachableFunctions) {
        truthFunctions.push(...p.expectedReachableFunctions);
        handlerName = p.expectedReachableFunctions[0] ?? '';
      }
      if (p.expectedReachableFiles) truthFiles.push(...p.expectedReachableFiles);
      entrypointFound = true;
    } else {
      const repo = await getEvalRepository();
      const hash = await repoHashFor(target.repoKey);

      // Locate the entrypoint by path (and method, if HTTP). pathPattern is a
      // substring match in the repo; we tighten with method to disambiguate.
      const entries = await repo.listEntrypoints({ pathPattern: p.path, limit: 50 }, [hash]);
      const ep = entries.find(
        (e) =>
          (!p.method || e.method === p.method) && (e.path === p.path || e.fullPath === p.path),
      );
      entrypointFound = !!ep;

      if (ep) {
        if (ep.handlerName) {
          truthFunctions.push(ep.handlerName);
          handlerName = ep.handlerName;
        }
        if (ep.handlerId) {
          // BFS the call chain (no IGraphRepository.getTransitiveCallees yet —
          // we walk getDirectCallees ourselves). Depth-capped at 3 to mirror
          // the "depth=3 is fine" prompt instruction; node cap prevents runaway
          // in pathological highly-connected graphs.
          const seen = new Set<string>([ep.handlerId]);
          let frontier: string[] = [ep.handlerId];
          const NODE_CAP = 200;
          for (let d = 0; d < 3 && frontier.length > 0 && seen.size < NODE_CAP; d++) {
            const next: string[] = [];
            for (const id of frontier) {
              const callees = await repo.getDirectCallees(id, [hash]);
              for (const c of callees) {
                if (seen.has(c.id)) continue;
                seen.add(c.id);
                truthFunctions.push(c.name);
                if (c.filePath && !truthFiles.includes(c.filePath)) truthFiles.push(c.filePath);
                next.push(c.id);
                if (seen.size >= NODE_CAP) break;
              }
              if (seen.size >= NODE_CAP) break;
            }
            frontier = next;
          }
        }
        if (ep.filePath && !truthFiles.includes(ep.filePath)) truthFiles.push(ep.filePath);
      }
    }

    const bareName = (s: string): string => s.split('.').slice(-1)[0] ?? s;
    const citedIdents = extractIdentifiers(run.responseText);
    const citedFunctions = citedIdents.map(bareName);
    const fnScore = f1(citedFunctions, truthFunctions.map(bareName));

    const citedFiles = extractFilePaths(run.responseText);
    const handlerFileHit = handlerName && truthFiles[0] && citedFiles.includes(truthFiles[0]) ? 1 : 0;

    // Prompt asks "downstream calls — every function the handler reaches"
    // — primarily a recall question. The 2026-05-14 eval consistently
    // showed prog 30-60 vs judge 70-80 across 3 targets: agents listed
    // the handler + key downstream functions accurately (good recall) but
    // also backticked supporting tokens (DTOs, params, types) that F1
    // counts as false positives. Recall-weighted scoring matches the
    // prompt's intent and aligns prog with judge.
    const final = Math.round(
      fnScore.recall * 50 + fnScore.precision * 20 + handlerFileHit * 30,
    );

    return {
      score: final,
      details: {
        entrypointFound: entrypointFound ? 'yes' : 'no',
        handler: handlerName || 'unknown',
        truthFunctions,
        cited: citedFunctions,
        precision: fnScore.precision,
        recall: fnScore.recall,
        handler_file_cited: handlerFileHit ? 'yes' : 'no',
      },
    };
  },
  judgeRubric: {
    dimensions: ['handler_identification', 'downstream_coverage', 'side_effect_coverage', 'accuracy'],
    description:
      'handler_identification: correctly names the handler function and file. downstream_coverage: lists the functions/entities the handler reaches, not just the handler itself. side_effect_coverage: identifies DB writes, external calls, and auth checks. accuracy: technical claims match the code; no fabricated functions/entities.',
  },
};
