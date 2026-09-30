import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { RECOVERABLE_REVIEW_CODES } from './access.js';
import { MAX_PHASE_OUTPUT_TOKENS, ReviewError, type ModelCallDiagnostic } from './contracts.js';
import type { PhaseCall } from './engine.js';

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk');
export type ClaudeQuery = Sdk['query'];

export interface ClaudeCodeRuntimeOptions {
  /** The Claude Code model id or alias (`sonnet`, `opus`, a dated id). */
  model: string;
  /** The whole child environment: the SDK replaces, it does not merge (see claudeCodeEnv). */
  env: Record<string, string>;
  /** Test seam: a fake `query` so unit tests never spawn the runtime or touch a credential. */
  query?: ClaudeQuery;
}

const SERVER = 'coredoc-review';
/** Mirrors the engine's COVERAGE_NUDGES. */
const COVERAGE_NUDGES = 3;
// Keep byte-identical with the final-step instruction in `phase()`.
const FINAL_STEP =
  'Tools are unavailable for this final step. Return your final JSON using only evidence already read; omit unsupported claims.';

// Anything else (an API key, ANTHROPIC_* URL, Bedrock/Vertex switch, proxy, DEBUG*) would outrank
// the subscription token or write debug logs; HOME and CLAUDE_CONFIG_DIR are injected per run.
const ENV_ALLOWLIST = ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'CLAUDE_CODE_OAUTH_TOKEN'];

export function claudeCodeEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = source[key];
    if (value) env[key] = value;
  }
  return env;
}

let cached: Sdk | null = null;
async function loadSdk(): Promise<Sdk> {
  if (!cached) {
    try {
      cached = await import('@anthropic-ai/claude-agent-sdk');
    } catch {
      throw new ReviewError('CLAUDE_RUNTIME_UNAVAILABLE');
    }
  }
  return cached;
}

export interface ClaudeCodeRuntime {
  options: ClaudeCodeRuntimeOptions;
  /** Passed in rather than imported, so this module never imports the engine at run time. */
  systemPrompt: string;
  signal: AbortSignal;
  /** Used as cwd, HOME and CLAUDE_CONFIG_DIR; removed by close(). */
  dir: string;
  sdk: Sdk;
  query: ClaudeQuery;
  close(): Promise<void>;
}

export async function createClaudeCodeRuntime(
  options: ClaudeCodeRuntimeOptions,
  systemPrompt: string,
  signal: AbortSignal,
): Promise<ClaudeCodeRuntime> {
  const sdk = await loadSdk();
  const dir = await mkdtemp(join(tmpdir(), 'coredoc-review-'));
  return {
    options,
    systemPrompt,
    signal,
    dir,
    sdk,
    query: options.query ?? sdk.query,
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * The Agent SDK (through 0.2.77) starts `handleControlRequest` without a catch, so a tool or
 * permission reply written after the abort rejects unhandled and would kill the process before
 * the run reports why it aborted. Entry points ignore exactly that rejection.
 */
export function isAbortedControlWrite(reason: unknown): boolean {
  return (
    // The SDK's AbortError sets no `name` (it reads `Error`), and 0.2.77 minifies the class.
    reason instanceof Error &&
    reason.message === 'Operation aborted' &&
    (reason.stack ?? '').includes('handleControlRequest')
  );
}

const content = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });

