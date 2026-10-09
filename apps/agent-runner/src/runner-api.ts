/**
 * The runner's side of the runner API. Every response is parsed with the
 * shared contract, so a server that drifted fails loudly here.
 */
import {
  type ClaimRequest,
  type CompleteTurnRequest,
  CompleteTurnResponseSchema,
  type EventBatchResponse,
  EventBatchResponseSchema,
  type HeartbeatResponse,
  HeartbeatResponseSchema,
  type ProposeScopeRequest,
  type ProposeScopeResponse,
  ProposeScopeResponseSchema,
  type ReserveBranchRequest,
  ReserveBranchResponseSchema,
  type ReportQuestionRequest,
  type ReportQuestionResponse,
  ReportQuestionResponseSchema,
  type RequestRepoRequest,
  type RequestRepoResponse,
  RequestRepoResponseSchema,
  RUNNER_LEASE_HEADER,
  RunnerErrorBodySchema,
  RunnerErrorCode,
  type RunnerEvent,
  type RunnerStartupProblem,
  RunnerStartupProblemResponseSchema,
  type RunnerVersions,
  type SubmitResultRequest,
  type SubmitResultResponse,
  SubmitResultResponseSchema,
  type TurnAssignment,
  TurnAssignmentSchema,
} from '@coredoc/core/agent-runner';

/** The lease is not this runner's any more: stop the turn and do not complete it. */
export class LeaseLostError extends Error {
  constructor() {
    super('The turn lease was lost');
    this.name = 'LeaseLostError';
  }
}

/** The server refused this runner's protocol version; an upgrade is needed. */
export class RunnerIncompatibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerIncompatibleError';
  }
}

export class RunnerApiError extends Error {
  constructor(
    /** The HTTP status; 0 when no answer arrived (a network failure or a timeout). */
    readonly status: number,
    message: string,
    /** The wait the server asked for with Retry-After, in milliseconds. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'RunnerApiError';
  }
}

export interface RunnerApiOptions {
  /** The Coredoc server origin, e.g. `http://coredoc:3000`. */
  baseUrl: string;
  workspaceId: string;
  /** The workspace's runner token (`cdt_…`, agent-runner scope). */
  token: string;
  fetchImpl?: typeof fetch;
  /** Injectable for tests: the clock retries are bounded by, and how the client waits between attempts. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface TurnRef {
  turnId: string;
  leaseToken: string;
  /**
   * When the lease expires (epoch ms), as the last claim or heartbeat said.
   * Failed turn requests are retried only while it lasts; without it they
   * are not retried.
   */
  leaseExpiresAt?: number;
}

/**
 * How a turn request may be retried. `idempotent` requests repeat safely
 * after an answer that may have been applied (a 500, a dropped connection, a
 * timeout); the others repeat only when the server cannot have applied them
 * (a 429, or a 502/503/504 from whatever fronts it).
 */
type Retry = 'idempotent' | 'unapplied-only' | 'never';

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_WAIT_MS = 30_000;
/** Statuses the server answers before handling the request: the rate limit and whatever fronts it. */
const UNAPPLIED_STATUSES = new Set([429, 502, 503, 504]);

export class RunnerApiClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: RunnerApiOptions) {
    this.base = `${options.baseUrl.replace(/\/+$/, '')}/api/v1/workspaces/${encodeURIComponent(options.workspaceId)}/agent-runner`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** The oldest queued turn, or null when there is none. Not retried: the loop polls again. */
  async claim(request: ClaimRequest): Promise<TurnAssignment | null> {
    const response = await this.send('POST', '/claim', request);
    if (response.status === 204) return null;
    return TurnAssignmentSchema.parse(await this.json(response));
  }

  /** Why the runner claims nothing: its start-up check failed. Claims nothing itself. */
  async reportStartupProblem(report: RunnerStartupProblem): Promise<void> {
    const response = await this.send('POST', '/startup-check', report);
    RunnerStartupProblemResponseSchema.parse(await this.json(response));
  }

  /** Not retried: the next beat, 20 s later, is the retry. */
  async heartbeat(turn: TurnRef, versions: RunnerVersions): Promise<HeartbeatResponse> {
    const response = await this.send('POST', `/turns/${turn.turnId}/heartbeat`, { versions }, turn, 'never');
    return HeartbeatResponseSchema.parse(await this.json(response));
  }

  /** Retried after an ambiguous failure too: a batch shown twice beats a turn lost to a blip. */
  async postEvents(turn: TurnRef, events: RunnerEvent[]): Promise<EventBatchResponse> {
    const response = await this.send('POST', `/turns/${turn.turnId}/events`, { events }, turn, 'idempotent');
    return EventBatchResponseSchema.parse(await this.json(response));
  }

  /** A repeated completion of a completed turn is a no-op on the server. */
  async complete(turn: TurnRef, request: CompleteTurnRequest): Promise<void> {
    const response = await this.send('POST', `/turns/${turn.turnId}/complete`, request, turn, 'idempotent');
    CompleteTurnResponseSchema.parse(await this.json(response));
  }

