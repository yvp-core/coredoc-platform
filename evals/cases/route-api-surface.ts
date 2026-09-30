import type { CaseDef, Target, VerifierScore } from '../harness/types.js';
import { extractFilePaths } from '../harness/citations.js';
import { getEvalRepository, repoHashFor, scoreFilePaths } from '../harness/verifier.js';

export interface RouteApiSurfaceParams {
  /** Route path as it appears in the graph. */
  path: string;
  /** Component name that handles the route. */
  component: string;
  expectedEndpoints?: { method: string; path: string }[];
  expectedFiles?: string[];
}

// Canonicalize route templates so a manifest path, a leading-slash citation,
// and an absolute URL citation all identify the same endpoint pathname.
function normalizeHttpPath(p: string): string {
  const pathname = p.replace(/^https?:\/\/[^/]+/i, '').replace(/\?.*$/, '');
  const withLeadingSlash = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const canonical = withLeadingSlash.replace(/\{[^}]+\}/g, ':param').toLowerCase();
  // Collapse a trailing slash. Frameworks disagree about it for the SAME endpoint (Django's
  // routers append one, the client SDK usually omits it) and the manifests carry both
  // spellings, so without this the truth key and a correctly formatted answer never meet.
  return canonical.length > 1 ? canonical.replace(/\/+$/, '') : canonical;
}

function endpointKey(method: string, path: string): string {
  return `${method.trim().toUpperCase()} ${normalizeHttpPath(path)}`;
}

