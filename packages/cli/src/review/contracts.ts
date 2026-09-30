import { z } from 'zod';
import { LlmProvider } from '../ci/llm-config.js';

/** Review-only provider value, deliberately not in the shared `LlmProvider` enum that `createModel` consumes. */
export enum ReviewProvider {
  ClaudeCode = 'claude-code',
}

export enum ReviewAuthMode {
  ApiKey = 'api-key',
  Subscription = 'subscription',
}

export enum ReviewRuntime {
  AiSdk = 'ai-sdk-7',
  ClaudeAgentSdk = 'claude-agent-sdk',
}

export function authModeFor(provider: string): ReviewAuthMode {
  return provider === ReviewProvider.ClaudeCode ? ReviewAuthMode.Subscription : ReviewAuthMode.ApiKey;
}

export function runtimeFor(provider: string): ReviewRuntime {
  return provider === ReviewProvider.ClaudeCode ? ReviewRuntime.ClaudeAgentSdk : ReviewRuntime.AiSdk;
}

export const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const repoSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/)
  .refine((name) => !['.', '..'].includes(name.split('/')[1]!));
export const pathSchema = z.string().min(1).max(1000).refine(isSourcePath, 'Unsafe or private source path');

export function isSourcePath(value: string): boolean {
  // These controls cannot be represented safely in source paths or line reports.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters at the source boundary
  if (/^[/-]|[\\\x00-\x1f\x7f:]/.test(value)) return false;
  return value
    .split('/')
    .every(
      (part) =>
        part !== '' &&
        part !== '.' &&
        part !== '..' &&
        !/^(?:\.git|\.coredoc|\.ssh|\.env(?:\..*)?|\.npmrc|\.netrc|_netrc|\.pgpass|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\..*)?)$/i.test(
          part,
        ) &&
        !/\.(?:pem|key|p12|pfx|jks|keystore|ppk|kdbx)$/i.test(part),
    );
}

/** Per-call output ceiling shared by the engine and the OpenRouter reservation guard. It includes
 * reasoning for models that count it as completion (DeepSeek needed more than 4,000; Luna Pro spent
 * 57,000 on one discovery step and its reasoning is not capped by max_tokens at all), so it only
 * decides where a visible answer gets truncated. */
export const MAX_PHASE_OUTPUT_TOKENS = 48_000;

// createModel() forwards any "http…" provider verbatim as the base URL, so an untrusted
// setting could redirect the API key and pinned source to an arbitrary host. This only
// constrains the transport — TLS, or plain HTTP on loopback — not which host is reached:
// any https destination is accepted, so the provider URL remains a trusted maintainer input.
export function isAllowedProvider(value: string): boolean {
  if ((Object.values(LlmProvider) as string[]).includes(value)) return true;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  return (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  );
}

export const limitsSchema = z
  .object({
    maxFiles: z.number().int().positive().max(200).default(150),
    maxDiffLines: z.number().int().positive().max(15_000).default(15_000),
    maxFileBytes: z.number().int().positive().max(1_000_000).default(1_000_000),
    maxDiffBytes: z.number().int().positive().max(2_000_000).default(2_000_000),
    maxSourceBytes: z.number().int().positive().max(10_000_000).default(4_000_000),
    maxContextBytes: z.number().int().positive().max(10_000_000).default(6_000_000),
    // Steps and tool calls are safety ceilings only; the dollar budget and wall clock are the real limits.
    maxToolCalls: z.number().int().positive().max(5_000).default(2_000),
    maxSteps: z.number().int().min(2).max(2_000).default(1_000),
    maxSeconds: z.number().int().positive().max(3_600).default(1_500),
    maxFindings: z.number().int().positive().max(20).default(10),
    /** Discovery lenses the router may select, including `logic`, which always runs. */
    maxLenses: z.number().int().positive().max(6).default(4),
    /** Lenses in flight at once. Every extra lens adds a per-minute token load on the same key. */
    maxParallelLenses: z.number().int().positive().max(6).default(2),
  })
  .strict();