  /** `propose_scope`; broken rules come back as `accepted: false` for the agent to fix. Each call is a new version. */
  async proposeScope(turn: TurnRef, proposal: ProposeScopeRequest): Promise<ProposeScopeResponse> {
    const response = await this.send('POST', `/turns/${turn.turnId}/propose-scope`, proposal, turn, 'unapplied-only');
    return ProposeScopeResponseSchema.parse(await this.json(response));
  }

  /** `submit_result`; broken rules come back as `accepted: false` for the agent to fix. A repeat replaces it. */
  async submitResult(turn: TurnRef, result: SubmitResultRequest): Promise<SubmitResultResponse> {
    const response = await this.send('POST', `/turns/${turn.turnId}/submit-result`, result, turn, 'idempotent');
    return SubmitResultResponseSchema.parse(await this.json(response));
  }

  /** `request_repo`: added (clone it), requested (a person decides), or rejected with errors for the agent. */
  async requestRepo(turn: TurnRef, request: RequestRepoRequest): Promise<RequestRepoResponse> {
    const response = await this.send('POST', `/turns/${turn.turnId}/request-repo`, request, turn, 'unapplied-only');
    return RequestRepoResponseSchema.parse(await this.json(response));
  }

  /** Before the first push of the run branch to a repository: records that this run created it. */
  async reserveBranch(turn: TurnRef, request: ReserveBranchRequest): Promise<void> {
    const response = await this.send('POST', `/turns/${turn.turnId}/branches`, request, turn, 'idempotent');
    ReserveBranchResponseSchema.parse(await this.json(response));
  }

  /**
   * An AskUserQuestion call: parked for a person, answered at once, or
   * refused. Never repeated after an answer that may have parked it: the
   * repeat would be refused as a second question.
   */
  async reportQuestion(turn: TurnRef, question: ReportQuestionRequest): Promise<ReportQuestionResponse> {
    const response = await this.send('POST', `/turns/${turn.turnId}/questions`, question, turn, 'unapplied-only');
    return ReportQuestionResponseSchema.parse(await this.json(response));
  }

  /** The run's previous state archive (gzip tar), fetched with the live lease. */
  async downloadArchive(turn: TurnRef): Promise<Buffer> {
    const response = await this.send('GET', `/turns/${turn.turnId}/archive`, undefined, turn, 'idempotent', 600_000);
    return Buffer.from(await response.arrayBuffer());
  }

  /** A repeat replaces the turn's archive; the server deletes the one it replaced. */
  async uploadArchive(turn: TurnRef, archive: Buffer): Promise<void> {
    await this.send('PUT', `/turns/${turn.turnId}/archive`, archive, turn, 'idempotent', 600_000);
  }

  /** The base URL the runner reaches Coredoc on; the MCP path in an assignment resolves against it. */
  resolve(path: string): string {
    return new URL(path, `${this.options.baseUrl.replace(/\/+$/, '')}/`).toString();
  }

  /**
   * One request, retried with backoff (or the server's Retry-After) while
   * the turn's lease, as known when the request began, lasts. `LEASE_LOST`
   * and other refusals are never retried.
   */
  private async send(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body: unknown,
    turn?: TurnRef,
    retry: Retry = 'never',
    timeoutMs = 30_000,
  ): Promise<Response> {
    const deadline = retry === 'never' ? undefined : turn?.leaseExpiresAt;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.attempt(method, path, body, turn?.leaseToken, timeoutMs);
      } catch (error) {
        if (!(error instanceof RunnerApiError) || deadline === undefined) throw error;
        const unapplied = UNAPPLIED_STATUSES.has(error.status);
        const transient = unapplied || error.status === 0 || error.status === 500;
        if (!transient || (retry === 'unapplied-only' && !unapplied)) throw error;
        const wait = Math.min(error.retryAfterMs ?? RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_WAIT_MS);
        if (this.now() + wait >= deadline) throw error;
        await this.sleep(wait);
      }
    }
  }

  private async attempt(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body: unknown,
    leaseToken: string | undefined,
    timeoutMs: number,
  ): Promise<Response> {
    const binary = Buffer.isBuffer(body);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          ...(body === undefined ? {} : { 'content-type': binary ? 'application/octet-stream' : 'application/json' }),
          ...(leaseToken ? { [RUNNER_LEASE_HEADER]: leaseToken } : {}),
        },
        body: body === undefined ? undefined : binary ? new Uint8Array(body) : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // A network failure or a timeout: whether the server applied the request is unknown.
      const reason =
        error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
      throw new RunnerApiError(0, `Runner API request failed for ${path}: ${reason}`);
    }
    if (response.ok) return response;

    const parsed = RunnerErrorBodySchema.safeParse(await response.json().catch(() => ({})));
    const error = parsed.success ? parsed.data : {};
    const message = Array.isArray(error.message) ? error.message.join('; ') : (error.message ?? response.statusText);
    if (error.code === RunnerErrorCode.LeaseLost) throw new LeaseLostError();
    if (error.code === RunnerErrorCode.RunnerIncompatible) throw new RunnerIncompatibleError(message);
    throw new RunnerApiError(
      response.status,
      `Runner API ${response.status} for ${path}: ${message}`,
      retryAfterMs(response.headers.get('retry-after'), this.now()),
    );
  }

  private async json(response: Response): Promise<unknown> {
    return response.json();
  }
}

/** Retry-After as delay seconds or an HTTP date, in milliseconds; null when absent or unreadable. */
function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}
