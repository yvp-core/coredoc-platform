import type { CaseDef, Target, VerifierScore } from '../harness/types.js';
import { extractFilePaths, extractIdentifiers } from '../harness/citations.js';

export interface TransitiveCallersClosureParams {
  symbol: string;
  filePath: string;
  /**
   * Hand-curated transitive caller closure (depth ≤ 3). Each entry is the
   * enclosing function/component name. Truth is always-required.
   */
  expectedClosure: string[];
}

const MAX_DEPTH = 3;

interface QualifiedCaller {
  symbol: string;
  filePath: string;
  depth: number;
}

function bareName(symbol: string): string {
  return symbol.split('.').slice(-1)[0] ?? symbol;
}

function sameSymbol(cited: string, truth: string): boolean {
  if (truth.includes('.')) return cited.toLowerCase() === truth.toLowerCase();
  return bareName(cited).toLowerCase() === truth.toLowerCase();
}

/**
 * The depth group a heading line opens, if any.
 *
 * Scoring never compares depth (only `symbol` is matched against the truth set), so this is a
 * GROUPING signal, not a scored one. It therefore accepts the spellings agents actually write —
 * `Depth 2`, `Level 2`, `Hop 2`, `Tier 2`, and the prose `Direct callers` — rather than only the
 * literal `depth N` the prompt asks for. Requiring the literal form discarded every citation in
 * an otherwise complete, correctly-cited answer and scored it 0.
 */
function depthHeading(line: string): number | undefined {
  const numbered = line.match(/\b(?:depth|level|hop|tier)\s*(?:=|:)?\s*(\d+)\b/i);
  if (numbered?.[1]) return Number(numbered[1]);
  if (/\bdirect\s+(?:caller|callee)?s?\b/i.test(line)) return 1;
  return undefined;
}

function extractQualifiedCallers(responseText: string, rootSymbol: string): QualifiedCaller[] {
  const callers: QualifiedCaller[] = [];
  const seen = new Set<string>();
  // Default to depth 1 rather than `undefined`: an answer that lists correct callers with correct
  // file paths but no depth heading is a complete answer to "who calls this", and depth is not a
  // scored dimension here. Discarding those citations measured formatting, not knowledge.
  let currentDepth: number | undefined = 1;
  let pendingIdentifiers: string[] = [];

  const addCallers = (identifiers: string[], filePath: string): void => {
    if (currentDepth === undefined || currentDepth < 1 || currentDepth > MAX_DEPTH) return;
    for (const symbol of identifiers) {
      if (bareName(symbol).toLowerCase() === bareName(rootSymbol).toLowerCase()) continue;
      const key = `${symbol.toLowerCase()}@${filePath.toLowerCase()}#${currentDepth}`;
      if (seen.has(key)) continue;
      seen.add(key);
      callers.push({ symbol, filePath, depth: currentDepth });
    }
  };

  for (const line of responseText.split(/\r?\n/)) {
    const heading = depthHeading(line);
    if (heading !== undefined) {
      currentDepth = heading;
      pendingIdentifiers = [];
    }

    if (currentDepth === undefined || currentDepth < 1 || currentDepth > MAX_DEPTH) {
      pendingIdentifiers = [];
      continue;
    }

    const identifiers = extractIdentifiers(line).filter(
      (symbol) => bareName(symbol).toLowerCase() !== bareName(rootSymbol).toLowerCase(),
    );
    const filePaths = extractFilePaths(line);

    if (filePaths[0] && identifiers.length > 0) {
      addCallers(identifiers, filePaths[0]);
      pendingIdentifiers = [];
    } else if (identifiers.length > 0) {
      pendingIdentifiers = identifiers;
    } else if (filePaths[0] && pendingIdentifiers.length > 0) {
      addCallers(pendingIdentifiers, filePaths[0]);
      pendingIdentifiers = [];
    }
  }

  return callers;
}

// Real-world scenario: "We're deprecating X. Who's affected?" — a recursive
// call-graph walk. MCP wins because find_callers returns direct callers in
// one query; the agent then does manual BFS through depth 3. Without MCP,
// each depth level requires another set of grep + Read cycles, and the
// search space explodes.
//
// Scoring: recall-weighted because the prompt asks "list every function".
// Precision is intentionally light — agents may cite extra related fns
// from the response that aren't strictly in the closure.
export const transitiveCallersClosureCase: CaseDef<TransitiveCallersClosureParams> = {
  id: 'transitive-callers-closure',
  extraTools: [],
  buildPrompt(target: Target, p: TransitiveCallersClosureParams): string {
    return `In repo "${target.name}", we're planning to deprecate the function \`${p.symbol}\` (defined in \`${p.filePath}\`).

List every function in the codebase that ultimately calls \`${p.symbol}\` — transitively, up to depth 3.

For each caller, give:
- The bare function/component name in backticks (use \`Class.method\` for class methods)
- The file path
- The depth at which it sits (1 = direct caller, 2 = caller of a direct caller, 3 = caller's caller's caller)

Group by depth. Skip tests, stories, and mocks.

Cite ALL transitive callers — completeness matters. Don't speculate; only cite functions you can verify in the code.`;
  },
  async verify(_target: Target, p: TransitiveCallersClosureParams, run): Promise<VerifierScore> {
    const excludedTruthRoot = p.expectedClosure.filter(
      (symbol) => bareName(symbol).toLowerCase() === bareName(p.symbol).toLowerCase(),
    );
    const truth = p.expectedClosure.filter(
      (symbol) => bareName(symbol).toLowerCase() !== bareName(p.symbol).toLowerCase(),
    );
    const cited = extractQualifiedCallers(run.responseText, p.symbol);
    const unmatchedCitations = new Set(cited.map((_, index) => index));
    let matches = 0;

    for (const truthSymbol of truth) {
      const match = [...unmatchedCitations].find((index) =>
        sameSymbol(cited[index]?.symbol ?? '', truthSymbol),
      );
      if (match === undefined) continue;
      unmatchedCitations.delete(match);
      matches++;
    }

    const precision = cited.length === 0 ? 0 : matches / cited.length;
    const recall = truth.length === 0 ? 0 : matches / truth.length;
    // 70 recall + 30 precision. Completeness drives the score; over-citation
    // costs less than under-citation.
    const final = Math.round(recall * 70 + precision * 30);
    return {
      score: final,
      details: {
        symbol: p.symbol,
        truth,
        excluded_truth_root: excludedTruthRoot,
        cited: cited.map((caller) =>
          `${caller.symbol}@${caller.filePath}#${caller.depth}`,
        ),
        precision,
        recall,
      },
    };
  },
  judgeRubric: {
    dimensions: ['closure_coverage', 'depth_labeling', 'accuracy', 'no_fabrication'],
    description:
      'closure_coverage: enumerates every transitive caller, not just the top few. depth_labeling: correctly groups callers by depth (direct vs indirect). accuracy: cited callers actually call the target. no_fabrication: every cited caller exists in the repo.',
  },
};
