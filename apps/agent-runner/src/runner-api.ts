import { setTimeout } from 'node:timers/promises';
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

/** Stop the turn and do not complete it. */
export class LeaseLostError extends Error {
  constructor() {
    super('The turn lease was lost');
    this.name = 'LeaseLostError';
  }
}

export class RunnerIncompatibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerIncompatibleError';
  }
}

export class RunnerApiError extends Error {
  constructor(
    /** 0 when no answer arrived (a network failure or a timeout). */
    readonly status: number,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'RunnerApiError';
  }
}

export interface RunnerApiOptions {
  baseUrl: string;
  workspaceId: string;
  token: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface TurnRef {
  turnId: string;
  leaseToken: string;
  /** Epoch ms. Failed turn requests are retried only until then, and never without it. */
  leaseExpiresAt?: number;
}

/**
 * `idempotent` requests repeat even after an answer that may have been applied (a 500, a dropped
 * connection, a timeout); `unapplied-only` ones only when the server cannot have applied them.
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
    this.sleep = options.sleep ?? setTimeout;
  }

  /** Not retried: the loop polls again. */
  async claim(request: ClaimRequest): Promise<TurnAssignment | null> {
    const response = await this.send('POST', '/claim', request);
    if (response.status === 204) return null;
    return TurnAssignmentSchema.parse(await this.json(response));
  }

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

  /** Each call is a new version, so it is never repeated after a possibly applied answer. */
  async proposeScope(turn: TurnRef, proposal: ProposeScopeRequest): Promise<ProposeScopeResponse> {
    const response = await this.send('POST', `/turns/${turn.turnId}/propose-scope`, proposal, turn, 'unapplied-only');
    return ProposeScopeResponseSchema.parse(await this.json(response));
  }

  /** A repeat replaces the stored result. */
  async submitResult(turn: TurnRef, result: SubmitResultRequest): Promise<SubmitResultResponse> {
    const response = await this.send('POST', `/turns/${turn.turnId}/submit-result`, result, turn, 'idempotent');
    return SubmitResultResponseSchema.parse(await this.json(response));
  }

  async requestRepo(turn: TurnRef, request: RequestRepoRequest): Promise<RequestRepoResponse> {
    const response = await this.send('POST', `/turns/${turn.turnId}/request-repo`, request, turn, 'unapplied-only');
    return RequestRepoResponseSchema.parse(await this.json(response));
  }

  async reserveBranch(turn: TurnRef, request: ReserveBranchRequest): Promise<void> {
    const response = await this.send('POST', `/turns/${turn.turnId}/branches`, request, turn, 'idempotent');
    ReserveBranchResponseSchema.parse(await this.json(response));
  }

  /** Never repeated after an answer that may have parked it: the repeat would be refused as a second question. */
  async reportQuestion(turn: TurnRef, question: ReportQuestionRequest): Promise<ReportQuestionResponse> {
    const response = await this.send('POST', `/turns/${turn.turnId}/questions`, question, turn, 'unapplied-only');
    return ReportQuestionResponseSchema.parse(await this.json(response));
  }

  async downloadArchive(turn: TurnRef): Promise<Buffer> {
    const response = await this.send('GET', `/turns/${turn.turnId}/archive`, undefined, turn, 'idempotent', 600_000);
    return Buffer.from(await response.arrayBuffer());
  }

  /** A repeat replaces the turn's archive; the server deletes the one it replaced. */
  async uploadArchive(turn: TurnRef, archive: Buffer): Promise<void> {
    await this.send('PUT', `/turns/${turn.turnId}/archive`, archive, turn, 'idempotent', 600_000);
  }

  resolve(path: string): string {
    return new URL(path, `${this.options.baseUrl.replace(/\/+$/, '')}/`).toString();
  }

  /** Retries only while the lease, as known when the request began, lasts; refusals are never retried. */
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

function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}
