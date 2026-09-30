import type { CaseDef, Target, VerifierScore } from '../harness/types.js';
import { extractIdentifiers } from '../harness/citations.js';
import { f1, getEvalRepository, repoHashFor } from '../harness/verifier.js';

export interface DataFlowTraceParams {
  /** Starting point — HTTP method (omit for non-HTTP) and path/CLI command. */
  method?: string;
  path: string;
  /** Free-text data field the agent should trace (e.g. "request.body.email"). */
  field: string;
  expectedSinks?: string[];
}

/**
 * Identifier tokens of a curated sink name.
 *
 * Sinks are authored as composites — `ShiftSummary.status`,
 * `Temporal signalWithStart` — but no agent writes them as one token; good
 * answers say "sets `status = Pending` on `ShiftSummary`". Splitting on
 * non-alphanumerics gives the parts that must all be present.
 */
export function sinkTokens(sink: string): string[] {
  return sink
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
}

/**
 * A sink counts as named when every one of its identifier tokens appears in
 * the response (case-insensitive, dot/space-agnostic). Substring matching is
 * deliberate: `shiftsummary` should also count inside `shiftSummaryRepository`.
 * A response mentioning only part of a composite still scores it as a miss.
 */
export function responseNamesSink(responseLower: string, sink: string): boolean {
  const tokens = sinkTokens(sink);
  if (tokens.length === 0) return false;
  return tokens.every((token) => responseLower.includes(token));
}

