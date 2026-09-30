import { query } from '@anthropic-ai/claude-agent-sdk';
import type { CurrentJudgeScore, JudgeDimension, Usage } from './types.js';

export const JUDGE_MODEL = 'claude-opus-5-5';

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

export function blindResponse(text: string): string {
  // Strip arm-revealing MCP tool names, then cap runs of double-quotes at 2 so
  // an adversarial response can't break out of the """..."""-quoted region in
  // the judge prompt. Replacing N→N-1 left 3+ quotes intact for any N>=4, so
  // a malicious response could still inject scoring instructions; cap-at-2
  // guarantees no 3+ run survives regardless of input length.
  return text
    .replace(/mcp__[a-z0-9._-]+__[a-z0-9._-]+/gi, '<tool>')
    .replace(/"{3,}/g, '""');
}

export function parseValidJudgeJson(
  raw: string,
  dimensions: readonly string[],
): JudgeDimension[] {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? raw).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error('Judge did not return valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Judge response must be a JSON object.');
  }
  const object = parsed as Record<string, unknown>;
  if (!dimensions.every((name) => typeof object[name] === 'number' && Number.isFinite(object[name]))) {
    throw new Error('Judge response must provide a numeric value for every rubric dimension.');
  }
  return parseJudgeJson(candidate, dimensions);
}

export function parseJudgeJson(raw: string, dimensions: readonly string[]): JudgeDimension[] {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? raw).trim();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(candidate);
  } catch {
    parsed = {};
  }
  return dimensions.map((name) => {
    const v = parsed[name];
    const n =
      typeof v === 'number' && Number.isFinite(v)
        ? Math.max(0, Math.min(10, Math.round(v)))
        : 0;
    return { name, value: n };
  });
}

/** Mean of the 0..10 dimensions, scaled to the 0..100 JudgeScore.score scale. */
export function judgeScoreFromDimensions(dims: readonly JudgeDimension[]): number {
  if (dims.length === 0) return 0;
  return Math.round((dims.reduce((a, d) => a + d.value, 0) / dims.length) * 10);
}

export interface JudgeOpts {
  prompt: string;
  responseText: string;
  dimensions: readonly string[];
  rubricDescription: string;
  /**
   * Judge model override. Defaults to JUDGE_MODEL so the main harness is
   * unchanged; rejudge-cases.ts passes a different one to test judge bias.
   */
  model?: string;
  timeoutMs?: number;
}

export interface RawJudgeResult {
  raw: string;
  usage: Usage;
}

export interface RawClaudeJudgeOpts {
  prompt: string;
  model?: string;
  timeoutMs?: number;
}

/**
 * The rubric prompt, verbatim. Exported so alternate judge backends (see
 * rejudge-cases.ts) score against byte-identical text — a judge comparison is
 * only meaningful if the only variable is the model.
 */
export function buildJudgePrompt(opts: JudgeOpts): string {
  const blinded = blindResponse(opts.responseText);
  return `
You are an evaluator. Score the assistant response below on these dimensions: ${opts.dimensions.join(', ')}.
Each dimension is 0 to 10 (integer). Use the rubric:
${opts.rubricDescription}

Original prompt:
"""
${opts.prompt}
"""

Assistant response:
"""
${blinded}
"""

Reply with ONLY a JSON object mapping each dimension to an integer 0..10. No prose.
`.trim();
}

export async function runClaudeJudgePrompt(opts: RawClaudeJudgeOpts): Promise<RawJudgeResult> {
  let raw = '';
  const usage = emptyUsage();
  const abortController = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, timeoutMs);
  try {
    for await (const msg of query({
      prompt: opts.prompt,
      options: {
        model: opts.model ?? JUDGE_MODEL,
        tools: [],
        allowedTools: [],
        mcpServers: {},
        strictMcpConfig: true,
        maxTurns: 1,
        abortController,
      },
    })) {
      if (msg.type === 'result') {
        const r = msg as unknown as {
          subtype?: string;
          is_error?: boolean;
          result?: string;
          usage?: Record<string, number>;
          total_cost_usd?: number;
        };
        if (r.is_error || r.subtype !== 'success') {
          throw new Error(`Judge SDK result error: subtype=${r.subtype ?? 'unknown'}`);
        }
        raw = typeof r.result === 'string' ? r.result : '';
        if (r.usage) {
          usage.inputTokens = r.usage.input_tokens ?? 0;
          usage.outputTokens = r.usage.output_tokens ?? 0;
          usage.cacheReadTokens = r.usage.cache_read_input_tokens ?? 0;
          usage.cacheCreationTokens = r.usage.cache_creation_input_tokens ?? 0;
        }
        if (typeof r.total_cost_usd === 'number') usage.costUsd = r.total_cost_usd;
      }
    }
  } catch (error) {
    if (timedOut) throw new Error(`Claude judge timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  usage.totalTokens =
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;

  return { raw, usage };
}

export async function judgeRun(opts: JudgeOpts): Promise<CurrentJudgeScore> {
  const result = await runClaudeJudgePrompt({
    prompt: buildJudgePrompt(opts),
    model: opts.model,
    timeoutMs: opts.timeoutMs,
  });

  const dims = parseValidJudgeJson(result.raw, opts.dimensions);
  return {
    score: judgeScoreFromDimensions(dims),
    judgeStatus: 'completed',
    dimensions: dims,
    raw: result.raw,
    usage: result.usage,
  };
}
