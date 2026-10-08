import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ClaimRequestSchema,
  CompleteTurnRequestSchema,
  EventBatchSchema,
  HeartbeatRequestSchema,
  RUNNER_LEASE_HEADER,
  RUNNER_PROTOCOL_VERSION,
  type RunnerEvent,
  type TurnAssignment,
} from '@coredoc/core/agent-runner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunnerApiClient } from './runner-api.js';
import { Runner, type TurnExecutor } from './runner.js';

const WORKSPACE = '6f1c2b0e-8a4d-4c55-9a39-1f4f0c1d2e3a';
const TOKEN = 'cdt_runner_test';
const VERSIONS = { runner: '1.1.0-test' };

function assignment(): TurnAssignment {
  return {
    turn: { id: randomUUID(), kind: 'scope', ordinal: 1, attempt: 1, inputText: null },
    lease: { token: randomUUID(), expiresAt: new Date(Date.now() + 120_000).toISOString() },
    run: {
      id: randomUUID(),
      issueKey: 'PROJ-1',
      questionsPolicy: 'pause',
      scopeAcceptancePolicy: 'required',
      model: null,
      sessionId: randomUUID(),
      remainingSpendUsd: 25,
      maxTurnDurationSeconds: 10_800,
    },
  };
}

/**
 * A fake Coredoc runner API built on the shared contract: it parses every
 * request with the same schemas the server uses, and answers from scripted
 * state.
 */
class FakeCoredocApi {
  readonly queue: TurnAssignment[] = [];
  readonly events: RunnerEvent[] = [];
  readonly completions: Array<{ turnId: string; body: unknown }> = [];
  heartbeats = 0;
  claims: unknown[] = [];
  /** What a heartbeat answers: keep going, stop (run became terminal) or a lost lease. */
  heartbeatAnswer: 'continue' | 'stop' | 'lease_lost' = 'continue';
  private readonly leases = new Map<string, string>();
  private server!: Server;
  baseUrl = '';

  async listen(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    const reply = (status: number, payload?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(payload === undefined ? undefined : JSON.stringify(payload));
    };

    if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { message: 'unauthorized' });
    const prefix = `/api/v1/workspaces/${WORKSPACE}/agent-runner`;
    const path = req.url ?? '';

    if (path === `${prefix}/claim`) {
      this.claims.push(ClaimRequestSchema.parse(body));
      const next = this.queue.shift();
      if (!next) return reply(204);
      this.leases.set(next.turn.id, next.lease.token);
      return reply(200, next);
    }

    const match = path.match(new RegExp(`^${prefix}/turns/([^/]+)/(heartbeat|events|complete)$`));
    if (!match) return reply(404, { message: 'not found' });
    const [, turnId, action] = match;
    if (this.leases.get(turnId!) !== req.headers[RUNNER_LEASE_HEADER]) {
      return reply(409, { code: 'LEASE_LOST', message: 'lease lost' });
    }

    if (action === 'heartbeat') {
      HeartbeatRequestSchema.parse(body);
      this.heartbeats += 1;
      if (this.heartbeatAnswer === 'lease_lost') return reply(409, { code: 'LEASE_LOST', message: 'lease lost' });
      return reply(200, {
        stop: this.heartbeatAnswer === 'stop',
        leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      });
    }
    if (action === 'events') {
      const batch = EventBatchSchema.parse(body);
      this.events.push(...batch.events);
      return reply(200, {
        seqs: batch.events.map((_, index) => this.events.length - batch.events.length + index + 1),
        stop: false,
      });
    }
    this.completions.push({ turnId: turnId!, body: CompleteTurnRequestSchema.parse(body) });
    return reply(200, { completed: true });
  }
}

/** An executor that keeps the turn busy until the runner aborts it or `release` is called. */
function blockingExecutor(): TurnExecutor & { release: () => void; aborted: boolean } {
  let release = (): void => undefined;
  const executor = {
    aborted: false,
    release: () => release(),
    async run(_turn: TurnAssignment, io: Parameters<TurnExecutor['run']>[1]) {
      await io.emit([{ type: 'phase', phase: 'scoping' }]);
      await new Promise<void>((resolve) => {
        release = resolve;
        io.signal.addEventListener('abort', () => {
          executor.aborted = true;
          resolve();
        });
      });
      return { spend: null };
    },
  };
  return executor;
}

describe('runner loop', () => {
  let api: FakeCoredocApi;

  beforeEach(async () => {
    api = new FakeCoredocApi();
    await api.listen();
  });

  afterEach(async () => {
    await api.close();
  });

  function runner(executor: TurnExecutor, heartbeatIntervalMs = 5) {
    return new Runner({
      api: new RunnerApiClient({ baseUrl: api.baseUrl, workspaceId: WORKSPACE, token: TOKEN }),
      executor,
      versions: VERSIONS,
      heartbeatIntervalMs,
      idlePollMs: 5,
    });
  }

  it('reports idle when no turn is queued, sending its protocol and versions', async () => {
    await expect(runner(blockingExecutor()).runOnce()).resolves.toBe('idle');
    expect(api.claims).toEqual([{ protocolVersion: RUNNER_PROTOCOL_VERSION, versions: VERSIONS }]);
  });

  it('claims a turn, heartbeats, posts the executor’s events and completes it', async () => {
    const turn = assignment();
    api.queue.push(turn);
    const executor = blockingExecutor();
    const done = runner(executor).runOnce();
    await waitFor(() => api.heartbeats >= 2);
    executor.release();

    await expect(done).resolves.toBe('completed');
    expect(api.events).toEqual([{ type: 'phase', phase: 'scoping' }]);
    expect(api.completions).toEqual([
      { turnId: turn.turn.id, body: { outcome: { kind: 'ended' }, spend: null, versions: VERSIONS } },
    ]);
  });

  it('a stop heartbeat ends the session and does not complete the turn', async () => {
    api.queue.push(assignment());
    api.heartbeatAnswer = 'stop';
    const executor = blockingExecutor();

    await expect(runner(executor).runOnce()).resolves.toBe('stopped');
    expect(executor.aborted).toBe(true);
    expect(api.completions).toEqual([]);
  });

  it('a lost lease stops the turn without completing it', async () => {
    api.queue.push(assignment());
    api.heartbeatAnswer = 'lease_lost';
    const executor = blockingExecutor();

    await expect(runner(executor).runOnce()).resolves.toBe('lease_lost');
    expect(executor.aborted).toBe(true);
    expect(api.completions).toEqual([]);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
