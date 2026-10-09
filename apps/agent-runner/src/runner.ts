/**
 * The runner loop: claim a turn, keep its lease alive, let the executor work,
 * and complete the turn — or stop without completing when the server says the
 * run is over or the lease is gone. One turn at a time per process.
 */
import {
  type DeliveryReport,
  type ProposeScopeRequest,
  type ProposeScopeResponse,
  type RepositoryReport,
  type ReportQuestionRequest,
  type ReportQuestionResponse,
  type RequestRepoRequest,
  type RequestRepoResponse,
  RUNNER_PROTOCOL_VERSION,
  type RunnerEvent,
  type RunnerVersions,
  type SubmitResultRequest,
  type SubmitResultResponse,
  type TurnAssignment,
  type TurnOutcome,
} from '@coredoc/core/agent-runner';
import { secretMasker } from './mask-secrets.js';
import { LeaseLostError, type RunnerApiClient, type TurnRef } from './runner-api.js';

export interface TurnIO {
  /** Report events on the run's timeline. */
  emit(events: RunnerEvent[]): Promise<void>;
  /** Aborted when the server answers `stop` or the lease is lost: end the session at once. */
  signal: AbortSignal;
  /** The run-control call; validation errors come back for the agent to fix. */
  proposeScope(proposal: ProposeScopeRequest): Promise<ProposeScopeResponse>;
  /** Implement turns' result; validation errors come back for the agent to fix. */
  submitResult(result: SubmitResultRequest): Promise<SubmitResultResponse>;
  /** `request_repo`; the server appends the repository, parks the request for a person, or rejects it. */
  requestRepo(request: RequestRepoRequest): Promise<RequestRepoResponse>;
  /** Records that this run creates the run branch in a repository; called before its first push there. */
  reserveBranch(repository: string): Promise<void>;
  /** Report an AskUserQuestion call; the server answers by the run's questions policy. */
  reportQuestion(question: ReportQuestionRequest): Promise<ReportQuestionResponse>;
  /** The run's previous state archive; call only when the assignment says one exists. */
  downloadArchive(): Promise<Buffer>;
  uploadArchive(archive: Buffer): Promise<void>;
}

export interface TurnResult {
  /** Spend the SDK reported for this turn; null when unknown. */
  spend: { costUsd: number; sdkTurns?: number } | null;
  /** Defaults to `ended`: the server judges the turn from what it reported. */
  outcome?: TurnOutcome;
  /** Implement turns: what the end of the turn left in each repository. */
  repositories?: RepositoryReport[];
  /** Delivery turns: the pull request opened or reused in each repository. */
  deliveries?: DeliveryReport[];
  /** The agent's final message; the server keeps it as the reason when outcome-less turns fail the run. */
  lastMessage?: string | null;
}

/** What does the work of a turn: the Claude Code executor in production. */
export interface TurnExecutor {
  run(turn: TurnAssignment, io: TurnIO): Promise<TurnResult>;
}

/** The start-up check: versions to log and report, and why the runner cannot work, if it cannot. */
export interface StartupReport {
  versions: RunnerVersions;
  problem: string | null;
}

export type TurnEnd = 'idle' | 'completed' | 'stopped' | 'lease_lost' | 'shutdown';

export interface RunnerOptions {
  api: RunnerApiClient;
  executor: TurnExecutor;
  versions: RunnerVersions;
  /** Every 20 s by default, well inside the 2-minute lease. */
  heartbeatIntervalMs?: number;
  /** Claim every 5 s while idle by default. */
  idlePollMs?: number;
  /**
   * Run before claiming: while it reports a problem the runner claims
   * nothing and checks again after `startupRetryMs`.
   */
  startupCheck?: () => Promise<StartupReport>;
  startupRetryMs?: number;
  /**
   * Credentials the runner holds (the model key, the bot's GitHub token, the
   * runner token): masked, with the turn's MCP token, in everything a turn sends.
   */
  secrets?: string[];
  log?: (message: string) => void;
}

const HEARTBEAT_INTERVAL_MS = 20_000;
const IDLE_POLL_MS = 5_000;
const ERROR_BACKOFF_MS = 30_000;
const STARTUP_RETRY_MS = 60_000;

export class Runner {
  private readonly heartbeatIntervalMs: number;
  private readonly idlePollMs: number;
  private readonly log: (message: string) => void;
  private versions: RunnerVersions;

  constructor(private readonly options: RunnerOptions) {
    this.versions = options.versions;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.idlePollMs = options.idlePollMs ?? IDLE_POLL_MS;
    this.log = options.log ?? (() => undefined);
  }

  /**
   * Claim and run at most one turn. When `shutdown` aborts, the session stops,
   * pushes are skipped and the turn is not completed: its lease expires and
   * the turn is redone.
   */
  async runOnce(shutdown?: AbortSignal): Promise<TurnEnd> {
    const turn = await this.options.api.claim({
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      versions: this.versions,
    });
    if (!turn) return 'idle';
    this.log(
      `claimed ${turn.turn.kind} turn ${turn.turn.ordinal} of ${turn.run.issueKey} (attempt ${turn.turn.attempt})`,
    );
    return this.execute(turn, shutdown);
  }

