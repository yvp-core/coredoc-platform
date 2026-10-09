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
    readonly status: number,
    message: string,
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
}

export interface TurnRef {
  turnId: string;
  leaseToken: string;
}

export class RunnerApiClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: RunnerApiOptions) {
    this.base = `${options.baseUrl.replace(/\/+$/, '')}/api/v1/workspaces/${encodeURIComponent(options.workspaceId)}/agent-runner`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** The oldest queued turn, or null when there is none. */
  async claim(request: ClaimRequest): Promise<TurnAssignment | null> {
    const response = await this.post('/claim', request);
    if (response.status === 204) return null;
    return TurnAssignmentSchema.parse(await this.json(response));
  }

  /** Why the runner claims nothing: its start-up check failed. Claims nothing itself. */
  async reportStartupProblem(report: RunnerStartupProblem): Promise<void> {
    const response = await this.post('/startup-check', report);
    RunnerStartupProblemResponseSchema.parse(await this.json(response));
  }

  async heartbeat(turn: TurnRef, versions: RunnerVersions): Promise<HeartbeatResponse> {
    const response = await this.post(`/turns/${turn.turnId}/heartbeat`, { versions }, turn.leaseToken);
    return HeartbeatResponseSchema.parse(await this.json(response));
  }

  async postEvents(turn: TurnRef, events: RunnerEvent[]): Promise<EventBatchResponse> {
    const response = await this.post(`/turns/${turn.turnId}/events`, { events }, turn.leaseToken);
    return EventBatchResponseSchema.parse(await this.json(response));
  }

  async complete(turn: TurnRef, request: CompleteTurnRequest): Promise<void> {
    const response = await this.post(`/turns/${turn.turnId}/complete`, request, turn.leaseToken);
    CompleteTurnResponseSchema.parse(await this.json(response));
  }

  /** `propose_scope`; broken rules come back as `accepted: false` for the agent to fix. */
  async proposeScope(turn: TurnRef, proposal: ProposeScopeRequest): Promise<ProposeScopeResponse> {
    const response = await this.post(`/turns/${turn.turnId}/propose-scope`, proposal, turn.leaseToken);
    return ProposeScopeResponseSchema.parse(await this.json(response));
  }

  /** `submit_result`; broken rules come back as `accepted: false` for the agent to fix. */
  async submitResult(turn: TurnRef, result: SubmitResultRequest): Promise<SubmitResultResponse> {
    const response = await this.post(`/turns/${turn.turnId}/submit-result`, result, turn.leaseToken);
    return SubmitResultResponseSchema.parse(await this.json(response));
  }

  /** `request_repo`: added (clone it), requested (a person decides), or rejected with errors for the agent. */
  async requestRepo(turn: TurnRef, request: RequestRepoRequest): Promise<RequestRepoResponse> {
    const response = await this.post(`/turns/${turn.turnId}/request-repo`, request, turn.leaseToken);
    return RequestRepoResponseSchema.parse(await this.json(response));
  }

  /** Before the first push of the run branch to a repository: records that this run created it. */
  async reserveBranch(turn: TurnRef, request: ReserveBranchRequest): Promise<void> {
    const response = await this.post(`/turns/${turn.turnId}/branches`, request, turn.leaseToken);
    ReserveBranchResponseSchema.parse(await this.json(response));
  }

  /** An AskUserQuestion call: parked for a person, answered at once, or refused. */
  async reportQuestion(turn: TurnRef, question: ReportQuestionRequest): Promise<ReportQuestionResponse> {
    const response = await this.post(`/turns/${turn.turnId}/questions`, question, turn.leaseToken);
    return ReportQuestionResponseSchema.parse(await this.json(response));
  }

  /** The run's previous state archive (gzip tar), fetched with the live lease. */
  async downloadArchive(turn: TurnRef): Promise<Buffer> {
    const response = await this.send('GET', `/turns/${turn.turnId}/archive`, undefined, turn.leaseToken, 600_000);
    return Buffer.from(await response.arrayBuffer());
  }

  async uploadArchive(turn: TurnRef, archive: Buffer): Promise<void> {
    await this.send('PUT', `/turns/${turn.turnId}/archive`, archive, turn.leaseToken, 600_000);
  }

  /** The base URL the runner reaches Coredoc on; the MCP path in an assignment resolves against it. */
  resolve(path: string): string {
    return new URL(path, `${this.options.baseUrl.replace(/\/+$/, '')}/`).toString();
  }

  private post(path: string, body: unknown, leaseToken?: string): Promise<Response> {
    return this.send('POST', path, body, leaseToken);
  }

  private async send(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body: unknown,
    leaseToken?: string,
    timeoutMs = 30_000,
  ): Promise<Response> {
    const binary = Buffer.isBuffer(body);
    const response = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        ...(body === undefined ? {} : { 'content-type': binary ? 'application/octet-stream' : 'application/json' }),
        ...(leaseToken ? { [RUNNER_LEASE_HEADER]: leaseToken } : {}),
      },
      body: body === undefined ? undefined : binary ? new Uint8Array(body) : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return response;

    const parsed = RunnerErrorBodySchema.safeParse(await response.json().catch(() => ({})));
    const error = parsed.success ? parsed.data : {};
    const message = Array.isArray(error.message) ? error.message.join('; ') : (error.message ?? response.statusText);
    if (error.code === RunnerErrorCode.LeaseLost) throw new LeaseLostError();
    if (error.code === RunnerErrorCode.RunnerIncompatible) throw new RunnerIncompatibleError(message);
    throw new RunnerApiError(response.status, `Runner API ${response.status} for ${path}: ${message}`);
  }

  private async json(response: Response): Promise<unknown> {
    return response.json();
  }
}