export const requestSchema = z
  .object({
    schemaVersion: z.literal(1),
    repository: repoSchema,
    pullNumber: z.number().int().positive(),
    baseSha: shaSchema,
    mergeBaseSha: shaSchema,
    headSha: shaSchema,
    mode: z.enum(['historical', 'prospective']),
    arm: z.enum(['A', 'B']),
    policy: z.object({ version: z.string().min(1).max(200), text: z.string().max(12_000) }).strict(),
    model: z
      .object({
        provider: z
          .string()
          .min(1)
          .max(500)
          .refine(
            (value) => value === ReviewProvider.ClaudeCode || isAllowedProvider(value),
            'Provider must be a known provider name or an https URL (http only on loopback)',
          ),
        id: z.string().min(1).max(200),
        temperature: z.number().min(0).max(2).optional(),
        seed: z.number().int().optional(),
        // Prices are supplied by the pilot owner, never guessed from a model name.
        inputUsdPerMillion: z.number().nonnegative().optional(),
        outputUsdPerMillion: z.number().nonnegative().optional(),
        maxUsd: z.number().positive().optional(),
      })
      .strict()
      .refine(
        (m) => m.maxUsd === undefined || (m.inputUsdPerMillion !== undefined && m.outputUsdPerMillion !== undefined),
        'A dollar budget requires both declared token prices',
      )
      .refine(
        (m) =>
          m.provider !== ReviewProvider.ClaudeCode ||
          (m.inputUsdPerMillion === undefined &&
            m.outputUsdPerMillion === undefined &&
            m.maxUsd === undefined &&
            m.temperature === undefined &&
            m.seed === undefined),
        'claude-code runs on a subscription: prices, maxUsd, temperature and seed are not accepted',
      ),
    limits: limitsSchema.default(() => limitsSchema.parse({})),
    exclude: z.array(z.string().min(1).max(500)).max(100).default([]),
    graph: z
      .object({
        url: z.string().url().optional(),
        local: z
          .object({
            cliPath: z.string().min(1),
            configPath: z.string().min(1),
            projectId: z.string().min(1),
            backend: z.enum(['ladybug', 'sqlite']).default('ladybug'),
          })
          .strict()
          .optional(),
        scope: z.string().min(1).max(300),
        repoName: z.string().min(1).max(200),
        // Historical admission is an explicit maintainer assertion, checked against observed graph SHA.
        locallyPreparedBase: z.boolean().default(false),
      })
      .strict()
      .refine(
        (graph) => Boolean(graph.url) !== Boolean(graph.local),
        'Choose an MCP URL or a trusted local CLI installation',
      )
      .optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if ((r.arm === 'B') !== Boolean(r.graph))
      ctx.addIssue({ code: 'custom', message: 'Only arm B requires graph settings' });
  });

export type ReviewRequest = z.infer<typeof requestSchema>;
export type Limits = ReviewRequest['limits'];
export type Revision = 'base' | 'head';
export interface TreeEntry {
  path: string;
  oid: string;
  mode: string;
  size?: number;
}
export interface ChangedFile {
  path: string;
  previousPath?: string;
  status: string;
  patch?: string;
  /** False when no exact patch could be derived, so no line may be treated as changed. Absent means true. */
  anchorable?: boolean;
}
export interface Collection<T> {
  items: T[];
  gaps: string[];
}
export interface SourceReader {
  list(revision: Revision): Promise<Collection<TreeEntry>>;
  read(revision: Revision, path: string): Promise<string>;
  changes(): Promise<Collection<ChangedFile>>;
  distance?(graphSha: string): Promise<GraphDistance>;
}
export interface GraphDistance {
  relation: 'equal' | 'ancestor' | 'descendant' | 'diverged' | 'unknown';
  ahead: number | null;
  behind: number | null;
  source: 'api' | 'local' | 'unknown';
}
export interface GraphSnapshot {
  commit: string | null;
  snapshotId: string | null;
  parsedAt: string | null;
  capturedAt: string;
}
export interface GraphReader {
  snapshot(): Promise<GraphSnapshot>;
  query(
    operation: 'search_symbols' | 'explain' | 'find_callers' | 'analyze_change_impact',
    query: string,
  ): Promise<unknown>;
  close(): Promise<void>;
}
const modelEvidenceSchema = z
  .object({
    revision: z.enum(['base', 'head']),
    path: pathSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    excerpt: z.string().min(1).max(4000),
  })
  .strict();
/** Longest evidence quote the host accepts, in lines. 4,000 excerpt characters fit that many. */
export const MAX_EVIDENCE_LINES = 40;
// Model endLine is redundant: the engine derives it from the exact quote before
// host validation. Check the range there so one bad quote cannot discard others.
export const evidenceSchema = modelEvidenceSchema.refine(
  (e) => e.endLine >= e.startLine && e.endLine - e.startLine < MAX_EVIDENCE_LINES,
  'Evidence range is too large',
);
export const findingSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    cause: z.string().min(1).max(400),
    severity: z.enum(['P0', 'P1', 'P2']),
    title: z.string().min(1).max(180),
    trigger: z.string().min(1).max(1500),
    impact: z.string().min(1).max(1500),
    changedCode: z.string().min(1).max(1500),
    existingHandling: z.string().min(1).max(1500),
    anchor: z
      .object({ path: pathSchema, revision: z.enum(['base', 'head']), line: z.number().int().positive() })
      .strict(),
    evidence: z.array(evidenceSchema).min(1).max(6),
  })
  .strict();
