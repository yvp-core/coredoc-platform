/**
 * The runner loop: claim a turn, keep its lease alive, let the executor work,
 * and complete the turn — or stop without completing when the server says the
 * run is over or the lease is gone. One turn at a time per process.
 */
import {
  RUNNER_PROTOCOL_VERSION,
  type RunnerEvent,
  type RunnerVersions,
  type TurnAssignment,
} from '@coredoc/core/agent-runner';
import { LeaseLostError, type RunnerApiClient, type TurnRef } from './runner-api.js';

export interface TurnIO {
  /** Report events on the run's timeline. */
  emit(events: RunnerEvent[]): Promise<void>;
  /** Aborted when the server answers `stop` or the lease is lost: end the session at once. */
  signal: AbortSignal;
}

export interface TurnResult {
  /** Spend the SDK reported for this turn; null when unknown. */
  spend: { costUsd: number; sdkTurns?: number } | null;
}

/** What does the work of a turn. Ticket 04 adds the Claude Code executor. */
export interface TurnExecutor {
  run(turn: TurnAssignment, io: TurnIO): Promise<TurnResult>;
}

export type TurnEnd = 'idle' | 'completed' | 'stopped' | 'lease_lost';

export interface RunnerOptions {
  api: RunnerApiClient;
  executor: TurnExecutor;
  versions: RunnerVersions;
  /** Spec: every 20 s, well inside the 2-minute lease. */
  heartbeatIntervalMs?: number;
  /** Spec: claim every 5 s while idle. */
  idlePollMs?: number;
  log?: (message: string) => void;
}

const HEARTBEAT_INTERVAL_MS = 20_000;
const IDLE_POLL_MS = 5_000;
const ERROR_BACKOFF_MS = 30_000;

export class Runner {
  private readonly heartbeatIntervalMs: number;
  private readonly idlePollMs: number;
  private readonly log: (message: string) => void;

  constructor(private readonly options: RunnerOptions) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.idlePollMs = options.idlePollMs ?? IDLE_POLL_MS;
    this.log = options.log ?? (() => undefined);
  }

  /** Claim and run at most one turn. */
  async runOnce(): Promise<TurnEnd> {
    const turn = await this.options.api.claim({
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      versions: this.options.versions,
    });
    if (!turn) return 'idle';
    this.log(
      `claimed ${turn.turn.kind} turn ${turn.turn.ordinal} of ${turn.run.issueKey} (attempt ${turn.turn.attempt})`,
    );
    return this.execute(turn);
  }

  /** Poll and run turns until `signal` aborts (shutdown). */
  async start(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let end: TurnEnd;
      try {
        end = await this.runOnce();
      } catch (error) {
        this.log(`runner API error: ${error instanceof Error ? error.message : String(error)}`);
        await sleep(ERROR_BACKOFF_MS, signal);
        continue;
      }
      if (end === 'idle') await sleep(this.idlePollMs, signal);
      else this.log(`turn ended: ${end}`);
    }
  }

  private async execute(assignment: TurnAssignment): Promise<TurnEnd> {
    const ref: TurnRef = { turnId: assignment.turn.id, leaseToken: assignment.lease.token };
    const session = new AbortController();
    let end: TurnEnd | null = null;
    const stop = (reason: TurnEnd) => {
      end ??= reason;
      session.abort();
    };

    const heartbeat = setInterval(() => {
      this.options.api.heartbeat(ref, this.options.versions).then(
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

    try {
      const io: TurnIO = {
        signal: session.signal,
        emit: async (events) => {
          if (events.length === 0 || session.signal.aborted) return;
          try {
            const answer = await this.options.api.postEvents(ref, events);
            if (answer.stop) stop('stopped');
          } catch (error) {
            if (error instanceof LeaseLostError) stop('lease_lost');
            else throw error;
          }
        },
      };
      const result = await this.options.executor.run(assignment, io);
      if (end) return end;

      await this.options.api.complete(ref, {
        outcome: { kind: 'ended' },
        spend: result.spend,
        versions: this.options.versions,
      });
      return 'completed';
    } catch (error) {
      if (error instanceof LeaseLostError) return 'lease_lost';
      if (end) return end;
      throw error;
    } finally {
      clearInterval(heartbeat);
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
