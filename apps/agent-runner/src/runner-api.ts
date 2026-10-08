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
  RUNNER_LEASE_HEADER,
  RunnerErrorBodySchema,
  RunnerErrorCode,
  type RunnerEvent,
  type RunnerVersions,
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

  private async post(path: string, body: unknown, leaseToken?: string): Promise<Response> {
    const response = await this.fetchImpl(`${this.base}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.token}`,
        'content-type': 'application/json',
        ...(leaseToken ? { [RUNNER_LEASE_HEADER]: leaseToken } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
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
