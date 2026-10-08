/**
 * A fake Coredoc runner API built on the shared contract, for the runner's
 * tests: it parses every request with the schemas the server uses and
 * answers from scripted state.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ClaimRequestSchema,
  type CompleteTurnRequest,
  CompleteTurnRequestSchema,
  EventBatchSchema,
  HeartbeatRequestSchema,
  type ProposeScope,
  ProposeScopeRequestSchema,
  RUNNER_LEASE_HEADER,
  type RunnerEvent,
  type TurnAssignment,
} from '@coredoc/core/agent-runner';

export const WORKSPACE = '6f1c2b0e-8a4d-4c55-9a39-1f4f0c1d2e3a';
export const TOKEN = 'cdt_runner_test';

export function assignment(overrides: Partial<TurnAssignment> = {}): TurnAssignment {
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
      priorSessionSpendUsd: 0,
      maxTurnDurationSeconds: 10_800,
      seeds: [],
    },
    prd: { markdown: '# PROJ-1: Export orders\n\nCustomers need order exports.\n' },
    repositories: [],
    mcp: { token: 'cdt_turn_token', path: `/api/v1/workspaces/${WORKSPACE}/mcp` },
    hasStateArchive: false,
    ...overrides,
  };
}

export class FakeCoredocApi {
  readonly queue: TurnAssignment[] = [];
  readonly events: RunnerEvent[] = [];
  readonly completions: Array<{ turnId: string; body: CompleteTurnRequest }> = [];
  readonly proposals: ProposeScope[] = [];
  /** The archive the server holds for the run; uploads replace it. */
  archive: Buffer | null = null;
  uploads = 0;
  heartbeats = 0;
  claims: unknown[] = [];
  /** What a heartbeat answers: keep going, stop (run became terminal) or a lost lease. */
  heartbeatAnswer: 'continue' | 'stop' | 'lease_lost' = 'continue';
  /** Errors the next proposal gets back, once. */
  proposalErrors: string[] = [];
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
    const raw = Buffer.concat(chunks);
    const isJson = req.headers['content-type'] === 'application/json';
    const body = isJson && raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
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

    const match = path.match(new RegExp(`^${prefix}/turns/([^/]+)/(heartbeat|events|complete|propose-scope|archive)$`));
    if (!match) return reply(404, { message: 'not found' });
    const [, turnId, action] = match;
    if (this.leases.get(turnId!) !== req.headers[RUNNER_LEASE_HEADER]) {
      return reply(409, { code: 'LEASE_LOST', message: 'lease lost' });
    }

    switch (action) {
      case 'heartbeat':
        HeartbeatRequestSchema.parse(body);
        this.heartbeats += 1;
        if (this.heartbeatAnswer === 'lease_lost') return reply(409, { code: 'LEASE_LOST', message: 'lease lost' });
        return reply(200, {
          stop: this.heartbeatAnswer === 'stop',
          leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
        });
      case 'events': {
        const batch = EventBatchSchema.parse(body);
        this.events.push(...batch.events);
        return reply(200, {
          seqs: batch.events.map((_, index) => this.events.length - batch.events.length + index + 1),
          stop: false,
        });
      }
      case 'propose-scope': {
        const proposal = ProposeScopeRequestSchema.parse(body);
        if (this.proposalErrors.length) {
          const errors = this.proposalErrors;
          this.proposalErrors = [];
          return reply(200, { accepted: false, errors, stop: false });
        }
        this.proposals.push(proposal);
        return reply(200, { accepted: true, version: this.proposals.length, stop: false });
      }
      case 'archive':
        if (req.method === 'PUT') {
          this.archive = raw;
          this.uploads += 1;
          return reply(200, { stored: true });
        }
        if (!this.archive) return reply(404, { code: 'ARCHIVE_NOT_FOUND', message: 'none' });
        res.writeHead(200, { 'content-type': 'application/gzip' });
        res.end(this.archive);
        return;
      default:
        this.completions.push({ turnId: turnId!, body: CompleteTurnRequestSchema.parse(body) });
        return reply(200, { completed: true });
    }
  }
}
