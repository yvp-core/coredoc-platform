import type { CaseDef, Target, VerifierScore } from '../harness/types.js';
import { extractIdentifiers } from '../harness/citations.js';
import { f1, getEvalRepository, repoHashFor } from '../harness/verifier.js';

export interface EntityImpactParams {
  /** Entity name as it appears in the parsed graph (e.g. "Workspace", "Shift"). */
  entity: string;
  /** Optional concrete column/field that's being changed — used by the prompt for grounding. */
  field?: string;
  expectedConsumers?: string[];
}

// Real-world scenario: "We're adding a `deletedAt` column to the `Workspace`
// table. Who reads/writes it? Who'd break?" The agent must enumerate the
// functions that operate on the entity and which entrypoints reach them.
// Tools the with-MCP arm should reach for: find_entity_usage (every read/
// write), analyze_change_impact (risk + entrypoints).
export const entityImpactCase: CaseDef<EntityImpactParams> = {
  id: 'entity-impact',
  extraTools: [],
  buildPrompt(target: Target, p: EntityImpactParams): string {
    const change = p.field
      ? `add a new field \`${p.field}\` to the \`${p.entity}\` entity`
      : `change the schema of the \`${p.entity}\` entity`;
    return `In repo "${target.name}", we plan to ${change}.

Enumerate the impact:
1. Every function that reads from or writes to \`${p.entity}\` (by name)
2. The operation each one performs (create / read / update / delete)
3. Which HTTP / CLI / queue entrypoints ultimately exercise those functions
4. Overall risk assessment (low / medium / high) and reasoning

Cite function names in backticks. Cite file paths where relevant.`;
  },
  async verify(target: Target, p: EntityImpactParams, run): Promise<VerifierScore> {
    let truthFunctions: string[];
    if (p.expectedConsumers) {
      truthFunctions = p.expectedConsumers;
    } else {
      const repo = await getEvalRepository();
      const hash = await repoHashFor(target.repoKey);

      // Truth: every function with an OPERATES_ON edge to the entity. The MCP
      // `find_entity_usage` tool wraps the same query, so a well-using agent
      // should produce a set that overlaps heavily.
      const consumers = await repo.getEntityConsumers(p.entity, [hash]);
      truthFunctions = consumers.map((c) => c.name);
    }

    const bareName = (s: string): string => s.split('.').slice(-1)[0] ?? s;
    // Restrict cited tokens to ones that LOOK like function references so
    // precision reflects the prompt's actual ask ("Cite function names in
    // backticks"). Without this filter, the 2026-05-14 eval saw precision
    // ~0.36 because agents legitimately backtick supporting tokens — param
    // names (`userProfileUuid`), field names (`status`), Kafka topics
    // (`LockDatesUpdatedV2`), service classes (`RecalculationService`),
    // entity names — none of which the prompt asks them to enumerate. A
    // "function-shaped" filter (qualified `Class.method`, or lowercase
    // camelCase identifier ≥3 chars) gets us to the metric the prompt
    // describes: agents are scored on their function enumeration, not on
    // every backticked token in the response.
    const looksLikeFunctionRef = (s: string): boolean => {
      if (s === p.entity) return false; // entity name itself
      // Qualified form `Class.method` → almost always a function reference.
      if (s.includes('.')) return true;
      // All-uppercase → constant / enum value / topic name.
      if (s === s.toUpperCase() && /[A-Z_]/.test(s)) return false;
      // TitleCase single segment (e.g. `DailySummary`, `LockDatesUpdatedV2`)
      // → class / type / topic. Truth-set function names overwhelmingly
      // start with lowercase.
      if (/^[A-Z]/.test(s)) return false;
      // Short single-token (probably a param remnant).
      if (s.length < 3) return false;
      return true;
    };

    const allCited = extractIdentifiers(run.responseText);
    // When an override is in play the truth set may legitimately contain
    // PascalCase React components / hooks — for those targets the
    // "function-shaped" filter would drop the correct cited tokens and tank
    // recall. Skip filtering on the hand-curated path.
    const citedFunctionRefs = p.expectedConsumers
      ? allCited
      : allCited.filter(looksLikeFunctionRef);
    const fnScore = f1(citedFunctionRefs.map(bareName), truthFunctions.map(bareName));

    return {
      score: Math.round(fnScore.f1 * 100),
      details: {
        entity: p.entity,
        truthFunctions,
        citedAll: allCited,
        citedFunctionRefs,
        precision: fnScore.precision,
        recall: fnScore.recall,
      },
    };
  },
  judgeRubric: {
    dimensions: ['consumer_coverage', 'operation_accuracy', 'entrypoint_traceback', 'risk_calibration'],
    description:
      'consumer_coverage: lists the functions that read/write the entity. operation_accuracy: correctly labels each as create/read/update/delete. entrypoint_traceback: ties consumers back to the user-facing entrypoints that exercise them. risk_calibration: risk verdict matches the size and surface of the consumer set.',
  },
};
