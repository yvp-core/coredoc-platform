import { query } from '@anthropic-ai/claude-agent-sdk';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { blindResponse, emptyUsage } from './judge.js';
import type { Usage } from './types.js';

export interface SpecGroundingHint {
  present: number;   // concrete refs confirmed on disk (cross-repo)
  total: number;     // total concrete refs checked
  absent: string[];  // refs NOT found on disk (tool-name noise already removed)
}

export function buildPairwisePrompt(
  taskPrompt: string,
  specA: string,
  specB: string,
  hints?: { a?: SpecGroundingHint; b?: SpecGroundingHint },
  expectedRepos?: string[],
): string {
  const block = (label: string, h?: SpecGroundingHint) =>
    h
      ? `\n[${label} on-disk check] ${h.present}/${h.total} of ${label}'s concrete file/symbol references were confirmed to exist across all 32 repos. Not found on disk: ${h.absent.length ? h.absent.map((x) => `\`${x}\``).join(', ') : '(none)'}.\n`
      : '';
  const scopeBlock =
    expectedRepos?.length
      ? `\n\nExpected scope: a correct plan should span these repositories: ${expectedRepos.join(', ')}. A spec that omits a repository it must touch is INCOMPLETE — weigh that under completeness (a spec may legitimately state a listed repo needs no change).\n`
      : '';
  return `You are an expert engineering reviewer judging TWO implementation specs written for the SAME task, in a MULTI-REPO workspace: your cwd contains 32 repositories as subdirectories, and identical filenames (there are THREE files named \`api-client.ts\`) and similar symbol names recur across them.

EXISTENCE IS ALREADY VERIFIED FOR YOU — DO NOT RE-DERIVE IT. An automated cross-repo on-disk check determined which referenced files/symbols exist. Trust it. Do NOT use Grep/Glob to decide whether a file or symbol exists: in a 32-repo tree a manual search easily misses a real symbol (e.g. a method defined in only one of three same-named files), which produces false "hallucination" verdicts.
${block('Spec A', hints?.a)}${block('Spec B', hints?.b)}
Interpreting "not found on disk": such a reference is EITHER (a) something the spec proposes to CREATE — legitimate, never penalize; (b) a third-party/framework symbol (the check excludes node_modules) — legitimate; or (c) a genuine fabrication of a supposedly-EXISTING codebase symbol — a real defect. Only (c) counts against a spec.

Judge the two specs ONLY on: (1) correctness of the plan's reasoning — you MAY Read files to confirm the code behaves as a spec assumes (a guard, a field allow-list, an ORM convention, an event), but NOT to re-check existence; (2) completeness of the true impacted surface; (3) actionability. Ignore writing style and length.
${scopeBlock}
TASK:
"""
${taskPrompt}
"""

Spec A:
"""
${blindResponse(specA)}
"""

Spec B:
"""
${blindResponse(specB)}
"""

Reply with ONLY a JSON object and no prose:
{"winner": "A" | "B" | "tie", "reason": "<=200 chars naming the decisive correctness/completeness difference you verified"}`;
}

export function parsePairwiseVerdict(
  raw: string,
): { winner: 'A' | 'B' | 'tie' | 'invalid'; reason: string } {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? raw).trim();
  try {
    const o = JSON.parse(candidate) as { winner?: unknown; reason?: unknown };
    // Fail loud: anything that is not an explicit A/B/tie is 'invalid', NOT a
    // silent tie. A coerced tie would count 0.5 toward both arms and corrupt the
    // ranking with no signal that the judge never actually decided.
    if (o.winner !== 'A' && o.winner !== 'B' && o.winner !== 'tie') {
      return { winner: 'invalid', reason: `invalid winner field: ${JSON.stringify(o.winner)}` };
    }
    return { winner: o.winner, reason: typeof o.reason === 'string' ? o.reason.slice(0, 200) : '' };
  } catch {
    return { winner: 'invalid', reason: 'unparseable judge output' };
  }
}

export interface JudgePairOpts {
  taskPrompt: string;
  specA: string;
  specB: string;
  cwd: string;
  model: string;
  maxTurns: number;
  timeoutMs: number;
  hints?: { a?: SpecGroundingHint; b?: SpecGroundingHint };
  expectedRepos?: string[];
  transcriptPath?: string;
}

export async function judgePair(
  opts: JudgePairOpts,
): Promise<{ winner: 'A' | 'B' | 'tie' | 'invalid'; reason: string; usage: Usage }> {
  const prompt = buildPairwisePrompt(opts.taskPrompt, opts.specA, opts.specB, opts.hints, opts.expectedRepos);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs);
  const usage = emptyUsage();
  let raw = '';
  const messages: unknown[] = [];
  try {
    for await (const msg of query({
      prompt,
      options: {
        model: opts.model,
        allowedTools: ['Read', 'Grep', 'Glob'],
        cwd: opts.cwd,
        maxTurns: opts.maxTurns,
        abortController: abort,
      },
    })) {
      messages.push(msg);
      if (msg.type === 'assistant' && msg.message) {
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string') raw += block.text;
          }
        }
      }
      if (msg.type === 'result') {
        const r = msg as unknown as { usage?: Record<string, number>; total_cost_usd?: number };
        if (r.usage) {
          usage.inputTokens = r.usage.input_tokens ?? 0;
          usage.outputTokens = r.usage.output_tokens ?? 0;
          usage.cacheReadTokens = r.usage.cache_read_input_tokens ?? 0;
          usage.cacheCreationTokens = r.usage.cache_creation_input_tokens ?? 0;
        }
        if (typeof r.total_cost_usd === 'number') usage.costUsd = r.total_cost_usd;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  if (opts.transcriptPath) {
    mkdirSync(dirname(opts.transcriptPath), { recursive: true });
    writeFileSync(opts.transcriptPath, JSON.stringify(messages, null, 2));
  }
  usage.totalTokens =
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  return { ...parsePairwiseVerdict(raw), usage };
}
