import type { CaseDef, Target, VerifierScore } from '../harness/types.js';
import { extractFilePaths, extractIdentifiers } from '../harness/citations.js';
import { f1 } from '../harness/verifier.js';

export interface FlagImpactAuditParams {
  /** The hook's bare name — e.g. `useIsOrioleDb`. */
  hook: string;
  /** Where the hook is defined, for grounding the prompt. */
  hookFile: string;
  /**
   * Hand-curated list of call-site identifiers — enclosing components or
   * functions that call the hook AND branch behavior on the result. One
   * entry per enclosing function (deduplicated). Use `Class.method` for
   * methods.
   */
  expectedCallSites: string[];
}

function normalizeFilePath(path: string): string {
  return path.replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase();
}

function pathsEquivalent(left: string, right: string): boolean {
  const a = normalizeFilePath(left);
  const b = normalizeFilePath(right);
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.includes('/') && longer.endsWith(`/${shorter}`);
}

// Real-world scenario: "This runtime gate is everywhere — what does it
// actually control?" Removing or changing the gate requires knowing every
// branched behavior. Tools the with-MCP arm should reach for: find_callers
// (the headline tool for this case), explain on each caller to
// understand the gated behavior, search_symbols if the agent guessed the
// hook's location.
//
// Why MCP wins vs grep: grep finds occurrences but not the enclosing
// function. The agent must Read each caller file to identify the
// component/function name, which costs Read calls per hit (15+ Reads for
// 15 callers = expensive). MCP's find_callers returns the enclosing
// function names directly.
//
// Scoring: recall-weighted F1 on identifiers. The prompt asks "list every
// place" — completeness matters more than precision.
export const flagImpactAuditCase: CaseDef<FlagImpactAuditParams> = {
  id: 'flag-impact-audit',
  extraTools: [],
  buildPrompt(target: Target, p: FlagImpactAuditParams): string {
    return `In repo "${target.name}", the hook \`${p.hook}\` (defined in \`${p.hookFile}\`) acts as a runtime gate — UI/UX behavior branches on its return value.

List every place this hook is called. For each call site, give:
1. The component or function that calls it (in backticks, e.g. \`MyComponent\` or \`SomeClass.method\`)
2. The behavior gated by the result (one specific sentence — what's hidden / shown / enabled / disabled)
3. The file path

Don't include call sites in test files, storybooks, or mocks. Don't include sites that call the hook but ignore the result — only sites that actually branch on it.`;
  },
  async verify(_target: Target, p: FlagImpactAuditParams, run): Promise<VerifierScore> {
    const bareName = (s: string): string => s.split('.').slice(-1)[0] ?? s;
    const cited = extractIdentifiers(run.responseText)
      // Drop the hook itself — agents repeat it across the response.
      .filter((s) => bareName(s) !== p.hook);
    const truth = p.expectedCallSites;
    const r = f1(cited.map(bareName), truth.map(bareName));
    const citedFiles = extractFilePaths(run.responseText);
    const hookFileCited = citedFiles.some((filePath) => pathsEquivalent(filePath, p.hookFile));
    // Recall-weighted: 60 recall + 20 precision + 20 bonus for citing the
    // hook's own file (signals the agent grounded itself in the definition).
    // Precision is intentionally light — the response naturally cites many
    // identifiers (component sub-elements, neighboring hooks) that aren't
    // false positives in the user's mind.
    const final = Math.round(r.recall * 60 + r.precision * 20 + (hookFileCited ? 20 : 0));
    return {
      score: final,
      details: {
        hook: p.hook,
        truth,
        cited,
        cited_files: citedFiles,
        hook_file_cited: hookFileCited ? 1 : 0,
        precision: r.precision,
        recall: r.recall,
      },
    };
  },
  judgeRubric: {
    dimensions: ['site_coverage', 'gate_specificity', 'accuracy', 'no_fabrication'],
    description:
      'site_coverage: lists every (or nearly every) real call site that branches on the hook. gate_specificity: each call site has a SPECIFIC description of what behavior the hook gates (not "branches on the result"). accuracy: cited components/functions actually call the hook in source. no_fabrication: every cited file path exists, every cited component is real.',
  },
};
