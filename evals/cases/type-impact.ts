import type { NodeType } from '@coredoc/db';
import type { CaseDef, Target, VerifierScore } from '../harness/types.js';
import { extractIdentifiers } from '../harness/citations.js';
import { f1, getEvalRepository, repoHashFor } from '../harness/verifier.js';

export interface TypeImpactParams {
  /** Type name — interface, type_alias, or enum. */
  type: string;
  /** Kind hint for the prompt (and for routing the truth lookup). */
  kind: 'interface' | 'type_alias' | 'enum' | 'class';
  /** Defining file — included in the prompt so the agent grounds in the right language. */
  filePath?: string;
  expectedConsumers?: string[];
}

// Real-world scenario: "We're widening / changing the shape of `OutputFormat`
// — who consumes it?" Exercises the USES_TYPE graph extension. Tools the
// with-MCP arm should reach for: find_dependents (the type-aware variant
// that walks USES_TYPE), search_symbols (to find the type if the agent
// guessed wrong on kind).
export const typeImpactCase: CaseDef<TypeImpactParams> = {
  id: 'type-impact',
  extraTools: [],
  buildPrompt(target: Target, p: TypeImpactParams): string {
    const fileGround = p.filePath
      ? ` (defined in \`${p.filePath}\` — only this declaration; ignore same-named types in other languages or other files)`
      : '';
    return `In repo "${target.name}", we plan to change the shape of the ${p.kind} \`${p.type}\`${fileGround}.

Enumerate every place this type is consumed:
1. Functions that take \`${p.type}\` as a parameter or return it
2. Classes whose properties are typed as \`${p.type}\`
3. Interfaces or other type aliases that reference \`${p.type}\`
4. Subclasses or implementations (if \`${p.type}\` is a class or interface)

For each consumer, cite the function/class name **in backticks** and the file path. The backtick form is required — non-backticked prose mentions may be missed by the verifier.`;
  },
  async verify(target: Target, p: TypeImpactParams, run): Promise<VerifierScore> {
    let truthConsumers: string[];
    let typeId: string | null = null;
    if (p.expectedConsumers) {
      truthConsumers = p.expectedConsumers;
    } else {
      const repo = await getEvalRepository();
      const hash = await repoHashFor(target.repoKey);

      // Resolve the type's node id. Class and interface have dedicated finders;
      // type_alias and enum go through findCode (same path the MCP tool uses
      // since there's no findTypeAlias / findEnum repo method).
      if (p.kind === 'class') {
        const c = await repo.findClass(p.type, [hash]);
        typeId = c?.id ?? null;
      } else if (p.kind === 'interface') {
        const i = await repo.findInterface(p.type, [hash]);
        typeId = i?.id ?? null;
      } else {
        // `p.kind` is the local filter union; coerce to NodeType[] at the
        // findCode boundary (the string values are valid NodeType members).
        const matches = await repo.findCode({ pattern: p.type, types: [p.kind] as NodeType[], limit: 5 }, [hash]);
        typeId = matches.find((m) => m.name === p.type)?.id ?? null;
      }

      truthConsumers = [];
      if (typeId) {
        const users = await repo.getTypeUsages(typeId, [hash]);
        for (const u of users) truthConsumers.push(u.name);
        // For classes/interfaces, extension edges also count as "consumers" —
        // subclasses depend on the parent's shape just like USES_TYPE consumers.
        if (p.kind === 'class') {
          const subs = await repo.getClassExtensions(typeId, [hash]);
          for (const s of subs) truthConsumers.push(s.name);
        }
        if (p.kind === 'interface') {
          const impls = await repo.getInterfaceImplementations(typeId, [hash]);
          for (const i of impls) truthConsumers.push(i.name);
        }
      }
    }

    const bareName = (s: string): string => s.split('.').slice(-1)[0] ?? s;
    const cited = extractIdentifiers(run.responseText)
      // Drop the type itself — agents repeat it across the response.
      .filter((s) => s !== p.type && bareName(s) !== p.type);
    const ifScore = f1(cited.map(bareName), truthConsumers.map(bareName));

    // Fallback recall via substring scan on the full response. Backtick-F1
    // is the headline metric (the prompt asks for backticks), but when the
    // agent describes consumers in prose ("the `PathCleanFilters` component
    // uses it") the backticks may not wrap every consumer. The 2026-05-16
    // eval saw noMCP score prog=0 on type-impact across 3 runs
    // because the agent's response was Python-side (wrong type) AND
    // didn't backtick consumer names. The substring fallback gives a
    // floor recall signal so a focused answer doesn't get 0 just for
    // missing backticks. Take max(backtick-recall, substring-recall) to
    // pick whichever the agent's format supports.
    const lowerResponse = run.responseText.toLowerCase();
    const substringMatches = truthConsumers.filter((c) => {
      const cl = c.toLowerCase();
      // Require a whole-word boundary or backtick proximity. A bare
      // "Form" substring would match too many false positives, but
      // truth tokens are typically long enough (≥3 chars) to be specific.
      if (cl.length < 4) return lowerResponse.includes(`\`${cl}\``);
      return lowerResponse.includes(cl);
    });
    const substringRecall =
      truthConsumers.length === 0 ? 0 : substringMatches.length / truthConsumers.length;
    const finalRecall = Math.max(ifScore.recall, substringRecall);
    // F1 with the better recall + same precision as backtick path.
    const denom = ifScore.precision + finalRecall;
    const finalF1 = denom === 0 ? 0 : (2 * ifScore.precision * finalRecall) / denom;

    return {
      score: Math.round(finalF1 * 100),
      details: {
        type: p.type,
        kind: p.kind,
        typeResolved: p.expectedConsumers ? 'override' : typeId ? 'yes' : 'no',
        truthConsumers,
        cited,
        precision: ifScore.precision,
        recall: finalRecall,
        backtick_recall: ifScore.recall,
        substring_recall: substringRecall,
      },
    };
  },
  judgeRubric: {
    dimensions: ['consumer_coverage', 'kind_breakdown', 'accuracy', 'depth'],
    description:
      'consumer_coverage: lists the functions, classes, interfaces, and aliases that depend on the type. kind_breakdown: distinguishes parameter vs return vs property vs alias vs extends consumers. accuracy: every named consumer actually references the type in the code. depth: goes beyond the obvious direct uses to capture nested / re-exported / type-aliased indirection.',
  },
};