export type Finding = z.infer<typeof findingSchema>;
export const candidatesSchema = z
  .object({
    summary: z.string().max(2000),
    findings: z.array(findingSchema.extend({ evidence: z.array(modelEvidenceSchema).min(1).max(6) })).max(20),
  })
  .strict();
export const verdictsSchema = z
  .object({
    verdicts: z
      .array(
        z
          .object({
            id: z.string(),
            decision: z.enum(['confirm', 'reject', 'unresolved']),
            reason: z.string().min(1).max(1500),
            // Head evidence for a rejected prior finding: it settles the recheck in this phase.
            // Required (empty allowed): OpenAI strict schemas reject optional properties.
            evidence: z.array(modelEvidenceSchema).max(6),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export const rechecksSchema = z
  .object({
    verdicts: z
      .array(
        z
          .object({
            id: z.string(),
            decision: z.enum(['confirm', 'reject', 'unresolved']),
            reason: z.string().min(1).max(1500),
            evidence: z.array(modelEvidenceSchema).max(6),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
/** Metadata only: no prompt, response, reasoning, tool payload or provider error text. */
export interface ModelCallDiagnostic {
  phase: 'router' | 'discovery' | 'verification' | 'recheck';
  /** The discovery lens this call belongs to; absent on the router and the later phases. */
  lens?: string;
  step: number;
  final: boolean;
  durationMs: number;
  finishReason: string;
  rawFinishReason: string;
  inputTokens: number | null;
  /** Prompt tokens the provider served from its cache; null when it reports no cache accounting. */
  cachedInputTokens: number | null;
  /** Prompt tokens the provider wrote to its cache on this call; null when unreported. */
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  textBytes: number;
  toolCalls: number;
  outputLimit: number;
  toolLimitations?: string[];
  outputValidation?: { format: 'json' | 'fenced-json' | 'text' | 'empty'; schemaValid: boolean; issues: string[] };
}

export interface ReviewResult {
  schemaVersion: 1;
  runId: string;
  revision: Pick<ReviewRequest, 'repository' | 'pullNumber' | 'baseSha' | 'mergeBaseSha' | 'headSha'>;
  mode: ReviewRequest['mode'];
  arm: ReviewRequest['arm'];
  status: 'completed' | 'incomplete' | 'cancelled';
  configuration: {
    runtime: string;
    auth: ReviewAuthMode;
    model: ReviewRequest['model'];
    policyVersion: string;
    policyDigest: string;
    promptVersion: string;
    runnerVersion: string;
    limits: Limits;
    unsupportedSampling: string[];
  };
  summary: string;
  findings: Finding[];
  /**
   * Every merged discovery candidate and what became of it, so an operator can see which claim was
   * dropped and why. Titles and anchors are the model's own claims; `reason` carries host codes only.
   * Absent when no discovery ran.
   */
  candidates?: Array<{
    id: string;
    lens?: string;
    severity: Finding['severity'];
    title: string;
    anchor: Finding['anchor'];
    verdict: 'confirm' | 'reject' | 'unresolved' | 'not-judged';
    outcome: 'published' | 'dropped' | 'rejected' | 'unresolved';
    reason?: string;
  }>;
  verification: z.infer<typeof verdictsSchema>['verdicts'];
  rechecks?: z.infer<typeof rechecksSchema>['verdicts'];
  modelCalls?: ModelCallDiagnostic[];
  billing?: { actualUsd: number; reservedUsd: number; calls: number; uncertain: boolean; maxUsd: number };
  publication?: {
    status: 'published' | 'partial' | 'failed' | 'superseded' | 'disabled';
    commentIds: number[];
    reason?: string;
  };
  coverage: {
    changed: string[];
    read: string[];
    excluded: string[];
    gaps: string[];
    /** What the router selected and what each lens spent; absent when no discovery ran. */
    lenses?: Array<{
      id: string;
      reason: string;
      focusFiles: string[];
      steps: number;
      candidates: number;
      failed?: string;
    }>;
  };
  graph:
    | null
    | (GraphSnapshot & {
        distance: GraphDistance;
        status: 'available' | 'failed' | 'changed';
        admissibility: 'primary' | 'diagnostic';
        reason: string | null;
      });
  usage: {
    steps: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
    costKind: 'configured-rates' | 'unknown';
    durationMs: number;
  };
}

export class ReviewError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'ReviewError';
  }
}