/** The Claude Code implementation of the engine's phase contract; see `phase()` for the AI SDK one. */
export async function claudeCodePhase<T>(call: PhaseCall<T>, runtime: ClaudeCodeRuntime): Promise<T> {
  const {
    schema,
    prefix,
    task,
    access,
    diagnostics,
    reserved = 0,
    required = [],
    accept,
    maxNudges = COVERAGE_NUDGES,
    allowance,
    tools: useTools = true,
  } = call;
  const b = access.budget;
  const reserve = Math.min(reserved, Math.max(0, b.request.limits.maxSteps - b.steps - 1));
  const request = access.mask({ ...task, outputSchema: z.toJSONSchema(schema) });
  b.context(request);
  const outputFormat = { type: 'json_schema' as const, schema: z.toJSONSchema(schema) as Record<string, unknown> };
  /** Paths this phase read or tried itself, so a sibling lens's read never covers its floor. */
  const covered = new Set<string>();
  let spent = 0;
  let fatal: unknown;
  let sessionId: string | undefined;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  runtime.signal.addEventListener('abort', onAbort, { once: true });

  const hostTools = useTools ? access.tools(covered) : {};
  const names = Object.keys(hostTools);
  const qualified = names.map((name) => `mcp__${SERVER}__${name}`);
  const definitions = Object.entries(hostTools).map(([name, host]) => {
    const inputSchema = host.inputSchema as z.ZodObject<z.ZodRawShape>;
    const description = typeof host.description === 'string' ? host.description : '';
    return runtime.sdk.tool(name, description, inputSchema.shape, async (args: unknown) => {
      // The SDK advertises the bare shape; the strict object decides, as on the AI SDK path.
      const parsed = inputSchema.safeParse(args);
      if (!parsed.success) {
        access.gaps.push('TOOL_INPUT_INVALID');
        return content({ error: 'TOOL_INPUT_INVALID' });
      }
      try {
        const execute = host.execute as (input: unknown, options: unknown) => Promise<unknown>;
        return content(await execute(parsed.data, { toolCallId: '', messages: [] }));
      } catch (error) {
        // invoke() rethrows only trust-boundary and budget failures; an MCP result alone cannot stop the run.
        const code = error instanceof ReviewError ? error.code : 'TOOL_READ_FAILED';
        if (error instanceof ReviewError && !RECOVERABLE_REVIEW_CODES.has(code) && code !== 'TOOL_LIMIT') {
          fatal ??= error;
          controller.abort();
        }
        return content({ error: code });
      }
    });
  });

  const affordable = () => Math.max(1, b.request.limits.maxSteps - reserve - b.steps);
  /** Turns the phase may still spend, minus the one reserved for the forced final answer. */
  const turns = () => {
    const available = allowance === undefined ? affordable() : Math.max(1, Math.min(allowance - spent, affordable()));
    return Math.max(1, available - 1);
  };

  const expectedInit = (withTools: boolean) => (withTools ? [...qualified].sort() : []);
  const checkInit = (message: Extract<SDKMessage, { type: 'system'; subtype: 'init' }>, withTools: boolean) => {
    const expected = expectedInit(withTools);
    const servers = withTools && qualified.length ? [SERVER] : [];
    // `agents` is not checked: Claude Code lists its built-in subagent types there even with no
    // Agent tool, so they are unreachable. The dimension that mismatched is recorded as a gap.
    const mismatched = [
      JSON.stringify([...message.tools].sort()) !== JSON.stringify(expected) ? 'INIT_TOOLS_MISMATCH' : null,
      JSON.stringify(message.mcp_servers.map((s) => s.name).sort()) !== JSON.stringify(servers)
        ? 'INIT_SERVERS_MISMATCH'
        : null,
      (message.plugins?.length ?? 0) > 0 ? 'INIT_PLUGINS_PRESENT' : null,
      (message.skills?.length ?? 0) > 0 ? 'INIT_SKILLS_PRESENT' : null,
    ].filter((code): code is string => code !== null);
    if (mismatched.length) {
      access.gaps.push(...mismatched);
      throw new ReviewError('CLAUDE_RUNTIME_TOOLS_UNEXPECTED');
    }
  };

  type Outcome = { kind: 'answer'; value: T } | { kind: 'maxTurns' } | { kind: 'invalid'; issues: string[] };
  /** One `query` over a fresh or resumed session; returns the parsed answer, the turn ceiling or a schema miss. */
  const run = async (
    prompt: string,
    { resume, withTools, final = false }: { resume?: string; withTools: boolean; final?: boolean },
  ): Promise<Outcome> => {
    const started = Date.now();
    const gapsBefore = access.gaps.length;
    const options: Options = {
      model: runtime.options.model,
      systemPrompt: runtime.systemPrompt,
      tools: [],
      ...(withTools && definitions.length
        ? { mcpServers: { [SERVER]: runtime.sdk.createSdkMcpServer({ name: SERVER, tools: definitions }) } }
        : {}),
      allowedTools: withTools ? qualified : [],
      permissionMode: 'dontAsk',
      canUseTool: async (name, input) => {
        if (withTools && qualified.includes(name)) return { behavior: 'allow', updatedInput: input };
        access.gaps.push('TOOL_DENIED');
        return { behavior: 'deny', message: 'TOOL_DENIED' };
      },
      settingSources: [],
      strictMcpConfig: true,
      outputFormat,
      maxTurns: final ? 1 : turns(),
      abortController: controller,
      env: { ...runtime.options.env, HOME: runtime.dir, CLAUDE_CONFIG_DIR: runtime.dir },
      cwd: runtime.dir,
      // Session persistence stays on: `resume` needs the transcript, which lives in the temp dir.
      ...(resume ? { resume } : {}),
    };
    let diagnostic: ModelCallDiagnostic | undefined;
    let turnId: string | undefined;
    let answer: Outcome | undefined;
    try {
      for await (const message of runtime.query({ prompt, options })) {
        if (message.type === 'system' && message.subtype === 'init') {
          checkInit(message, withTools);
          continue;
        }
        if (message.type === 'auth_status') {
          if (message.error) throw new ReviewError('SUBSCRIPTION_CREDENTIAL_REJECTED');
          continue;
        }
        if (message.type === 'assistant') {
          sessionId = message.session_id;
          if (message.error) throw new ReviewError(assistantCode(message.error));
          const blocks = (message.message.content ?? []) as Array<{ type: string; text?: string }>;
          const textBytes = blocks.reduce(
            (sum, part) => sum + (part.type === 'text' ? Buffer.byteLength(part.text ?? '') : 0),
            0,
          );
          const toolCalls = blocks.filter((part) => part.type === 'tool_use').length;
          // Claude Code emits one message per content block of a turn, all sharing `message.id`;
          // a turn is recorded once, when the next one starts or the result arrives.
          if (diagnostic && message.message.id === turnId) {
            diagnostic.textBytes += textBytes;
            diagnostic.toolCalls += toolCalls;
            continue;
          }
          if (diagnostic) diagnostics.record(diagnostic);
          turnId = message.message.id;
          b.step(reserve);
          spent++;
          const toolLimitations = [
            ...new Set(access.gaps.slice(gapsBefore).filter((code) => RECOVERABLE_REVIEW_CODES.has(code))),
          ];
          diagnostic = {
            ...(toolLimitations.length ? { toolLimitations } : {}),
            phase: diagnostics.phase,
            ...(diagnostics.lens ? { lens: diagnostics.lens } : {}),
            step: b.steps,
            final,
            durationMs: Date.now() - started,
            // No per-call output cap exists here; usage arrives on the result message only (LIM-4).
            outputLimit: MAX_PHASE_OUTPUT_TOKENS,
            finishReason: 'unknown',
            rawFinishReason: 'unknown',
            inputTokens: null,
            cachedInputTokens: null,
            cacheWriteTokens: null,
            outputTokens: null,
            reasoningTokens: null,
            textBytes,
            toolCalls,
          };
          continue;
        }
        if (message.type !== 'result') continue;
        sessionId = message.session_id;
        const usage = message.usage as unknown as Record<string, number | undefined> | undefined;
        b.usage(
          (usage?.input_tokens ?? 0) +
            (usage?.cache_read_input_tokens ?? 0) +
            (usage?.cache_creation_input_tokens ?? 0),
          usage?.output_tokens ?? 0,
        );
        if (message.permission_denials.length) access.gaps.push('TOOL_DENIED');
        if (diagnostic) {
          diagnostic.inputTokens = usage?.input_tokens ?? null;
          diagnostic.outputTokens = usage?.output_tokens ?? null;
          diagnostic.finishReason = message.subtype === 'success' ? 'stop' : 'error';
          diagnostics.record(diagnostic);
        }
        if (message.subtype === 'error_max_turns') {
          answer = { kind: 'maxTurns' };
          continue;
        }
        if (message.subtype === 'error_max_structured_output_retries') throw new ReviewError('MODEL_OUTPUT_INVALID');
        if (message.subtype !== 'success') throw new ReviewError('CLAUDE_RUNTIME_FAILED');
        // Claude Code 2.1.12 ignores outputFormat and answers with fenced JSON in `result`.
        const parsed = schema.safeParse(message.structured_output ?? outermostJson(message.result));
        if (!parsed.success) {
          answer = { kind: 'invalid', issues: parsed.error.issues.map((issue) => issue.path.join('.') || issue.code) };
          continue;
        }
        answer = { kind: 'answer', value: access.mask(parsed.data) };
      }
    } catch (error) {
      if (diagnostic) diagnostics.record(diagnostic);
      if (fatal) throw fatal;
      if (error instanceof ReviewError) throw error;
      // A time limit or cancellation outranks whatever the aborted SDK stream threw.
      b.check();
      const code = (error as { code?: unknown }).code;
      throw new ReviewError(code === 'ENOENT' ? 'CLAUDE_RUNTIME_UNAVAILABLE' : 'CLAUDE_RUNTIME_FAILED');
    }
    if (fatal) throw fatal;
    if (!answer) throw new ReviewError('CLAUDE_RUNTIME_FAILED');
    return answer;
  };

  // The runtime cannot withdraw tools mid-session, so a resumed tool-less call forces the answer;
  // a TOOL_LIMIT does not interrupt a running query either (spec LIM-8).
  const answered = async (prompt: string, resume?: string): Promise<T> => {
    const first = await run(prompt, { resume, withTools: true });
    if (first.kind === 'answer') return first.value;
    if (first.kind === 'invalid') return repaired(first.issues);
    const forced = await run(FINAL_STEP, { resume: sessionId, withTools: false, final: true }).catch(
      (error: unknown) => {
        if (error instanceof ReviewError) throw error;
        throw new ReviewError('STEP_LIMIT');
      },
    );
    if (forced.kind === 'invalid') return repaired(forced.issues);
    if (forced.kind !== 'answer') throw new ReviewError('STEP_LIMIT');
    return forced.value;
  };
  // The AI SDK path's one-shot schema repair (`phase()`); the runtime has no structured-output retry.
  const repaired = async (issues: string[]): Promise<T> => {
    const fixed = await run(
      `Your previous answer did not match the required JSON schema. Schema issues: ${issues.join('; ') || 'invalid JSON'}. Return the same content as valid JSON only, with every required field present; do not investigate further.`,
      { resume: sessionId, withTools: false, final: true },
    );
    if (fixed.kind !== 'answer') throw new ReviewError('MODEL_OUTPUT_INVALID');
    return fixed.value;
  };

  try {
    let output = await answered(`${prefix}\n\n${JSON.stringify(request)}`);
    let nudges = 0;
    for (;;) {
      if (fatal) throw fatal;
      b.check();
      const missing = access.readPaths.size ? required.filter((p) => !covered.has(`head:${p}`)) : [];
      const nudge = missing.length
        ? `Before answering, read these changed files at head with read_source (a listing or an EOF response does not count): ${missing.slice(0, 25).join(', ')}. Then return the final JSON.`
        : await accept?.(output);
      if (!nudge) return output;
      if (
        nudges >= maxNudges ||
        b.steps >= b.request.limits.maxSteps - reserve ||
        (allowance !== undefined && spent >= allowance) ||
        access.gaps.includes('TOOL_LIMIT')
      ) {
        access.gaps.push(missing.length ? 'SOURCE_COVERAGE_PARTIAL' : 'VERIFICATION_EVIDENCE_PARTIAL');
        return output;
      }
      nudges++;
      output = await answered(nudge, sessionId);
    }
  } finally {
    runtime.signal.removeEventListener('abort', onAbort);
  }
}

// Fenced blocks win over the outermost braces, which would swallow prose around them; the
// answer is usually the last block, so blocks are tried last to first.
function outermostJson(text: string | undefined): unknown {
  if (!text) return undefined;
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1] ?? '').reverse();
  const candidates = [...fenced, text];
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

function assistantCode(error: string): string {
  if (error === 'authentication_failed') return 'SUBSCRIPTION_CREDENTIAL_REJECTED';
  if (error === 'rate_limit' || error === 'billing_error') return 'SUBSCRIPTION_PLAN_EXHAUSTED';
  return 'CLAUDE_RUNTIME_FAILED';
}
