import type { CaseDef, Target, VerifierScore } from '../harness/types.js';
import { extractIdentifiers } from '../harness/citations.js';
import { f1 } from '../harness/verifier.js';

export interface DeepChainSideEffectsParams {
  kind: 'entrypoint' | 'function';
  method?: string;
  path?: string;
  symbol?: string;
  filePath?: string;
  expectedChain: { function: string; filePath: string; depth: number; sideEffect: string }[];
  /**
   * Repo-specific side-effect vocabulary (internal service/module names like
   * a repo's own RPC layer) merged into the shared keyword list during
   * verification. Keeps target-specific terms out of the shared verifier.
   */
  extraSideEffectTokens?: string[];
}

// Real-world scenario: "Walk me through this entrypoint's full effect chain
// (6+ hops). What does each layer DO, including side effects?" The case
// exploits coredoc's topological summary aggregation — explain (detailLevel:
// full) on a deep entrypoint already encodes its callees' summaries in the response,
// so MCP gets the whole chain in a small number of calls. Without MCP, the
// agent Reads 6+ files just to enumerate the chain, then more to identify
// side effects per layer. Token-expensive; agents often truncate mid-chain.
//
// Scoring: F1 on function names AND substring match on side-effect keywords.
// Recall-weighted heavily on the function enumeration; the side-effect
// substring check catches whether the agent identified concrete effects vs
// hand-waving ("does some work").
export const deepChainSideEffectsCase: CaseDef<DeepChainSideEffectsParams> = {
  id: 'deep-chain-side-effects',
  extraTools: [],
  buildPrompt(target: Target, p: DeepChainSideEffectsParams): string {
    const label =
      p.kind === 'entrypoint' && p.method && p.path
        ? `the entrypoint \`${p.method} ${p.path}\``
        : `the function \`${p.symbol}\` (defined in \`${p.filePath}\`)`;
    return `In repo "${target.name}", trace the full call chain of ${label} from the top down to its terminal side effects. The chain is at least 6 functions deep.

For EACH function in the chain (depth 1 through the leaves), give:
1. The function name in backticks
2. The file path
3. The depth (1 = top, increasing)
4. The specific side effect produced — be concrete:
   - **DB write/read**: name the entity and operation
   - **External HTTP call**: name the service (e.g. OpenAI, Stripe) and the kind of payload
   - **Log write**: which log (\`console.error\`, Sentry, structured logger) and what's logged
   - **Queue/topic publish**: name the topic
   - **No side effect**: explicitly note "pure transform" or "delegation"

Cover every depth — don't skip layers. The chain matters as a whole; do not just summarize the top and bottom.`;
  },
  async verify(_target: Target, p: DeepChainSideEffectsParams, run): Promise<VerifierScore> {
    const bareName = (s: string): string => s.split('.').slice(-1)[0] ?? s;
    const cited = extractIdentifiers(run.responseText);
    const truthFns = p.expectedChain.map((c) => c.function);
    const fnScore = f1(cited.map(bareName), truthFns.map(bareName));

    // Side-effect detection: for each chain entry that has a non-trivial
    // side effect, check if a relevant keyword appears within ~200 chars
    // of the function name in the response. Substring-based; tolerant of
    // exact wording. We extract a few keywords per side effect string.
    const responseLower = run.responseText.toLowerCase();
    const sideEffectKeywords = (s: string): string[] => {
      const lower = s.toLowerCase();
      const out: string[] = [];
      // Common signal tokens that an agent would mention if they identified
      // the effect concretely. Liberal matching.
      const tokens = [
        'openai', 'stripe', 'sentry', 'posthog', 'braintrust', 'cloudflare',
        'github', 'vercel', 'http', 'https',
        'fetch', 'log', 'console', 'span', 'sql', 'database', 'queue',
        'webhook', 'kafka', 'stream', 'write', 'read', 'delete', 'insert',
        'update', 'auth', 'jwt',
        ...(p.extraSideEffectTokens ?? []).map((t) => t.toLowerCase()),
      ];
      for (const t of tokens) {
        if (lower.includes(t)) out.push(t);
      }
      return out;
    };
    let sideEffectHits = 0;
    let sideEffectChecks = 0;
    for (const link of p.expectedChain) {
      if (/none/i.test(link.sideEffect)) continue; // skip "pure transform"
      sideEffectChecks += 1;
      const keywords = sideEffectKeywords(link.sideEffect);
      if (keywords.length === 0) continue;
      // Find the position of the function name in the response (case-insensitive).
      const fnLower = link.function.toLowerCase();
      const idx = responseLower.indexOf(fnLower);
      if (idx < 0) continue;
      // Scan a ±300 char window around the function mention.
      const window = responseLower.slice(Math.max(0, idx - 100), idx + 300);
      if (keywords.some((k) => window.includes(k))) sideEffectHits += 1;
    }
    const sideEffectRecall = sideEffectChecks === 0 ? 1 : sideEffectHits / sideEffectChecks;

    // 50pt function recall + 20pt function precision + 30pt side-effect recall
    const final = Math.round(
      fnScore.recall * 50 + fnScore.precision * 20 + sideEffectRecall * 30,
    );
    return {
      score: final,
      details: {
        truth_chain_depth: p.expectedChain.length,
        truth_functions: truthFns,
        cited: cited,
        fn_precision: fnScore.precision,
        fn_recall: fnScore.recall,
        side_effect_recall: sideEffectRecall,
        side_effect_checks: sideEffectChecks,
        side_effect_hits: sideEffectHits,
      },
    };
  },
  judgeRubric: {
    dimensions: ['chain_coverage', 'side_effect_specificity', 'layer_ordering', 'accuracy'],
    description:
      'chain_coverage: names every function in the chain, top to leaves. side_effect_specificity: each layer\'s side effect is named concretely (entity, service, log target) — not just "does work". layer_ordering: depths align with the actual call chain. accuracy: every named function and effect is real and verifiable.',
  },
};