function extractResponseEndpoints(responseText: string): Set<string> {
  const endpoints = new Set<string>();
  const withoutMarkdown = responseText.replace(/[`*]/g, '');
  // The path alternative accepts a LEADING-SLASH-LESS spelling (`api/projects/{id}/…`) as well
  // as an absolute URL or a rooted path: that bare form is how the manifests store endpoints and
  // how several codebases write them in their own client modules, and requiring the slash made a
  // correctly-cited answer extract to nothing and score zero. normalizeHttpPath re-roots it.
  const endpointPattern =
    /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|HTTP)\b[\s|:–—-]{1,20}(https?:\/\/[^\s|,;)]+|\/[^\s|,;)]+|[A-Za-z0-9_.{}:-]+(?:\/[^\s|,;)]*)+)/gi;

  for (const match of withoutMarkdown.matchAll(endpointPattern)) {
    const method = match[1];
    const path = match[2]?.replace(/[.;]+$/, '');
    if (!method || !path) continue;
    endpoints.add(endpointKey(method, path));
  }

  return endpoints;
}

// Drop garbage paths the parser captured as `pathTemplate` when the call
// site used a variable rather than a string literal. The 2026-05-14 eval
// saw sample-admin's truth set degenerate to `['GET url']` (the parser
// captured the local var name `url` from `axios.get(url, …)` — same for
// `/`, `{p}/{uuid}`, `https:/…` with missing slashes). A truth set of a
// single bogus path made the score essentially random — the agent that
// happened to write the word "url" in prose got 100% recall on garbage,
// while a more rigorous answer got 0%.
function isRealPathTemplate(p: string): boolean {
  if (!p || p.length < 4) return false;
  // Must start with `/` or `http(s)://`
  if (!p.startsWith('/') && !/^https?:\/\//.test(p)) return false;
  // Reject "all placeholders" patterns like `/{p}/{uuid}` — no literal
  // segment. The agent can't recognize these as routes.
  const stripped = p.replace(/\{[^}]+\}/g, '').replace(/[/:]/g, '');
  if (stripped.length < 2) return false;
  return true;
}

// Real-world scenario: "Before I touch this page, what's the API contract?
// Which backend endpoints will I have to keep stable?" The agent must walk
// the component subtree and enumerate every outbound HTTP call. Tools the
// with-MCP arm should reach for: explain (detailLevel: full), find_dependents,
// list_service_dependencies.
export const routeApiSurfaceCase: CaseDef<RouteApiSurfaceParams> = {
  id: 'route-api-surface',
  extraTools: [],
  buildPrompt(target: Target, p: RouteApiSurfaceParams): string {
    return `In repo "${target.name}", the route \`${p.path}\` renders a page. Enumerate every backend HTTP endpoint the page (and the functions it transitively calls) hits.

For each endpoint, give:
1. HTTP method and path (use the original path template — keep placeholders like \`{companyUuid}\`)
2. The local function or hook that issues the call (in backticks)
3. The file path of that function

Group by feature area if there are many. Don't speculate — only include endpoints you can verify in the code.`;
  },
  async verify(target: Target, p: RouteApiSurfaceParams, run): Promise<VerifierScore> {
    const truthPaths = new Map<string, { method: string; path: string; filePath: string }>();
    const truthFiles = new Set<string>();

    if (p.expectedEndpoints || p.expectedFiles) {
      if (p.expectedEndpoints) {
        for (const ep of p.expectedEndpoints) {
          truthPaths.set(endpointKey(ep.method, ep.path), {
            method: ep.method,
            path: ep.path,
            filePath: '',
          });
        }
      }
      if (p.expectedFiles) for (const f of p.expectedFiles) truthFiles.add(f);
    } else {
      const repo = await getEvalRepository();
      const hash = await repoHashFor(target.repoKey);

      // Same root-resolution strategy as route-deep-dive: class methods +
      // functional-component function node. See that file for rationale.
      const seenRoots = new Set<string>();
      const roots: string[] = [];

      const cls = await repo.findClass(p.component, [hash]);
      if (cls) {
        for (const m of ['render', 'componentDidMount', 'componentDidUpdate', 'componentWillUnmount']) {
          const fn = await repo.findFunction(m, [hash], cls.filePath, p.component);
          if (fn && !seenRoots.has(fn.id)) {
            seenRoots.add(fn.id);
            roots.push(fn.id);
          }
        }
      }
      const fn = await repo.findFunction(p.component, [hash]);
      if (fn && !seenRoots.has(fn.id)) {
        seenRoots.add(fn.id);
        roots.push(fn.id);
      }

      // BFS callees to depth 4 — one hop deeper than route-deep-dive because
      // API call sites are typically nested behind a hook + a service module.
      const reached = new Set<string>(roots);
      let frontier = [...roots];
      const NODE_CAP = 400;
      for (let d = 0; d < 4 && frontier.length > 0 && reached.size < NODE_CAP; d++) {
        const next: string[] = [];
        for (const id of frontier) {
          const callees = await repo.getDirectCallees(id, [hash]);
          for (const c of callees) {
            if (reached.has(c.id)) continue;
            reached.add(c.id);
            next.push(c.id);
            if (reached.size >= NODE_CAP) break;
          }
          if (reached.size >= NODE_CAP) break;
        }
        frontier = next;
      }

      // For every reached function, look up its outbound external_calls and
      // collect distinct HTTP path templates + the files those calls live in.
      for (const id of reached) {
        const calls = await repo.getExternalCallsFrom(id, [hash]);
        for (const c of calls) {
          if (c.protocol !== 'http' || !c.pathTemplate) continue;
          if (!isRealPathTemplate(c.pathTemplate)) continue;
          const key = endpointKey(c.httpMethod || 'HTTP', c.pathTemplate);
          if (!truthPaths.has(key)) {
            truthPaths.set(key, {
              method: c.httpMethod || 'HTTP',
              path: c.pathTemplate,
              filePath: c.filePath,
            });
            if (c.filePath) truthFiles.add(c.filePath);
          }
        }
      }
    }

    const responseEndpoints = extractResponseEndpoints(run.responseText);
    const matchedPaths = [...truthPaths.keys()].filter((key) => responseEndpoints.has(key));
    const truthPathKeys = [...truthPaths.keys()];
    const pathRecall = truthPathKeys.length === 0 ? 0 : matchedPaths.length / truthPathKeys.length;

    const citedFiles = extractFilePaths(run.responseText);
    const fileScore = scoreFilePaths(citedFiles, [...truthFiles]);

    // 70 pts path recall (the headline question — did the agent name the
    // endpoints?) + 30 pts F1 on file paths (did it locate the call sites?).
    // Precision on paths is hard to police via substring matching, so we lean
    // on recall + judge accuracy for the precision side.
    const final = Math.round(pathRecall * 70 + fileScore.f1 * 30);

    return {
      score: final,
      details: {
        truth_paths: [...truthPaths.values()].map((v) => `${v.method} ${v.path}`),
        matched_paths: matchedPaths,
        path_recall: pathRecall,
        cited_files: citedFiles,
        truth_files: [...truthFiles],
        file_precision: fileScore.precision,
        file_recall: fileScore.recall,
      },
    };
  },
  judgeRubric: {
    dimensions: ['endpoint_coverage', 'caller_identification', 'accuracy', 'completeness'],
    description:
      'endpoint_coverage: names the backend HTTP endpoints the page actually calls. caller_identification: ties each endpoint back to the local function/hook that issues it. accuracy: no fabricated paths or methods. completeness: covers feature areas the page reaches, not just the most obvious call.',
  },
};
