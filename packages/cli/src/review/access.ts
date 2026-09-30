import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import {
  ReviewError,
  evidenceSchema,
  pathSchema,
  type ChangedFile,
  type Finding,
  type GraphReader,
  type ReviewRequest,
  type ReviewResult,
  type Revision,
  type SourceReader,
} from './contracts.js';
import { excluded } from './source.js';

export class ReviewBudget {
  readonly started = Date.now();
  steps = 0;
  toolCalls = 0;
  inputTokens = 0;
  outputTokens = 0;
  sourceBytes = 0;
  contextBytes = 0;
  constructor(
    readonly request: ReviewRequest,
    readonly signal: AbortSignal,
    /** Settled provider charges, when the transport reports them exactly (OpenRouter `usage.cost`). */
    private readonly settled?: () => number,
  ) {}
  get cost(): number | null {
    const m = this.request.model;
    if (m.inputUsdPerMillion === undefined || m.outputUsdPerMillion === undefined) return null;
    return (this.inputTokens * m.inputUsdPerMillion + this.outputTokens * m.outputUsdPerMillion) / 1_000_000;
  }
  check(): void {
    // The time limit aborts the same signal as a cancellation, so elapsed time decides first.
    if (Date.now() - this.started >= this.request.limits.maxSeconds * 1000) throw new ReviewError('TIME_LIMIT');
    if (this.signal.aborted) throw new ReviewError('CANCELLED');
    // Declared per-token prices overstate cached prompts many times over (13x on the DeepSeek
    // pilot), so exact settled charges decide when the transport reports them.
    const spent = this.settled ? this.settled() : (this.cost ?? 0);
    if (this.request.model.maxUsd !== undefined && spent >= this.request.model.maxUsd)
      throw new ReviewError('COST_OR_USAGE_LIMIT');
  }
  // `reserve` keeps steps available for the phases that still have to run, so an
  // exploratory phase cannot consume the whole budget and leave the run incomplete.
  step(reserve = 0): void {
    this.check();
    if (++this.steps > this.request.limits.maxSteps - reserve) throw new ReviewError('STEP_LIMIT');
  }
  call(): void {
    this.check();
    // The refused call is not counted: the model is told the budget is gone and must answer.
    if (this.toolCalls >= this.request.limits.maxToolCalls) throw new ReviewError('TOOL_LIMIT');
    this.toolCalls++;
  }
  context(value: unknown): void {
    this.contextBytes += Buffer.byteLength(JSON.stringify(value));
    if (this.contextBytes > this.request.limits.maxContextBytes) throw new ReviewError('CONTEXT_LIMIT');
  }
  usage(input?: number, output?: number): void {
    this.inputTokens += input ?? 0;
    this.outputTokens += output ?? 0;
  }
}

/**
 * Read failures the model can work around by choosing another path, range or query.
 * They are reported to it as a tool result; every other code stops the run, so a budget,
 * cancellation, misconfiguration or trust-boundary failure is never masked as a retryable
 * read error. A leaked secret, a graph answering for the wrong repository or scope and
 * missing or invalid graph provenance are trust boundaries: they end the run.
 */
// A whole PEM private-key block, or a lone header when the block is cut off.
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)?/g;

export const RECOVERABLE_REVIEW_CODES = new Set([
  'SOURCE_NOT_FOUND',
  'SOURCE_RANGE_INVALID',
  'SOURCE_PATH_DENIED',
  'SOURCE_NON_REGULAR',
  'SOURCE_FILE_LIMIT',
  'SOURCE_BINARY',
  'GRAPH_READ_FAILED',
  'GRAPH_RESPONSE_LIMIT',
  'TOOL_READ_FAILED',
]);

export type EvidenceValidation =
  | { valid: true; shift: number }
  | {
      valid: false;
      code:
        | 'EVIDENCE_RANGE_INVALID'
        | 'EVIDENCE_NOT_READ_THIS_PHASE'
        | 'EVIDENCE_EXCERPT_MISMATCH'
        | 'EVIDENCE_EXCERPT_AMBIGUOUS'
        | 'EVIDENCE_SOURCE_UNAVAILABLE'
        | 'FINDING_ANCHOR_NOT_CHANGED'
        | 'FINDING_ANCHOR_NOT_COVERED';
    };