// Real-world scenario: "Where does `request.body.email` from POST /signup end
// up — DB, logs, external service?" The agent must follow the data downstream
// to terminal sinks (entity writes + external calls). Tools the with-MCP arm
// should reach for: explain (detailLevel: full — the most direct fit for
// following data downstream), find_entity_usage (for the terminal entity
// check).
export const dataFlowTraceCase: CaseDef<DataFlowTraceParams> = {
  id: 'data-flow-trace',
  extraTools: [],
  buildPrompt(target: Target, p: DataFlowTraceParams): string {
    const label = p.method ? `${p.method} \`${p.path}\`` : `\`${p.path}\``;
    return `In repo "${target.name}", trace the data field \`${p.field}\` from the entrypoint ${label} to its terminal sinks.

For each terminal sink, name:
1. The kind — database entity write, external HTTP/queue call, log write, in-memory only, or "discarded"
2. The specific entity name (if DB) or service/endpoint (if external)
3. The function in which the sink happens
4. Any transformations the data undergoes along the way

Cite function names and entity names in backticks. Cite file paths where relevant. Do not invent sinks — only ones you can verify in the code.`;
  },
  async verify(target: Target, p: DataFlowTraceParams, run): Promise<VerifierScore> {
    let entrypointFound = false;
    let truthList: string[] = [];
    let reachedCount = 0;

    if (p.expectedSinks) {
      // Hand-curated override — skip the entrypoint + BFS dance entirely.
      truthList = p.expectedSinks;
      entrypointFound = true;
    } else {
      const repo = await getEvalRepository();
      const hash = await repoHashFor(target.repoKey);

      // Locate the entrypoint to anchor the data-flow walk.
      const entries = await repo.listEntrypoints({ pathPattern: p.path, limit: 50 }, [hash]);
      const ep = entries.find(
        (e) =>
          (!p.method || e.method === p.method) && (e.path === p.path || e.fullPath === p.path),
      );
      entrypointFound = !!ep;

      const reachedFunctionIds: string[] = [];

      if (ep?.handlerId) {
        // BFS the call chain to collect all reachable function IDs (depth 4 —
        // data flow tends to go through 1-2 service layers and a repo/orm hop).
        const seen = new Set<string>([ep.handlerId]);
        reachedFunctionIds.push(ep.handlerId);
        let frontier: string[] = [ep.handlerId];
        const NODE_CAP = 300;
        for (let d = 0; d < 4 && frontier.length > 0 && seen.size < NODE_CAP; d++) {
          const next: string[] = [];
          for (const id of frontier) {
            const callees = await repo.getDirectCallees(id, [hash]);
            for (const c of callees) {
              if (seen.has(c.id)) continue;
              seen.add(c.id);
              reachedFunctionIds.push(c.id);
              next.push(c.id);
              if (seen.size >= NODE_CAP) break;
            }
            if (seen.size >= NODE_CAP) break;
          }
          frontier = next;
        }
      }
      reachedCount = reachedFunctionIds.length;

      // Truth set spans every terminal sink the prompt asks about: DB entity
      // writes AND external HTTP/queue/Kafka calls. The 2026-05-14 eval saw
      // agents nail the flow (entity + HTTP + Kafka sinks) but score 0 because
      // the verifier counted only entity names — the prompt-vs-truth mismatch
      // turned a great answer into a precision-0 / recall-0 verdict.
      //
      // Filter out generic tokens that show up as `method`/`serviceName` on
      // external_call rows: `kafka`, `emit`, `http`, etc. don't uniquely
      // identify a sink, agents rarely backtick them, and including them
      // inflates the truth-size denominator (tanking recall) without adding
      // discriminating signal. Keep PascalCase / qualified / multi-segment
      // identifiers — those ARE specific sink names.
      const GENERIC_TOKENS = new Set([
        'kafka', 'emit', 'http', 'get', 'set', 'post', 'put', 'patch', 'delete',
        'find', 'send', 'fetch', 'call', 'invoke', 'publish', 'consume', 'topic',
      ]);
      const isSpecific = (s: string): boolean => {
        if (!s) return false;
        const trimmed = s.trim();
        if (trimmed.length < 3) return false;
        if (GENERIC_TOKENS.has(trimmed.toLowerCase())) return false;
        // Multi-segment or PascalCase or has digit/underscore → specific.
        if (trimmed.includes('.') || trimmed.includes('-') || trimmed.includes('_')) return true;
        if (/[A-Z]/.test(trimmed)) return true;
        return false;
      };

      const truthSinks = new Set<string>();
      if (reachedFunctionIds.length > 0) {
        const ops = await repo.getEntitiesForFunctions(reachedFunctionIds, [hash]);
        for (const o of ops) truthSinks.add(o.entityName);

        // External calls — service names, Kafka topics, and the last path
        // segment of HTTP routes. Agents typically cite each in backticks
        // (`apiClient.payrollLock`, `DailySummaryRecalculateV2`,
        // `getUserProfileLockDate`).
        for (const fnId of reachedFunctionIds) {
          const calls = await repo.getExternalCallsFrom(fnId, [hash]);
          for (const c of calls) {
            if (c.serviceName && isSpecific(c.serviceName)) truthSinks.add(c.serviceName);
            if (c.method && isSpecific(c.method)) truthSinks.add(c.method);
            const destination = c.messagingDestination;
            if (destination && isSpecific(destination)) truthSinks.add(destination);
            if (c.pathTemplate) {
              const tail = c.pathTemplate.split('/').filter(Boolean).pop();
              if (tail && isSpecific(tail)) truthSinks.add(tail);
            }
          }
        }
      }
      truthList = [...truthSinks];
    }

    const bareName = (s: string): string => s.split('.').slice(-1)[0] ?? s;
    const citedIdents = extractIdentifiers(run.responseText);

    let score;
    let matchMode: 'identifier-f1' | 'sink-recall' = 'identifier-f1';
    if (p.expectedSinks) {
      // Sinks are prose-shaped service names (`openai`, `stripe`, `kafka:topic-name`)
      // that agents typically mention in bold or prose rather than as bare backticked
      // identifiers. A 2026-05-15 eval saw the with-MCP arm correctly
      // identify "OpenAI Chat Completions API" as the only sink for the `prompt`
      // field, but score prog=0 because the bare token `openai` never appeared in
      // single backticks. Switch to a case-insensitive substring scan over the
      // full response so legitimate prose mentions count. Recall-weighted —
      // precision is intractable here (any response talking about data flow
      // mentions many proper nouns) and the judge already scores accuracy.
      //
      // The 2026-08-24 acme-calculations eval then scored 0 in all four cells
      // with composite sinks (`ShiftSummary.status`, `Temporal signalWithStart`)
      // that never appear as one literal substring, so the scan is per-token
      // AND-matching rather than whole-string.
      matchMode = 'sink-recall';
      const responseLower = run.responseText.toLowerCase();
      const matched = truthList.filter((s) => responseNamesSink(responseLower, s));
      const recall = truthList.length === 0 ? 0 : matched.length / truthList.length;
      // Recall-only scoring matches the prompt's "name the sinks" ask. Precision
      // is left to the judge.
      score = { f1: recall, precision: 1, recall };
    } else {
      score = f1(citedIdents.map(bareName), truthList.map(bareName));
    }

    return {
      score: Math.round(score.f1 * 100),
      details: {
        entrypointFound: entrypointFound ? 'yes' : 'no',
        truthSinks: truthList,
        cited: citedIdents,
        precision: score.precision,
        recall: score.recall,
        reachedFunctions: reachedCount,
        match_mode: matchMode,
      },
    };
  },
  judgeRubric: {
    dimensions: ['sink_identification', 'transformation_trace', 'completeness', 'accuracy'],
    description:
      'sink_identification: correctly names the terminal sinks (DB entity, external service, log, discard). transformation_trace: explains how the data changes between layers. completeness: covers every sink the field reaches, not just one. accuracy: every named function, entity, or service actually exists in the code.',
  },
};