  /**
   * The start-up check: log the versions and whether the SDK and the plugin
   * are usable. Returns false (claim nothing) while they are not.
   */
  async checkStartup(): Promise<boolean> {
    if (!this.options.startupCheck) return true;
    let report: StartupReport;
    try {
      report = await this.options.startupCheck();
    } catch (error) {
      report = { versions: this.versions, problem: error instanceof Error ? error.message : String(error) };
    }
    this.versions = { ...this.versions, ...report.versions };
    const { runner, sdk, claudeCode, plugin } = this.versions;
    this.log(
      `versions: runner ${runner}, sdk ${sdk ?? '?'}, claude code ${claudeCode ?? '?'}, plugin ${plugin ?? '?'}`,
    );
    if (report.problem) this.log(`start-up check failed; claiming nothing: ${report.problem}`);
    return report.problem === null;
  }

  /** Poll and run turns until `signal` aborts (shutdown). */
  async start(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !(await this.checkStartup())) {
      await sleep(this.options.startupRetryMs ?? STARTUP_RETRY_MS, signal);
    }
    while (!signal.aborted) {
      let end: TurnEnd;
      try {
        end = await this.runOnce(signal);
      } catch (error) {
        this.log(`runner API error: ${error instanceof Error ? error.message : String(error)}`);
        await sleep(ERROR_BACKOFF_MS, signal);
        continue;
      }
      if (end === 'idle') await sleep(this.idlePollMs, signal);
      else this.log(`turn ended: ${end}`);
    }
  }

  private async execute(assignment: TurnAssignment, shutdown?: AbortSignal): Promise<TurnEnd> {
    const ref: TurnRef = { turnId: assignment.turn.id, leaseToken: assignment.lease.token };
    const session = new AbortController();
    let end: TurnEnd | null = null;
    const stop = (reason: TurnEnd) => {
      end ??= reason;
      session.abort();
    };
    const onShutdown = () => stop('shutdown');
    if (shutdown?.aborted) onShutdown();
    shutdown?.addEventListener('abort', onShutdown, { once: true });

    const heartbeat = setInterval(() => {
      this.options.api.heartbeat(ref, this.versions).then(
        (answer) => {
          if (answer.stop) stop('stopped');
        },
        (error: unknown) => {
          if (error instanceof LeaseLostError) stop('lease_lost');
          // A transient failure is retried by the next beat; the lease outlives several misses.
          else this.log(`heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
        },
      );
    }, this.heartbeatIntervalMs);

    const mask = secretMasker([...(this.options.secrets ?? []), assignment.mcp?.token]);
    try {
      const io: TurnIO = {
        signal: session.signal,
        emit: async (events) => {
          if (events.length === 0 || session.signal.aborted) return;
          try {
            const answer = await this.options.api.postEvents(ref, mask(events));
            if (answer.stop) stop('stopped');
          } catch (error) {
            if (error instanceof LeaseLostError) stop('lease_lost');
            else throw error;
          }
        },
        proposeScope: (proposal) => this.options.api.proposeScope(ref, mask(proposal)),
        submitResult: (submitted) => this.options.api.submitResult(ref, mask(submitted)),
        requestRepo: async (requested) => {
          const answer = await this.options.api.requestRepo(ref, mask(requested));
          if (answer.stop) stop('stopped');
          return answer;
        },
        reserveBranch: async (repository) => {
          await this.options.api.reserveBranch(ref, { repository });
        },
        reportQuestion: async (question) => {
          const answer = await this.options.api.reportQuestion(ref, mask(question));
          if (answer.stop) stop('stopped');
          return answer;
        },
        downloadArchive: () => this.options.api.downloadArchive(ref),
        uploadArchive: (archive) => this.options.api.uploadArchive(ref, archive),
      };
      const result = await this.options.executor.run(assignment, io);
      // A stopped delivery turn still completes, so the pull requests it opened are recorded.
      const stoppedDelivery = end === 'stopped' && assignment.turn.kind === 'delivery';
      if (end && !stoppedDelivery) return end;

      await this.options.api.complete(
        ref,
        mask({
          outcome: result.outcome ?? { kind: 'ended' },
          spend: result.spend,
          versions: this.versions,
          ...(result.repositories?.length ? { repositories: result.repositories } : {}),
          ...(result.deliveries?.length ? { deliveries: result.deliveries } : {}),
          ...(result.lastMessage ? { lastMessage: result.lastMessage.slice(0, 2_000) } : {}),
        }),
      );
      return stoppedDelivery ? 'stopped' : 'completed';
    } catch (error) {
      if (error instanceof LeaseLostError) return 'lease_lost';
      if (end) return end;
      throw error;
    } finally {
      clearInterval(heartbeat);
      shutdown?.removeEventListener('abort', onShutdown);
      session.abort();
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
