import type { CaseDef, Target, VerifierScore } from '../harness/types.js';

export interface ServiceDependencyMapParams {
  /**
   * Hand-curated list of distinct third-party services the codebase calls.
   * Canonical service names (e.g. "OpenAI", "Stripe", "Cloudflare DNS").
   */
  expectedServices: string[];
  /**
   * Path prefixes of the repo's own first-party platform APIs (e.g. a studio
   * app calling its own backend under `/platform/...`). Rendered into the
   * prompt as an explicit exclusion so agents don't report the repo's own
   * backend as an external service. Omit when the repo has no such surface.
   */
  firstPartyPathPrefixes?: string[];
}

// Real-world scenario: "What third-party services does this codebase depend
// on?" An operational question that comes up during audits, vendor reviews,
// and migrations. MCP wins via `list_service_dependencies` which aggregates
// external-call edges across the repo. Without MCP, the agent must grep for
// fetch/axios/specific URL patterns AND SDK imports, classify each, dedupe.
//
// Scoring: case-insensitive substring match on the response (per-service).
// Recall-weighted. The case is not asking the agent to cite every call site,
// just to enumerate the services. We treat it like sink-recall in
// data-flow-trace: prose mentions count, not just bare backticked tokens.
export const serviceDependencyMapCase: CaseDef<ServiceDependencyMapParams> = {
  id: 'service-dependency-map',
  extraTools: [],
  buildPrompt(target: Target, p: ServiceDependencyMapParams): string {
    const exclusion = p.firstPartyPathPrefixes?.length
      ? `\nExclude this repo's own first-party platform calls (anything under ${p.firstPartyPathPrefixes
          .map((x) => `\`${x}...\``)
          .join(', ')}) — those are internal, not external services.\n`
      : '';
    return `In repo "${target.name}", enumerate every external (third-party) service this codebase calls — AI providers, payment processors, DNS providers, telemetry/observability vendors, OAuth providers, internal microservice routes to other first-party APIs, etc.

For each service, give:
1. The canonical service name (e.g. \`OpenAI\`, \`Stripe\`, \`Cloudflare DNS\`, \`PostHog\`, \`Sentry\`)
2. ONE representative file where the integration is initiated (full path)
3. A one-sentence description of what the codebase does with this service
${exclusion}
Don't invent services. Cite only ones you can verify in the source.`;
  },
  async verify(_target: Target, p: ServiceDependencyMapParams, run): Promise<VerifierScore> {
    // Case-insensitive substring match: each truth service must appear
    // somewhere in the response text. Agents tend to mention services in
    // prose, bold, or backticks inconsistently — substring is the right
    // shape.
    const responseLower = run.responseText.toLowerCase();
    const matched = p.expectedServices.filter((s) => responseLower.includes(s.toLowerCase()));
    const truth = p.expectedServices;
    const recall = truth.length === 0 ? 0 : matched.length / truth.length;
    // Precision is intractable here — any response will mention many proper
    // nouns. Use a constant precision proxy of 1 so the F1 collapses to
    // recall.
    const r = { recall, precision: 1, f1: recall };
    const final = Math.round(r.f1 * 90 + 10); // 10pt floor for any response
    return {
      score: final,
      details: {
        truth,
        matched,
        unmatched: truth.filter((s) => !matched.includes(s)),
        recall,
        precision: r.precision,
      },
    };
  },
  judgeRubric: {
    dimensions: ['service_coverage', 'classification_accuracy', 'evidence_quality', 'no_fabrication'],
    description:
      "service_coverage: enumerates every real external service, not just the obvious 2-3. classification_accuracy: correctly categorizes each (AI provider / payments / telemetry / etc.) and distinguishes external services from the repo's own first-party routes. evidence_quality: each cited service has a real file + brief description. no_fabrication: every named service has a real integration in source.",
  },
};
