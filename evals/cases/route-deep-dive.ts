import type { CaseDef, Target, VerifierScore } from '../harness/types.js';
import { extractFilePaths, extractIdentifiers } from '../harness/citations.js';
import { f1, getEvalRepository, repoHashFor } from '../harness/verifier.js';

export interface RouteDeepDiveParams {
  /** Route path as it appears in the graph (e.g. "/requests" or "[base]/list"). */
  path: string;
  /** Component name that handles the route (the `componentName` on the route node). */
  component: string;
  expectedReachableFunctions?: string[];
  expectedFiles?: string[];
}

// Real-world scenario: "What does the /requests page actually do?" The agent
// must locate the route, identify the rendered component, and surface the
// downstream work (hooks, callees, API surface). Tools the with-MCP arm should
// reach for: search_symbols (find the route + component), explain
// (component internals, detailLevel: full — component → terminals).
export const routeDeepDiveCase: CaseDef<RouteDeepDiveParams> = {
  id: 'route-deep-dive',
  extraTools: [],
  buildPrompt(target: Target, p: RouteDeepDiveParams): string {
    return `In repo "${target.name}", explain the route \`${p.path}\`.

Cover:
1. The component that handles the route (name + file)
2. What the page does (one paragraph)
3. Key hooks the component uses (custom hooks, not built-ins like useState/useEffect)
4. Downstream functions the component reaches via the call chain (depth 3 is fine)
5. Backend HTTP endpoints called from the page subtree, if any
6. Auth / permission gates at the boundary

Cite component, hook, and function names in backticks. Cite file paths in backticks.`;
  },
  async verify(target: Target, p: RouteDeepDiveParams, run): Promise<VerifierScore> {
    const truthFunctions: string[] = [];
    const truthFiles: string[] = [];
    let rootsFound = 0;

    if (p.expectedReachableFunctions || p.expectedFiles) {
      if (p.expectedReachableFunctions) truthFunctions.push(...p.expectedReachableFunctions);
      else truthFunctions.push(p.component);
      if (p.expectedFiles) truthFiles.push(...p.expectedFiles);
      rootsFound = -1; // sentinel: override mode, not applicable
    } else {
      const repo = await getEvalRepository();
      const hash = await repoHashFor(target.repoKey);

      truthFunctions.push(p.component);
      const seen = new Set<string>();
      const roots: string[] = [];

      // Resolve the component into BFS-walkable roots. React class components
      // park their CALLS edges on methods (render / componentDidMount / …),
      // not on the class node itself — so for classes we look up the class
      // and then adopt every method whose owning class matches as a root.
      const cls = await repo.findClass(p.component, [hash]);
      if (cls) {
        if (!truthFiles.includes(cls.filePath)) truthFiles.push(cls.filePath);
        // Try the common React class-component lifecycle methods. findFunction
        // with className narrows the lookup; misses (a class without that
        // hook) come back as null and are simply skipped.
        for (const m of ['render', 'componentDidMount', 'componentDidUpdate', 'componentWillUnmount']) {
          const fn = await repo.findFunction(m, [hash], cls.filePath, p.component);
          if (fn && !seen.has(fn.id)) {
            seen.add(fn.id);
            roots.push(fn.id);
            truthFunctions.push(fn.name);
          }
        }
      }

      // Functional component: a top-level function node with the component name.
      const fn = await repo.findFunction(p.component, [hash]);
      if (fn && !seen.has(fn.id)) {
        seen.add(fn.id);
        roots.push(fn.id);
        if (!truthFiles.includes(fn.filePath)) truthFiles.push(fn.filePath);
      }

      rootsFound = roots.length;

      // BFS callees up to depth 3 — same depth as entrypointDeepDive uses.
      let frontier = [...roots];
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

    const bareName = (s: string): string => s.split('.').slice(-1)[0] ?? s;
    const citedIdents = extractIdentifiers(run.responseText).filter((s) => s !== p.path);
    const fnScore = f1(citedIdents.map(bareName), truthFunctions.map(bareName));

    const citedFiles = extractFilePaths(run.responseText);
    const componentFileHit = truthFiles[0] && citedFiles.includes(truthFiles[0]) ? 1 : 0;

    // 70 pts identifier F1 + 30 pts for citing the component's home file.
    // Mirrors entrypoint-deep-dive's weighting.
    const final = Math.round(fnScore.f1 * 70 + componentFileHit * 30);

    return {
      score: final,
      details: {
        component: p.component,
        rootsFound,
        truthFunctions,
        cited: citedIdents,
        precision: fnScore.precision,
        recall: fnScore.recall,
        component_file_cited: componentFileHit ? 'yes' : 'no',
      },
    };
  },
  judgeRubric: {
    dimensions: ['component_identification', 'hook_coverage', 'downstream_coverage', 'accuracy'],
    description:
      'component_identification: correctly names the rendered component and its file. hook_coverage: identifies the custom hooks the component depends on. downstream_coverage: lists callees + API endpoints reached from the page, not just the page itself. accuracy: every named function/hook/endpoint actually exists in the code.',
  },
};