export class ReviewAccess {
  readonly readPaths = new Set<string>();
  /** Paths a read tried and the host refused; re-requesting them cannot return source. */
  readonly attemptedPaths = new Set<string>();
  private readonly cache = new Map<string, string>();
  private observed = new Map<string, Array<[number, number]>>();
  constructor(
    readonly request: ReviewRequest,
    readonly source: SourceReader,
    readonly budget: ReviewBudget,
    readonly gaps: string[],
    private readonly secrets: string[],
    private graph?: GraphReader,
  ) {}

  /** Withdraws graph_lookup after the graph treatment failed; the review continues on source alone. */
  detachGraph(): void {
    this.graph = undefined;
  }
  resetEvidence(): void {
    this.observed.clear();
  }
  /** Whether one read_source window of this phase covers the whole interval. */
  observedThisPhase(revision: Revision, path: string, startLine: number, endLine: number): boolean {
    return (this.observed.get(`${revision}:${path}`) ?? []).some(([from, to]) => from <= startLine && to >= endLine);
  }
  /**
   * Masks host secrets and private-key blocks instead of ending the run: a repository
   * fixture that merely looks like a key must not cost the whole review, and a real
   * secret never reaches the model or the published report either way.
   */
  mask<T>(value: T): T {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text === undefined) return value;
    let masked = text.replace(PRIVATE_KEY_BLOCK, '[REDACTED PRIVATE KEY]');
    for (const secret of this.secrets) if (secret.length >= 6) masked = masked.split(secret).join('[REDACTED]');
    if (masked === text) return value;
    return (typeof value === 'string' ? masked : JSON.parse(masked)) as T;
  }
  async content(revision: Revision, path: string): Promise<string> {
    this.budget.check();
    pathSchema.parse(path);
    const key = `${revision}:${path}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    // Direct reads must preserve the same collection gaps as listing/searching.
    this.gaps.push(...(await this.source.list(revision)).gaps);
    const content = this.mask(await this.source.read(revision, path));
    this.budget.sourceBytes += Buffer.byteLength(content);
    if (this.budget.sourceBytes > this.request.limits.maxSourceBytes) throw new ReviewError('SOURCE_LIMIT');
    this.cache.set(key, content);
    return content;
  }
  async read(revision: Revision, path: string, startLine: number, endLine: number) {
    const content = await this.content(revision, path);
    const lines = content ? content.split('\n') : [];
    // A terminal newline ends the last source line; it does not create another one.
    if (content.endsWith('\n')) lines.pop();
    if (startLine < 1 || endLine < 1) throw new ReviewError('SOURCE_RANGE_INVALID');
    // Models sometimes invert absolute endpoints; expose the actual sorted, clipped range below.
    if (startLine > endLine) [startLine, endLine] = [endLine, startLine];
    // Paging past a readable file proves EOF, not unavailable source. It reads no evidence interval.
    if (startLine > lines.length)
      return { revision, path, startLine: null, endLine: null, totalLines: lines.length, eof: true, text: '' };
    const end = Math.min(endLine, startLine + 119, lines.length);
    const key = `${revision}:${path}`;
    const ranges = this.observed.get(key) ?? [];
    ranges.push([startLine, end]);
    this.observed.set(key, ranges);
    this.readPaths.add(key);
    return {
      revision,
      path,
      startLine,
      endLine: end,
      totalLines: lines.length,
      // Exact source can be copied into evidence without display-only line prefixes.
      text: lines.slice(startLine - 1, end).join('\n'),
    };
  }
  async evidence(evidence: z.infer<typeof evidenceSchema>): Promise<EvidenceValidation> {
    const parsed = evidenceSchema.safeParse(evidence);
    if (!parsed.success) return { valid: false, code: 'EVIDENCE_RANGE_INVALID' };
    const e = parsed.data;
    const content = await this.content(e.revision, e.path);
    const lines = content ? content.split('\n') : [];
    // A terminal newline ends the last source line; it does not create another one.
    if (content.endsWith('\n')) lines.pop();
    const quote = e.excerpt.split('\n');
    const matches = (start: number) => lines.slice(start - 1, start + quote.length - 1).join('\n') === e.excerpt;
    // The quote is the identity of the evidence; its line numbers are derived from it, exactly
    // as endLine already is. Models routinely miscount absolute lines in unnumbered source, so a
    // verbatim quote that occurs exactly once is relocated instead of discarded.
    let start = e.startLine;
    if (e.endLine !== start + quote.length - 1 || !matches(start)) {
      const hits: number[] = [];
      for (let i = 1; i + quote.length - 1 <= lines.length; i++) if (matches(i)) hits.push(i);
      if (!hits.length) return { valid: false, code: 'EVIDENCE_EXCERPT_MISMATCH' };
      if (hits.length > 1) return { valid: false, code: 'EVIDENCE_EXCERPT_AMBIGUOUS' };
      start = hits[0]!;
      // Mutate the caller's evidence so the corrected numbers reach the published finding.
      evidence.startLine = start;
      evidence.endLine = start + quote.length - 1;
    }
    const end = start + quote.length - 1;
    const ranges = this.observed.get(`${e.revision}:${e.path}`) ?? [];
    // A relocated quote must still lie inside a window the model actually read in this phase.
    if (!ranges.some(([from, to]) => from <= start && to >= end))
      return { valid: false, code: 'EVIDENCE_NOT_READ_THIS_PHASE' };
    return { valid: true, shift: start - e.startLine };
  }
  private async invoke<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
    try {
      this.budget.call();
    } catch (error) {
      // An exhausted tool budget must not discard the paid investigation: the model is told,
      // and the engine withdraws tools so the phase answers with the evidence it already has.
      if (!(error instanceof ReviewError) || error.code !== 'TOOL_LIMIT') throw error;
      this.gaps.push('TOOL_LIMIT');
      return { error: 'TOOL_LIMIT' };
    }
    try {
      const result = this.mask(await fn());
      this.budget.context(result);
      return result;
    } catch (error) {
      const code = error instanceof ReviewError ? error.code : 'TOOL_READ_FAILED';
      this.gaps.push(code);
      // Only the code reaches the model; the message may carry source or credentials.
      if (RECOVERABLE_REVIEW_CODES.has(code)) return { error: code };
      throw new ReviewError(code);
    }
  }
  /** `covered` receives the `revision:path` keys this tool set read or tried, so a phase can hold its own coverage floor. */
  tools(covered?: Set<string>): ToolSet {
    const tools = {
      list_source: tool({
        description: 'List pinned source paths by literal prefix. Private files and excluded paths are unavailable.',
        inputSchema: z.object({ revision: z.enum(['base', 'head']), prefix: z.string().max(500) }).strict(),
        execute: ({ revision, prefix }) =>
          this.invoke(async () => {
            const tree = await this.source.list(revision);
            this.gaps.push(...tree.gaps);
            const paths = tree.items
              .filter(
                (x) =>
                  ['100644', '100755'].includes(x.mode) &&
                  !excluded(x.path, this.request.exclude) &&
                  x.path.startsWith(prefix),
              )
              .map((x) => x.path);
            return { paths: paths.slice(0, 150), truncated: paths.length > 150 };
          }),
      }),
      read_source: tool({
        description:
          'Read exact source from base (merge-base) or head. Both endpoints are absolute 1-based line numbers (endLine is not a count). Endpoints are sorted, then windows are clipped to 120 lines and EOF; returned startLine/endLine identify the actual text range. Copy evidence excerpts verbatim, preserving whitespace. Continue at endLine + 1 only when endLine is below totalLines; an EOF response has eof=true, empty text and no evidence range.',
        // A denied path is a tool result the model can recover from, so it is checked inside
        // execute(); an inputSchema refusal would instead surface as an argument-validation error.
        inputSchema: z
          .object({
            revision: z.enum(['base', 'head']),
            path: z.string().min(1).max(1000),
            startLine: z.number().int().positive(),
            endLine: z.number().int().positive(),
          })
          .strict(),
        execute: ({ revision, path, startLine, endLine }) =>
          this.invoke(() => {
            if (!pathSchema.safeParse(path).success) throw new ReviewError('SOURCE_PATH_DENIED');
            const key = `${revision}:${path}`;
            return this.read(revision, path, startLine, endLine).then(
              (result) => {
                if (result.startLine !== null) covered?.add(key);
                return result;
              },
              (error: unknown) => {
                this.attemptedPaths.add(key);
                covered?.add(key);
                throw error;
              },
            );
          }),
      }),
      search_source: tool({
        description:
          'Literal text search in up to 20 pinned files under a prefix. Narrow the prefix if truncated. No regular expressions or shell.',
        inputSchema: z
          .object({ revision: z.enum(['base', 'head']), prefix: z.string().max(500), text: z.string().min(1).max(200) })
          .strict(),
        execute: ({ revision, prefix, text }) =>
          this.invoke(async () => {
            const tree = await this.source.list(revision);
            this.gaps.push(...tree.gaps);
            const paths = tree.items.filter(
              (x) =>
                ['100644', '100755'].includes(x.mode) &&
                !excluded(x.path, this.request.exclude) &&
                x.path.startsWith(prefix),
            );
            const matches: Array<{ path: string; line: number; text: string }> = [];
            for (const entry of paths.slice(0, 20)) {
              const lines = (await this.content(revision, entry.path)).split('\n');
              for (let i = 0; i < lines.length && matches.length < 30; i++) {
                if (lines[i]!.includes(text))
                  matches.push({ path: entry.path, line: i + 1, text: lines[i]!.slice(0, 500) });
              }
            }
            return { matches, truncated: paths.length > 20 || matches.length >= 30 };
          }),
      }),
    };
    if (!this.graph) return tools;
    return {
      ...tools,
      graph_lookup: tool({
        description:
          'Read scoped Coredoc graph hints. Verify all behavioral claims in pinned source; absent/stale edges prove nothing.',
        inputSchema: z
          .object({
            operation: z.enum(['search_symbols', 'explain', 'find_callers', 'analyze_change_impact']),
            query: z.string().min(1).max(200),
          })
          .strict(),
        execute: ({ operation, query }) => this.invoke(async () => this.graph!.query(operation, query)),
      }),
    };
  }
}

export function changedLines(patch: string, revision: Revision): Set<number> {
  const lines = new Set<number>();
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }
    if (!inHunk || line.startsWith('\\')) continue;
    if (line.startsWith('-')) {
      if (revision === 'base') lines.add(oldLine);
      oldLine++;
    } else if (line.startsWith('+')) {
      if (revision === 'head') lines.add(newLine);
      newLine++;
    } else if (line.startsWith(' ')) {
      oldLine++;
      newLine++;
    }
  }
  return lines;
}

export async function validateFinding(
  finding: Finding,
  access: ReviewAccess,
  changes: ChangedFile[],
): Promise<EvidenceValidation> {
  Object.assign(finding, access.mask(finding));
  const a = finding.anchor;
  // Evidence is validated first, because relocating a miscounted quote also tells us by how much
  // the anchor the model derived from that quote is off.
  const claimed = finding.evidence.map((e) => e.startLine);
  try {
    for (const e of finding.evidence) {
      const checked = await access.evidence(e);
      if (!checked.valid) return checked;
    }
  } catch (error) {
    // An unreadable excerpt invalidates this finding only; budget and cancellation still stop the run.
    if (error instanceof ReviewError && RECOVERABLE_REVIEW_CODES.has(error.code))
      return { valid: false, code: 'EVIDENCE_SOURCE_UNAVAILABLE' };
    throw error;
  }
  const covers = (e: Finding['evidence'][number]) =>
    e.path === a.path && e.revision === a.revision && e.startLine <= a.line && e.endLine >= a.line;
  if (!finding.evidence.some(covers)) {
    const relocated = finding.evidence.findIndex(
      (e, i) =>
        e.path === a.path &&
        e.revision === a.revision &&
        e.startLine !== claimed[i] &&
        claimed[i]! <= a.line &&
        claimed[i]! + (e.endLine - e.startLine) >= a.line,
    );
    if (relocated >= 0) a.line += finding.evidence[relocated]!.startLine - claimed[relocated]!;
  }
  const change = changes.find((f) => (a.revision === 'base' ? (f.previousPath ?? f.path) : f.path) === a.path);
  if (!change?.patch || change.anchorable === false || !changedLines(change.patch, a.revision).has(a.line))
    return { valid: false, code: 'FINDING_ANCHOR_NOT_CHANGED' };
  if (!finding.evidence.some(covers)) return { valid: false, code: 'FINDING_ANCHOR_NOT_COVERED' };
  return { valid: true, shift: 0 };
}

export function usageResult(budget: ReviewBudget): ReviewResult['usage'] {
  return {
    steps: budget.steps,
    toolCalls: budget.toolCalls,
    inputTokens: budget.inputTokens,
    outputTokens: budget.outputTokens,
    costUsd: budget.cost,
    costKind: budget.cost === null ? 'unknown' : 'configured-rates',
    durationMs: Date.now() - budget.started,
  };
}
