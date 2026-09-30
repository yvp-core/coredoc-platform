// evals/harness/judge-codex.ts
// The codex-CLI judge backend, plus the `<backend>:<model>` judge spec both
// harnesses select with. Extracted from rejudge-cases.ts so the main harness
// (run.ts) can use the same judge without importing the whole re-judge tool.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { buildCodexArgs, parseCodexStream, spawnCodex } from './agent-codex.js';
import {
  buildJudgePrompt,
  JUDGE_MODEL,
  judgeRun,
  judgeScoreFromDimensions,
  parseJudgeJson,
  type JudgeOpts,
  type RawJudgeResult,
} from './judge.js';
import type { CurrentJudgeScore, JudgeScore, Usage } from './types.js';

export const CODEX_JUDGE_TIMEOUT_MS = 5 * 60 * 1000;

/** Which CLI drives the judge. */
export enum JudgeBackend {
  Claude = 'claude',
  Codex = 'codex',
}

export interface JudgeSpec {
  backend: JudgeBackend;
  model: string;
  /** Filesystem-safe id used in the output directory name. */
  slug: string;
}

/** Parses `--judge claude:<model>` / `codex:<model>`. */
export function parseJudgeSpec(raw: string): JudgeSpec {
  const idx = raw.indexOf(':');
  if (idx <= 0 || idx === raw.length - 1) {
    throw new Error(
      `Invalid --judge "${raw}". Expected "<backend>:<model>", e.g. claude:claude-sonnet-5 or codex:gpt-6-sol.`,
    );
  }
  const backendRaw = raw.slice(0, idx);
  const model = raw.slice(idx + 1);
  const known = Object.values(JudgeBackend) as string[];
  if (!known.includes(backendRaw)) {
    throw new Error(`Unknown judge backend "${backendRaw}". Expected one of: ${known.join(', ')}.`);
  }
  const backend = backendRaw as JudgeBackend;
  const slug = `${backend}-${model.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.replace(/-+$/, '');
  return { backend, model, slug };
}

/** The pinned claude judge — what run.ts uses when no --judge is given. */
export const DEFAULT_JUDGE_SPEC: JudgeSpec = parseJudgeSpec(
  `${JudgeBackend.Claude}:${JUDGE_MODEL}`,
);

/** `backend:model`, the form recorded in reports so a run states its judge. */
export function formatJudgeSpec(spec: JudgeSpec): string {
  return `${spec.backend}:${spec.model}`;
}

/** Appended verbatim to the rubric prompt on the one retry after a parse failure. */
export const CODEX_JUDGE_RETRY_REMINDER =
  'Your previous reply could not be parsed. Reply with verbatim JSON only: a single JSON object mapping each dimension name to an integer 0..10. No prose, no explanation, no markdown fences.';
const CODEX_GROUNDED_RETRY_REMINDER =
  'Inspect the source with a shell command before replying, and include a non-empty "_evidence" array of repo/path:line citations.';

/**
 * Add two judge usages. Both the first attempt and its retry are BILLED, so the reported cost
 * of a retried judge must include both; returning only the retry silently under-reports every
 * retried judge call in the number used to price the run.
 */
export function sumJudgeUsage(first: Usage, second: Usage): Usage {
  return {
    inputTokens: first.inputTokens + second.inputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    cacheReadTokens: first.cacheReadTokens + second.cacheReadTokens,
    cacheCreationTokens: first.cacheCreationTokens + second.cacheCreationTokens,
    totalTokens: first.totalTokens + second.totalTokens,
    costUsd: first.costUsd + second.costUsd,
  };
}

/** Extracts the JSON object a judge reply is supposed to be (fenced or bare). */
export function extractJudgeJsonObject(raw: string): Record<string, unknown> | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? raw).trim();
  // A model that wrapped the object in prose still parses if we take the outer
  // braces; anything else is a genuine parse failure and must trigger a retry.
  const braced = candidate.startsWith('{')
    ? candidate
    : (candidate.match(/\{[\s\S]*\}/)?.[0] ?? candidate);
  try {
    const parsed = JSON.parse(braced) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface CodexJudgeParse {
  /** True only when every rubric dimension came back as a finite number. */
  ok: boolean;
  dimensions: ReturnType<typeof parseJudgeJson>;
  score: number;
  evidence: string[];
}

/**
 * Scores a codex reply with judge.ts's own parser, plus an explicit ok flag.
 * parseJudgeJson silently maps a missing/garbage dimension to 0, which is
 * indistinguishable from a real zero — the flag is what lets us retry instead
 * of recording a fabricated 0.
 */
export function parseCodexJudgeResponse(
  raw: string,
  dimensions: readonly string[],
  requireEvidence = false,
  evidenceRoot?: string,
): CodexJudgeParse {
  const obj = extractJudgeJsonObject(raw);
  const rawEvidence = Array.isArray(obj?._evidence) ? obj._evidence : [];
  const evidence = rawEvidence.filter((item): item is string => typeof item === 'string');
  const evidenceIsValid =
    evidence.length === rawEvidence.length &&
    evidence.length > 0 &&
    evidence.every((citation) => {
      const match = citation.match(/^(repo-\d+\/[^:\n]+):([1-9]\d*)$/);
      if (!match || !evidenceRoot || match[1]!.split('/').includes('..')) return false;
      const path = resolve(evidenceRoot, match[1]!);
      const local = relative(evidenceRoot, path);
      if (local.startsWith('..') || !existsSync(path) || !statSync(path).isFile()) return false;
      const text = readFileSync(path, 'utf8');
      const lineCount = text === '' ? 0 : text.split(/\r?\n/).length - (/\r?\n$/.test(text) ? 1 : 0);
      return Number(match[2]) <= lineCount;
    });
  const ok =
    obj !== null &&
    dimensions.every((d) => typeof obj[d] === 'number' && Number.isFinite(obj[d] as number)) &&
    (!requireEvidence || evidenceIsValid);
  const dims = parseJudgeJson(raw, dimensions);
  return { ok, dimensions: dims, score: judgeScoreFromDimensions(dims), evidence };
}

export interface CodexJudgeOpts {
  prompt: string;
  dimensions: readonly string[];
  model: string;
  lastMessagePath: string;
  timeoutMs?: number;
  /** Caller-owned, source-only workspace for an opt-in grounded rejudge. */
  historylessWorkspaceRoot?: string;
}

export interface CodexRawJudgeOpts {
  prompt: string;
  model: string;
  lastMessagePath: string;
  timeoutMs?: number;
}

export function buildCodexRawJudgeArgs(opts: CodexRawJudgeOpts, cwd: string): string[] {
  return buildCodexArgs({
    cwd,
    lastMessagePath: opts.lastMessagePath,
    withMcp: false,
    model: opts.model,
    prompt: opts.prompt,
    historylessWorkspaceOnly: true,
  });
}

export function hasGroundedSourceInspection(events: readonly unknown[]): boolean {
  let inspected = false;
  for (const event of events) {
    if (!event || typeof event !== 'object') return false;
    const value = event as {
      type?: string;
      item?: { type?: string; status?: string; exit_code?: number };
    };
    if (value.item?.type === 'mcp_tool_call') return false;
    if (
      value.type === 'item.completed' &&
      value.item?.type === 'command_execution' &&
      value.item.status === 'completed' &&
      value.item.exit_code === 0
    ) {
      inspected = true;
    }
  }
  return inspected;
}

export function buildCodexJudgeArgs(
  opts: CodexJudgeOpts,
  cwd: string,
  prompt: string,
): string[] {
  return buildCodexArgs({
    cwd,
    lastMessagePath: opts.lastMessagePath,
    withMcp: false,
    model: opts.model,
    prompt,
    ...(opts.historylessWorkspaceRoot && { historylessWorkspaceOnly: true }),
  });
}

/**
 * Codex ships a fixed shell tool, so a judge cwd under `evals/` exposes target
 * manifests and verifier truth. Give it a fresh empty directory that this
 * harness owns, and remove that directory even when the CLI throws or times
 * out. The prompt is then the only harness-provided task input.
 */
export async function withIsolatedCodexJudgeCwd<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = mkdtempSync(join(tmpdir(), 'coredoc-eval-judge-'));
  try {
    return await run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** One blind, no-retry Codex call for a caller-owned structured prompt. */
export async function runCodexJudgePrompt(opts: CodexRawJudgeOpts): Promise<RawJudgeResult> {
  mkdirSync(dirname(opts.lastMessagePath), { recursive: true });
  const timeoutMs = opts.timeoutMs ?? CODEX_JUDGE_TIMEOUT_MS;
  return withIsolatedCodexJudgeCwd(async (cwd) => {
    const args = buildCodexRawJudgeArgs(opts, cwd);
    const { stdout, stderr, exitCode, timedOut } = await spawnCodex(args, timeoutMs);
    const parsed = parseCodexStream(stdout);
    let raw = parsed.responseText;
    if (!raw.trim() && existsSync(opts.lastMessagePath)) {
      raw = readFileSync(opts.lastMessagePath, 'utf8');
    }
    if (timedOut) throw new Error(`codex judge timed out after ${timeoutMs}ms`);
    if (exitCode !== 0) {
      throw new Error(`codex judge exited with code ${exitCode}: ${stderr.trim().slice(-300)}`);
    }
    return { raw, usage: parsed.usage };
  });
}

/**
 * One-shot `codex exec` judging. Conventions (read-only sandbox,
 * --ignore-user-config, --output-last-message, OPENSSL_CONF neutralization,
 * timeout+kill) are inherited from agent-codex.ts rather than re-derived. No
 * MCP config: the judge only reads the prompt it is handed.
 */
export async function runCodexJudge(opts: CodexJudgeOpts): Promise<CurrentJudgeScore> {
  mkdirSync(dirname(opts.lastMessagePath), { recursive: true });
  const timeoutMs = opts.timeoutMs ?? CODEX_JUDGE_TIMEOUT_MS;
  const runIn = async (cwd: string): Promise<CurrentJudgeScore> => {
    const grounded = opts.historylessWorkspaceRoot !== undefined;
    const attempt = async (prompt: string): Promise<{
      raw: string;
      parse: CodexJudgeParse;
      usage: JudgeScore['usage'];
      inspectedSource: boolean;
    }> => {
      const args = buildCodexJudgeArgs(opts, cwd, prompt);
      const { stdout, stderr, exitCode, timedOut } = await spawnCodex(args, timeoutMs);
      const parsed = parseCodexStream(stdout);
      let raw = parsed.responseText;
      if (!raw.trim() && existsSync(opts.lastMessagePath)) {
        raw = readFileSync(opts.lastMessagePath, 'utf8');
      }
      if (timedOut) throw new Error(`codex judge timed out after ${timeoutMs}ms`);
      if (exitCode !== 0) {
        throw new Error(`codex judge exited with code ${exitCode}: ${stderr.trim().slice(-300)}`);
      }
      return {
        raw,
        parse: parseCodexJudgeResponse(raw, opts.dimensions, grounded, grounded ? cwd : undefined),
        usage: parsed.usage,
        inspectedSource: hasGroundedSourceInspection(parsed.events),
      };
    };

    const first = await attempt(opts.prompt);
    if (first.parse.ok && (!grounded || first.inspectedSource)) {
      return {
        score: first.parse.score,
        judgeStatus: 'completed',
        dimensions: first.parse.dimensions,
        raw: first.raw,
        usage: first.usage,
      };
    }
    const retry = await attempt(
      `${opts.prompt}\n\n${CODEX_JUDGE_RETRY_REMINDER}${grounded ? `\n${CODEX_GROUNDED_RETRY_REMINDER}` : ''}`,
    );
    if (!retry.parse.ok || (grounded && !retry.inspectedSource)) {
      throw new Error(
        grounded
          ? 'grounded codex judge must inspect source and return dimension scores with _evidence citations.'
          : `codex judge produced unparseable JSON twice (last reply: ${retry.raw.slice(0, 200)})`,
      );
    }
    return {
      score: retry.parse.score,
      judgeStatus: 'completed',
      dimensions: retry.parse.dimensions,
      raw: retry.raw,
      // BOTH attempts were billed, so report both. Returning only the retry's usage
      // under-reported judge cost by a whole attempt every time the first reply was
      // unparseable — silently, in the number used to price the run.
      usage: sumJudgeUsage(first.usage, retry.usage),
    };
  };
  return opts.historylessWorkspaceRoot
    ? runIn(opts.historylessWorkspaceRoot)
    : withIsolatedCodexJudgeCwd(runIn);
}

/** Swappable backends — injected in tests so no CLI/SDK is spawned. */
export interface JudgeRunners {
  claude: (opts: JudgeOpts) => Promise<JudgeScore>;
  codex: (opts: CodexJudgeOpts) => Promise<JudgeScore>;
}

const DEFAULT_RUNNERS: JudgeRunners = { claude: judgeRun, codex: runCodexJudge };

export interface JudgeWithSpecOpts {
  spec: JudgeSpec;
  /** Rubric inputs — identical whichever backend scores them. */
  judge: JudgeOpts;
  /** Where the codex judge dumps its last message (unused by claude). */
  codexLastMessagePath: string;
}

/**
 * Dispatches one judging call to the backend the spec names. The codex backend
 * is handed buildJudgePrompt's output so both backends score byte-identical
 * rubric text — a cross-judge comparison is only meaningful if the model is the
 * only variable.
 */
export async function judgeWithSpec(
  opts: JudgeWithSpecOpts,
  runners: JudgeRunners = DEFAULT_RUNNERS,
): Promise<JudgeScore> {
  if (opts.spec.backend === JudgeBackend.Codex) {
    return runners.codex({
      prompt: buildJudgePrompt(opts.judge),
      dimensions: opts.judge.dimensions,
      model: opts.spec.model,
      lastMessagePath: opts.codexLastMessagePath,
    });
  }
  return runners.claude({ ...opts.judge, model: opts.spec.model });
}
