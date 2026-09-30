import type { CaseDef, Target, VerifierScore } from '../harness/types.js';
import { extractIdentifiers, extractFilePaths } from '../harness/citations.js';
import { f1, getEvalRepository, repoHashFor } from '../harness/verifier.js';

export interface ExplainFunctionParams {
  symbol: string;
  filePath: string;
  expectedCallers?: string[];
}

export const explainFunctionCase: CaseDef<ExplainFunctionParams> = {
  id: 'explain-function',
  extraTools: [],
  buildPrompt(target: Target, p: ExplainFunctionParams): string {
    return `Explain the function/method \`${p.symbol}\` in \`${p.filePath}\` of repo "${target.name}".

Cover all of these:
1. What it does (one paragraph)
2. Inputs and outputs (types, semantics)
3. Side effects (DB writes, network, mutations, throws)
4. Data flow (what it reads from / writes to)
5. Callers — list the functions that invoke this one, by backticked name (e.g. \`OtherClass.someMethod\`)

Cite file paths and line numbers where relevant.`;
  },
  async verify(target: Target, p: ExplainFunctionParams, run): Promise<VerifierScore> {
    let truthCallers: string[];
    if (p.expectedCallers) {
      // Hand-curated override — score against source-grep truth, not the graph.
      truthCallers = p.expectedCallers;
    } else {
      const repo = await getEvalRepository();
      const hash = await repoHashFor(target.repoKey);

      // Split qualified symbols (`BookingService.createBooking`) into className +
      // methodName and pass BOTH to findFunction. Previously this used only the
      // short name, which collided with sibling classes that define a method of
      // the same name (e.g. BookingService.createBooking and SampleApi.createBooking
      // both exist) — findFunction picked one alphabetically and the rest of
      // the verifier walked the wrong node, leaving truthCallers empty.
      const parts = p.symbol.split('.');
      const shortName = parts[parts.length - 1] ?? p.symbol;
      const className = parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;
      const fn = await repo.findFunction(shortName, [hash], p.filePath, className);

      truthCallers = [];
      if (fn) {
        const callers = await repo.getDirectCallers(fn.id, [hash]);
        truthCallers = callers.map((c) => c.name);
      }
    }

    // Normalize to the last "."-separated segment so qualified citations
    // (`TemplatesController.analyzeShiftSourceApplication`) match bare-name
    // truth from the DB (`analyzeShiftSourceApplication`). Without this the
    // with-MCP arm — which tends to emit qualified, more accurate names —
    // scored 0 on caller matching.
    const bareName = (s: string): string => s.split('.').slice(-1)[0] ?? s;
    const targetBare = bareName(p.symbol);
    const rawCited = extractIdentifiers(run.responseText);
    const citedIdents = rawCited.filter((s) => s !== p.symbol && bareName(s) !== targetBare);
    const callerScore = f1(citedIdents.map(bareName), truthCallers.map(bareName));

    const cited = extractFilePaths(run.responseText);
    const fileHit = cited.includes(p.filePath) ? 1 : 0;

    // Prompt asks "list the callers" — a recall question. Earlier eval runs
    // (5-13, 5-14) showed prog 20-30 while judge scored 80-90: agents found
    // the callers (recall ~1.0) but cited many supporting tokens (callees,
    // params, types) that the F1 metric punished as false positives.
    // Switch to recall-weighted scoring: 50pts recall (did you find every
    // caller?) + 20pts precision (penalize only egregious over-citation) +
    // 30pts file-hit (cited the right source).
    const final = Math.round(
      callerScore.recall * 50 + callerScore.precision * 20 + fileHit * 30,
    );

    return {
      score: final,
      details: {
        truthCallers,
        cited: citedIdents,
        precision: callerScore.precision,
        recall: callerScore.recall,
        cited_paths: cited,
        cited_target_file: fileHit ? 'yes' : 'no',
      },
    };
  },
  judgeRubric: {
    dimensions: ['accuracy', 'side_effect_coverage', 'data_flow_coverage', 'caller_coverage'],
    description:
      'accuracy: technical claims match the code. side_effect_coverage: all side effects identified. data_flow_coverage: explains what data goes in/out and where. caller_coverage: lists the relevant callers.',
  },
};
