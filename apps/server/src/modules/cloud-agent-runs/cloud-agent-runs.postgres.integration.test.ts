import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import * as tar from 'tar';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RUNNER_LEASE_HEADER, RUNNER_PROTOCOL_VERSION } from '@coredoc/core/agent-runner';
import { AuthService } from '../../auth/auth.service.js';
import { TokenPermission } from '../../auth/token-permissions.js';
import { STORAGE_CONFIG, storageConfigFromEnv } from '../../config/app-config.js';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import { encrypt } from '../../database/encryption.js';
import { PrismaService } from '../../database/prisma.service.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { McpRewriteMiddleware } from '../../mcp/mcp-rewrite.middleware.js';
import { ReposController } from '../repos/repos.controller.js';
import { ReposService } from '../repos/repos.service.js';
import { TokensController } from '../tokens/tokens.controller.js';
import { TokensService } from '../tokens/tokens.service.js';
import { JIRA_CLIENT_FACTORY } from '../delivery/jira-importer.service.js';
import { CLOUD_AGENT_RUN_ARCHIVE_STORE } from './cloud-agent-run-archive.store.js';
import { CloudAgentRunnerController } from './cloud-agent-runner.controller.js';
import { CloudAgentRunsController } from './cloud-agent-runs.controller.js';
import { cloudAgentRunsCoreProviders, CLOUD_AGENT_RUNS_CLOCK } from './cloud-agent-runs.module.js';
import { FakeJira, InMemoryArchiveStore, paragraphDoc } from './cloud-agent-runs.test-support.js';
import { MAX_TRANSCRIPT_BYTES } from './run-transcript.js';

/**
 * The cloud agent runs module driven through its two HTTP surfaces on real
 * PostgreSQL, with every guard REAL — AuthGuard included. Runner tokens are
 * minted through the real token API and presented as bearer tokens; only the
 * human JWT verification is stubbed (`Bearer jwt:<userId>`), because this
 * process has no token issuer. The runner is a scripted fake making runner
 * API calls; time comes from an injected clock.
 */
const TEST_DATABASE_URL = process.env.CLOUD_AGENT_RUNS_TEST_DATABASE_URL ?? '';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;

const ADMIN = { id: `${RUN}-admin`, email: 'admin@example.com' };
const MEMBER = { id: `${RUN}-member`, email: 'member@example.com' };
const DEMOTED = { id: `${RUN}-demoted`, email: 'demoted@example.com' };
const VERSIONS = { runner: '0.0.1-test', sdk: '0.3.285', claudeCode: '2.1.285', plugin: 'abc123' };

const jira = new FakeJira();
let issueSeed = 0;
/** A fresh issue the fake Jira can read, in the connector's configured project. */
function nextIssueKey(): string {
  issueSeed += 1;
  const key = `PROJ-${issueSeed}`;
  jira.add({ key, summary: `Issue ${issueSeed}`, project: 'PROJ', description: paragraphDoc('A PRD.') });
  return key;
}

/** Reads a download whole, whatever its content type. */
function binaryBody(res: IncomingMessage, callback: (error: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

describe.skipIf(!TEST_DATABASE_URL)('cloud agent runs (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let previousDatabaseUrl: string | undefined;
  let previousEncryptionKey: string | undefined;
  let app: INestApplication;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let now = new Date('2026-10-10T09:00:00.000Z');

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    previousEncryptionKey = process.env.SERVER_ENCRYPTION_KEY;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.SERVER_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    pool = buildPrismaAdapter();
    prisma = new PrismaClient({ adapter: pool?.adapter } as never);
    await prisma.$connect();

    // Available for agent runs: Delivery analytics with active Jira (project PROJ) and GitHub connectors.
    const workspace = await prisma.workspace.create({
      data: { name: `car-${RUN}`, slug: `car-${RUN}`, deliveryEnabled: true },
    });
    workspaceId = workspace.id;
    await prisma.deliveryConnector.createMany({
      data: [
        {
          workspaceId,
          provider: 'jira',
          displayName: 'Jira',
          baseUrl: 'https://example.atlassian.net',
          credentialsEncrypted: encrypt(JSON.stringify({ email: 'bot@example.com', apiToken: 'jira-token' })),
          config: { projects: ['PROJ'] },
        },
        { workspaceId, provider: 'github', displayName: 'GitHub', credentialsEncrypted: encrypt('github-token') },
      ],
    });
    const other = await prisma.workspace.create({ data: { name: `car-other-${RUN}`, slug: `car-other-${RUN}` } });
    otherWorkspaceId = other.id;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId, userId: ADMIN.id, email: ADMIN.email, role: 'admin' },
        { workspaceId, userId: MEMBER.id, email: MEMBER.email, role: 'member' },
        { workspaceId, userId: DEMOTED.id, email: DEMOTED.email, role: 'admin' },
        { workspaceId: otherWorkspaceId, userId: ADMIN.id, email: ADMIN.email, role: 'admin' },
      ],
    });
    const users = new Map([ADMIN, MEMBER, DEMOTED].map((user) => [user.id, user]));
    const storage = storageConfigFromEnv();
    const moduleRef = await Test.createTestingModule({
      // ReposController stands in for an existing permission-less member route; only its guards matter.
      controllers: [CloudAgentRunsController, CloudAgentRunnerController, TokensController, ReposController],
      providers: [
        { provide: PrismaService, useValue: prisma as unknown as PrismaService },
        { provide: ReposService, useValue: { listRepos: async () => [] } },
        ControlPlaneService,
        TokensService,
        ...cloudAgentRunsCoreProviders,
        { provide: CLOUD_AGENT_RUNS_CLOCK, useValue: () => now },
        { provide: JIRA_CLIENT_FACTORY, useValue: () => jira.client() },
        { provide: CLOUD_AGENT_RUN_ARCHIVE_STORE, useValue: new InMemoryArchiveStore() },
        { provide: STORAGE_CONFIG, useValue: { ...storage, r2: { ...storage.r2, endpoint: 'https://r2.example' } } },
        {
          provide: AuthService,
          useValue: {
            async verifyAccessToken(token: string) {
              const user = users.get(token.replace(/^jwt:/, ''));
              if (!user) throw new Error('unknown test user');
              return user;
            },
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
    // State archives are uploaded as raw bodies, as in production (body-limits.ts).
    (app as NestExpressApplication).useBodyParser('raw', { type: 'application/octet-stream' });
    // The real MCP authentication in front of a stub transport that answers once a request is let through.
    const mcp = new McpRewriteMiddleware(moduleRef.get(AuthService), moduleRef.get(ControlPlaneService));
    app.use((req: Request, res: Response, next: NextFunction) => void mcp.use(req, res, next));
    app.use('/mcp', (_req: Request, res: Response) => res.status(200).json({ reached: true }));
    app.setGlobalPrefix('api/v1');
    await app.init();
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    for (const id of [workspaceId, otherWorkspaceId]) {
      if (id) await prisma.workspace.delete({ where: { id } }).catch(() => undefined);
    }
    await prisma.$disconnect();
    if (pool?.pool) await pool.pool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousEncryptionKey === undefined) delete process.env.SERVER_ENCRYPTION_KEY;
    else process.env.SERVER_ENCRYPTION_KEY = previousEncryptionKey;
  });

  const api = () => request(app.getHttpServer());
  const human = (user: { id: string }) => `Bearer jwt:${user.id}`;
  const runsBase = (ws = workspaceId) => `/api/v1/workspaces/${ws}/cloud-agent-runs`;
  const runnerBase = (ws = workspaceId) => `/api/v1/workspaces/${ws}/agent-runner`;

  async function mintRunnerToken(name: string, admin = ADMIN): Promise<string> {
    const res = await api()
      .post(`/api/v1/workspaces/${workspaceId}/tokens`)
      .set('Authorization', human(admin))
      .send({ name, scope: 'agent-runner' })
      .expect(201);
    return res.body.token as string;
  }

  /** A token row written directly, for credentials the token API (rightly) never mints. */
  async function insertToken(ws: string, permissions: string[], createdBy = ADMIN.id): Promise<string> {
    const plaintext = `cdt_${randomBytes(32).toString('hex')}`;
    await prisma.serviceToken.create({
      data: {
        workspaceId: ws,
        name: `direct-${randomBytes(4).toString('hex')}`,
        tokenHash: createHash('sha256').update(plaintext).digest('hex'),
        permissions,
        createdBy,
      },
    });
    return plaintext;
  }

  /** Runs never finish in this suite, so the concurrency limit is set high enough that every start starts. */
  async function enable(): Promise<void> {
    await api()
      .put(`${runsBase()}/settings`)
      .set('Authorization', human(ADMIN))
      .send({ enabled: true, maxStartedRuns: 50 })
      .expect(200);
  }

  function start(issueKey: string, user = MEMBER) {
    return api().post(runsBase()).set('Authorization', human(user)).send({ issueKey });
  }

  function claim(token: string, protocolVersion = RUNNER_PROTOCOL_VERSION) {
    return api()
      .post(`${runnerBase()}/claim`)
      .set('Authorization', `Bearer ${token}`)
      .send({ protocolVersion, versions: VERSIONS });
  }

  function turnCall(token: string, turnId: string, lease: string, path: string, body: unknown) {
    return api()
      .post(`${runnerBase()}/turns/${turnId}/${path}`)
      .set('Authorization', `Bearer ${token}`)
      .set(RUNNER_LEASE_HEADER, lease)
      .send(body as object);
  }

  async function settingsTokens(): Promise<Array<Record<string, unknown>>> {
    const settings = await api().get(`${runsBase()}/settings`).set('Authorization', human(ADMIN)).expect(200);
    return settings.body.runnerTokens;
  }

  /** Claim until the runner gets nothing, so each scenario starts with an empty queue. */
  async function drainQueue(token: string): Promise<void> {
    for (;;) {
      const res = await claim(token);
      if (res.status === 204) return;
      expect(res.status).toBe(200);
      await turnCall(token, res.body.turn.id, res.body.lease.token, 'complete', {
        outcome: { kind: 'ended' },
        spend: null,
        versions: VERSIONS,
      }).expect(200);
    }
  }

  it('an admin enables agent runs as run owner and mints a runner token the settings list', async () => {
    await api().put(`${runsBase()}/settings`).set('Authorization', human(MEMBER)).send({ enabled: true }).expect(403);
    await enable();
    await mintRunnerToken('runner-settings');

    const settings = await api().get(`${runsBase()}/settings`).set('Authorization', human(MEMBER)).expect(200);
    expect(settings.body).toMatchObject({
      enabled: true,
      runOwner: { userId: ADMIN.id, email: ADMIN.email, valid: true },
    });
    expect(settings.body.runnerTokens).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'runner-settings', lastSeenAt: null, refusal: null })]),
    );
  });

  it('a member start queues a scope turn; a second start for the same issue is refused', async () => {
    await enable();
    const issueKey = nextIssueKey();

    const started = await start(issueKey).expect(201);
    expect(started.body).toMatchObject({
      issueKey,
      issueUrl: `https://example.atlassian.net/browse/${issueKey}`,
      trigger: 'manual',
      runOwner: { userId: MEMBER.id },
      currentTurn: { kind: 'scope', state: 'queued', attempt: 0 },
    });

    const again = await start(issueKey).expect(409);
    expect(again.body.code).toBe('ACTIVE_RUN_EXISTS');

    const listed = await api().get(runsBase()).set('Authorization', human(MEMBER)).expect(200);
    expect(listed.body.runs.filter((run: { issueKey: string }) => run.issueKey === issueKey)).toHaveLength(1);
  });

  it('concurrent starts for one issue create exactly one run', async () => {
    await enable();
    const issueKey = nextIssueKey();
    const results = await Promise.all([start(issueKey), start(issueKey), start(issueKey)]);
    expect(results.map((res) => res.status).sort()).toEqual([201, 409, 409]);
  });

  it('a runner claims, heartbeats, reports events and completes; the run page shows them in order', async () => {
    await enable();
    const token = await mintRunnerToken('runner-e2e');
    await drainQueue(token);
    const { body: run } = await start(nextIssueKey()).expect(201);

    const claimed = await claim(token).expect(200);
    expect(claimed.body).toMatchObject({
      turn: { kind: 'scope', ordinal: 1, attempt: 1, inputText: null },
      run: { id: run.id, issueKey: run.issueKey, questionsPolicy: 'pause', scopeAcceptancePolicy: 'required' },
    });
    const turnId = claimed.body.turn.id as string;
    const lease = claimed.body.lease.token as string;

    const beat = await turnCall(token, turnId, lease, 'heartbeat', { versions: VERSIONS }).expect(200);
    expect(beat.body.stop).toBe(false);

    const reported = await turnCall(token, turnId, lease, 'events', {
      events: [
        { type: 'phase', phase: 'scoping' },
        { type: 'raw', text: '[init] model=default' },
      ],
    }).expect(200);
    expect(reported.body.stop).toBe(false);

    const completion = { outcome: { kind: 'ended' }, spend: { costUsd: 0.25, sdkTurns: 3 }, versions: VERSIONS };
    await turnCall(token, turnId, lease, 'complete', completion).expect(200);
    // A repeated completion of a completed turn is a no-op, not a second spend.
    await turnCall(token, turnId, lease, 'complete', completion).expect(200);

    const detail = await api().get(`${runsBase()}/${run.id}`).set('Authorization', human(MEMBER)).expect(200);
    // The turn ended without an outcome, so the nudge turn is queued.
    expect(detail.body).toMatchObject({
      status: 'scoping',
      spend: { usd: 0.25, unknownTurns: 0 },
      currentTurn: { kind: 'scope', ordinal: 2, state: 'queued' },
    });

    const timeline = await api()
      .get(`${runsBase()}/${run.id}/events?after=0`)
      .set('Authorization', human(MEMBER))
      .expect(200);
    const events = timeline.body.events as Array<{ seq: number; type: string; payload: Record<string, unknown> }>;
    expect(events.map((event) => event.type)).toEqual([
      'status_changed',
      'status_changed',
      'turn_started',
      'phase',
      'raw',
      'turn_ended',
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events[1]?.payload).toMatchObject({ from: 'queued', to: 'scoping' });

    const page = await api()
      .get(`${runsBase()}/${run.id}/events?after=4`)
      .set('Authorization', human(MEMBER))
      .expect(200);
    expect(page.body.events.map((event: { seq: number }) => event.seq)).toEqual([5, 6]);

    const settings = await api().get(`${runsBase()}/settings`).set('Authorization', human(ADMIN)).expect(200);
    expect(settings.body.runnerTokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'runner-e2e',
          lastSeenAt: now.toISOString(),
          lastAction: 'heartbeat',
          versions: VERSIONS,
          refusal: null,
        }),
      ]),
    );
  });

  it('two runners claiming at once get different turns, and a third finds nothing', async () => {
    await enable();
    const first = await mintRunnerToken('runner-a');
    const second = await mintRunnerToken('runner-b');
    await drainQueue(first);
    await start(nextIssueKey()).expect(201);
    await start(nextIssueKey()).expect(201);

    const [a, b] = await Promise.all([claim(first), claim(second)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.turn.id).not.toBe(b.body.turn.id);
    await claim(first).expect(204);
  });

  it('a stale lease gets LEASE_LOST', async () => {
    await enable();
    const token = await mintRunnerToken('runner-stale');
    await drainQueue(token);
    await start(nextIssueKey()).expect(201);
    const claimed = await claim(token).expect(200);
    const turnId = claimed.body.turn.id as string;

    const wrongLease = await turnCall(token, turnId, '00000000-0000-4000-8000-000000000000', 'heartbeat', {
      versions: VERSIONS,
    }).expect(409);
    expect(wrongLease.body.code).toBe('LEASE_LOST');

    now = new Date(now.getTime() + 3 * 60_000);
    const expired = await turnCall(token, turnId, claimed.body.lease.token, 'events', {
      events: [{ type: 'raw', text: 'late' }],
    }).expect(409);
    expect(expired.body.code).toBe('LEASE_LOST');
  });

  it('refuses a runner on an unsupported protocol version, and settings say why', async () => {
    await enable();
    const token = await mintRunnerToken('runner-old');
    const refused = await claim(token, 999).expect(409);
    expect(refused.body.code).toBe('RUNNER_INCOMPATIBLE');

    const settings = await api().get(`${runsBase()}/settings`).set('Authorization', human(ADMIN)).expect(200);
    expect(settings.body.runnerTokens).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'runner-old', refusal: 'runner_incompatible' })]),
    );
  });

  it('a runner whose start-up check fails reports a code, settings word it, and its next claim clears it', async () => {
    await enable();
    const token = await mintRunnerToken('runner-startup');
    const tokenRow = () => settingsTokens().then((tokens) => tokens.find((row) => row.name === 'runner-startup'));
    const report = (body: Record<string, unknown>, auth = `Bearer ${token}`) =>
      api()
        .post(`${runnerBase()}/startup-check`)
        .set('Authorization', auth)
        .send({ protocolVersion: RUNNER_PROTOCOL_VERSION, versions: VERSIONS, ...body });

    await report({ code: 'bot_admin', detail: 'acme/orders' }).expect(200, { recorded: true });
    expect(await tokenRow()).toMatchObject({
      lastSeenAt: now.toISOString(),
      lastAction: 'startup_check',
      versions: VERSIONS,
      refusal: 'startup_check_failed',
      refusalDetail:
        'The bot account has admin or maintain permission on a repository it can see; give it the Write role only. (acme/orders)',
    });

    // Credentials a detail carries are masked before they are stored.
    const githubToken = `ghp_${'a1B2'.repeat(9)}`;
    const modelKey = `sk-ant-api03-${'Zy9x'.repeat(6)}`;
    await report({
      code: 'sdk_unusable',
      detail: `spawn failed with ${githubToken} and ${modelKey} via https://bot:hunter2@proxy.example.com/`,
    }).expect(200);
    const masked = (await tokenRow())!.refusalDetail as string;
    expect(masked).toBe(
      'The Agent SDK could not start Claude Code in the runner image. (spawn failed with [REDACTED] and [REDACTED] via https://[REDACTED]@proxy.example.com/)',
    );

    // A code outside the contract is refused; so are humans and unsupported protocol versions.
    await report({ code: 'something_else' }).expect(400);
    await report({ problem: 'free text' }).expect(400);
    await report({ code: 'plugin_errors' }, human(ADMIN)).expect(403);
    const old = await report({ code: 'plugin_errors', protocolVersion: 999 }).expect(409);
    expect(old.body.code).toBe('RUNNER_INCOMPATIBLE');

    await drainQueue(token);
    expect(await tokenRow()).toMatchObject({ lastAction: 'claim', refusal: null, refusalDetail: null });
  });

  it('the /me agent-runs flag is on while enabled, stays on for a workspace with runs, and is off otherwise', async () => {
    const controlPlane = app.get(ControlPlaneService);
    const flags = async () =>
      new Map(
        (await controlPlane.listWorkspacesForUser(ADMIN.id)).map((workspace) => [
          workspace.id,
          workspace.agentRunsEnabled,
        ]),
      );

    await enable();
    await start(nextIssueKey()).expect(201);
    expect((await flags()).get(workspaceId)).toBe(true);
    expect((await flags()).get(otherWorkspaceId)).toBe(false);

    await api().put(`${runsBase()}/settings`).set('Authorization', human(ADMIN)).send({ enabled: false }).expect(200);
    expect((await flags()).get(workspaceId)).toBe(true);
    await enable();
  });

  describe('activity and transcript', () => {
    async function claimFor(token: string, runId: string) {
      const res = await claim(token).expect(200);
      expect(res.body.run.id).toBe(runId);
      return {
        id: res.body.turn.id as string,
        lease: res.body.lease.token as string,
        sessionId: res.body.run.sessionId as string,
      };
    }

    /** A state archive as the runner packs it: Claude Code's config directory, transcripts included. */
    async function stateArchive(files: Record<string, string>): Promise<Buffer> {
      const dir = await mkdtemp(join(tmpdir(), 'car-state-'));
      try {
        for (const [path, content] of Object.entries(files)) {
          await mkdir(dirname(join(dir, path)), { recursive: true });
          await writeFile(join(dir, path), content);
        }
        const chunks: Buffer[] = [];
        for await (const chunk of tar.create({ gzip: true, cwd: dir, portable: true }, [
          '.',
        ]) as AsyncIterable<Buffer>) {
          chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    function uploadArchive(token: string, turn: { id: string; lease: string }, archive: Buffer) {
      return api()
        .put(`${runnerBase()}/turns/${turn.id}/archive`)
        .set('Authorization', `Bearer ${token}`)
        .set(RUNNER_LEASE_HEADER, turn.lease)
        .set('Content-Type', 'application/octet-stream')
        .send(archive)
        .expect(200);
    }

    const transcript = (runId: string, query = '') =>
      api().get(`${runsBase()}/${runId}/transcript${query}`).set('Authorization', human(MEMBER));

    it('serves each turn’s phase, timing, spend and tool calls, and the run’s skill and tool counts, from its events', async () => {
      await enable();
      const token = await mintRunnerToken('runner-activity');
      await drainQueue(token);
      const { body: run } = await start(nextIssueKey()).expect(201);

      const startedAt = new Date(now);
      const first = await claimFor(token, run.id);
      await turnCall(token, first.id, first.lease, 'events', {
        events: [
          { type: 'skill', name: 'coredoc-workflows:coredoc-spec' },
          { type: 'message', text: 'Reading the PRD.' },
          { type: 'tool', name: 'Read', target: 'PRD.md', summary: '42 lines', isError: false },
          {
            type: 'tool',
            name: 'Bash',
            target: 'pnpm test',
            summary: '2 failed',
            isError: true,
            errorOutput: 'FAIL orders.test.ts\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
          },
          { type: 'tool', name: 'search_symbols', server: 'coredoc', target: 'order export', isError: false },
          // An older runner's line still counts for nothing and still renders.
          { type: 'raw', text: '[tool] Read {}' },
        ],
      }).expect(200);
      // Within the lease, so the completion is still this runner's.
      now = new Date(now.getTime() + 90_000);
      await turnCall(token, first.id, first.lease, 'complete', {
        outcome: { kind: 'ended' },
        spend: { costUsd: 0.25 },
        versions: VERSIONS,
      }).expect(200);

      const second = await claimFor(token, run.id);
      await turnCall(token, second.id, second.lease, 'events', {
        events: [
          { type: 'skill', name: 'coredoc-workflows:coredoc-spec' },
          { type: 'tool', name: 'Read', target: 'src/orders.ts', summary: '10 lines', isError: false },
        ],
      }).expect(200);

      const activity = await api()
        .get(`${runsBase()}/${run.id}/activity`)
        .set('Authorization', human(MEMBER))
        .expect(200);
      expect(activity.body.turns).toEqual([
        {
          id: first.id,
          ordinal: 1,
          kind: 'scope',
          state: 'completed',
          outcome: 'no_outcome',
          startedAt: startedAt.toISOString(),
          endedAt: now.toISOString(),
          durationSeconds: 90,
          spendUsd: 0.25,
          toolCalls: 3,
          failedToolCalls: 1,
        },
        {
          id: second.id,
          ordinal: 2,
          kind: 'scope',
          state: 'claimed',
          outcome: null,
          startedAt: now.toISOString(),
          endedAt: null,
          durationSeconds: null,
          spendUsd: null,
          toolCalls: 1,
          failedToolCalls: 0,
        },
      ]);
      expect(activity.body.skills).toEqual([{ name: 'coredoc-workflows:coredoc-spec', count: 2 }]);
      expect(activity.body.tools).toEqual([
        { name: 'Read', server: null, count: 2 },
        { name: 'Bash', server: null, count: 1 },
        { name: 'search_symbols', server: 'coredoc', count: 1 },
      ]);

      // The trace reads each event with its turn; stored payloads are redacted like every other event.
      const timeline = await api()
        .get(`${runsBase()}/${run.id}/events?after=0`)
        .set('Authorization', human(MEMBER))
        .expect(200);
      const failed = timeline.body.events.find(
        (event: { type: string; payload: { isError?: boolean } }) => event.type === 'tool' && event.payload.isError,
      );
      expect(failed).toMatchObject({
        turnId: first.id,
        payload: { name: 'Bash', errorOutput: 'FAIL orders.test.ts\nGITHUB_TOKEN=[REDACTED]' },
      });
    });

    it('serves the intent items the agent read and proposed, from the ids its intent calls reported', async () => {
      await enable();
      const token = await mintRunnerToken('runner-intent');
      await drainQueue(token);
      const { body: run } = await start(nextIssueKey()).expect(201);
      const audit = { createdBy: ADMIN.id, updatedBy: ADMIN.id };
      const domain = `car-cli-${RUN}`;
      const feature = `car-status-${RUN}`;
      await prisma.intentDomain.create({ data: { workspaceId, id: domain, title: 'CLI', statement: 'CLI', ...audit } });
      await prisma.intentFeature.create({
        data: { workspaceId, id: feature, domainId: domain, title: 'Status', statement: 'Status', ...audit },
      });
      const item = (id: string, title: string, authority: 'accepted' | 'candidate', attach: object) =>
        prisma.intentItem.create({
          data: { workspaceId, id, title, statement: title, kind: 'business_rule', authority, ...attach, ...audit },
        });
      await item(`br-car-readable-${RUN}`, 'Status output stays readable', 'accepted', {
        domainId: domain,
        featureId: feature,
      });
      await item(`br-car-root-${RUN}`, 'Exit codes are stable', 'accepted', {});
      await item(`br-car-json-${RUN}`, 'JSON status output is opt-in', 'candidate', { domainId: domain });

      const turn = await claimFor(token, run.id);
      const call = (name: string, intentIds: string[]) => ({
        type: 'tool',
        name,
        server: 'coredoc',
        isError: false,
        intentIds,
      });
      await turnCall(token, turn.id, turn.lease, 'events', {
        events: [
          call('get_intent_context', [`br-car-readable-${RUN}`, `br-car-json-${RUN}`, `br-car-deleted-${RUN}`]),
          call('get_intent_context', [`br-car-root-${RUN}`, `br-car-readable-${RUN}`]),
          call('intent_propose', [`br-car-json-${RUN}`]),
        ],
      }).expect(200);
      const activityOf = async () =>
        (await api().get(`${runsBase()}/${run.id}/activity`).set('Authorization', human(MEMBER)).expect(200)).body;

      // Intent is off for the workspace: the run page names no intent item.
      expect((await activityOf()).intent).toEqual({ read: [], proposed: [] });

      await prisma.workspace.update({ where: { id: workspaceId }, data: { intentEnabled: true } });
      const activity = { body: await activityOf() };
      await prisma.workspace.update({ where: { id: workspaceId }, data: { intentEnabled: false } });
      expect(activity.body.intent).toEqual({
        // First seen first; the proposed item is not repeated as read; a deleted item keeps its id.
        read: [
          {
            id: `br-car-readable-${RUN}`,
            title: 'Status output stays readable',
            kind: 'business_rule',
            authority: 'accepted',
            location: 'CLI · Status',
          },
          { id: `br-car-deleted-${RUN}`, title: null, kind: null, authority: null, location: null },
          {
            id: `br-car-root-${RUN}`,
            title: 'Exit codes are stable',
            kind: 'business_rule',
            authority: 'accepted',
            location: null,
          },
        ],
        proposed: [
          {
            id: `br-car-json-${RUN}`,
            title: 'JSON status output is opt-in',
            kind: 'business_rule',
            authority: 'candidate',
            location: 'CLI',
          },
        ],
      });
    });

    it('streams the phase’s Claude Code session transcript from the run’s latest state archive', async () => {
      await enable();
      const token = await mintRunnerToken('runner-transcript');
      await drainQueue(token);
      const { body: run } = await start(nextIssueKey()).expect(201);
      await transcript(run.id).expect(404);

      const turn = await claimFor(token, run.id);
      const first = JSON.stringify({ type: 'user', sessionId: turn.sessionId });
      // The token follows an escaped newline, so a pattern over the raw JSON line would miss it.
      const leaky = (github: string, key: string, url: string) =>
        JSON.stringify({ type: 'tool_result', content: `token:\n${github}\nkey ${key}\nremote ${url}` });
      const lines = `${first}\n${leaky('ghp_0123456789abcdefghijABCDEFGHIJ012345', 'sk-ant-api03-abcdefghijklmnopqrstuv', 'https://bot:s3cretpass@github.example.com/acme/orders.git')}\n`;
      // Archives are unredacted; the download is not.
      const redacted = `${first}\n${leaky('[REDACTED]', '[REDACTED]', 'https://[REDACTED]@github.example.com/acme/orders.git')}\n`;
      const project = `claude/projects/-scratch-runs-${run.id}-work`;
      await uploadArchive(
        token,
        turn,
        await stateArchive({
          [`${project}/0b5e8a52-0000-4000-8000-000000000000.jsonl`]: '{"another":"session"}\n',
          [`${project}/${turn.sessionId}.jsonl`]: lines,
          'coredoc-workflows/runs/state.json': '{}',
        }),
      );
      // Not before the turn completes: the run adopts the archive then.
      await transcript(run.id).expect(404);
      await turnCall(token, turn.id, turn.lease, 'complete', {
        outcome: { kind: 'ended' },
        spend: { costUsd: 0.1 },
        versions: VERSIONS,
      }).expect(200);

      const res = await transcript(run.id).buffer(true).parse(binaryBody).expect(200);
      expect(res.headers['content-disposition']).toBe(`attachment; filename="${run.issueKey}-scope-transcript.jsonl"`);
      expect((res.body as Buffer).toString('utf8')).toBe(redacted);

      // The implement session never ran, so it has no transcript.
      const missing = await transcript(run.id, '?phase=implement').expect(404);
      expect(missing.body.code).toBe('TRANSCRIPT_NOT_FOUND');

      const runner = await mintRunnerToken('runner-transcript-refused');
      await api().get(`${runsBase()}/${run.id}/transcript`).set('Authorization', `Bearer ${runner}`).expect(403);
    });

    it('refuses a transcript over the download cap without streaming it', async () => {
      await enable();
      const token = await mintRunnerToken('runner-transcript-cap');
      await drainQueue(token);
      const { body: run } = await start(nextIssueKey()).expect(201);
      const turn = await claimFor(token, run.id);
      // A header announcing a transcript over the cap; the body never needs to be read.
      const header = new tar.Header({
        path: `claude/projects/-scratch-runs-${run.id}-work/${turn.sessionId}.jsonl`,
        type: 'File',
        size: MAX_TRANSCRIPT_BYTES + 1,
        mode: 0o644,
        mtime: new Date(0),
      });
      const block = Buffer.alloc(512);
      header.encode(block, 0);
      await uploadArchive(token, turn, gzipSync(Buffer.concat([block, Buffer.alloc(4096, 0x61)])));
      await turnCall(token, turn.id, turn.lease, 'complete', {
        outcome: { kind: 'ended' },
        spend: { costUsd: 0.1 },
        versions: VERSIONS,
      }).expect(200);

      const refused = await transcript(run.id).expect(413);
      expect(refused.body.code).toBe('TRANSCRIPT_TOO_LARGE');
    });
  });

  describe('guards', () => {
    it('human routes refuse every service token, runner tokens included', async () => {
      const runner = await mintRunnerToken('runner-human-routes');
      const ci = await insertToken(workspaceId, [TokenPermission.ParserRead]);
      for (const token of [runner, ci]) {
        await api().get(runsBase()).set('Authorization', `Bearer ${token}`).expect(403);
        await api().post(runsBase()).set('Authorization', `Bearer ${token}`).send({ issueKey: 'PROJ-1' }).expect(403);
      }
    });

    it('runner routes refuse human sessions, other workspaces’ tokens and a legacy grant-all token', async () => {
      await api()
        .post(`${runnerBase()}/claim`)
        .set('Authorization', human(ADMIN))
        .send({ protocolVersion: RUNNER_PROTOCOL_VERSION, versions: VERSIONS })
        .expect(403);

      const foreign = await insertToken(otherWorkspaceId, [TokenPermission.AgentRunnerRun]);
      await claim(foreign).expect(403);

      const grantAll = await insertToken(workspaceId, ['*']);
      await claim(grantAll).expect(403);
    });

    it('a runner token is refused by the cloud MCP and a permission-less member route; a turn’s MCP token only works on MCP', async () => {
      await enable();
      const runner = await mintRunnerToken('runner-fence');
      const ci = await insertToken(workspaceId, [TokenPermission.ParserRead]);
      const repos = `/api/v1/workspaces/${workspaceId}/repos`;
      const mcp = `/api/v1/workspaces/${workspaceId}/mcp`;
      // Both surfaces admit an ordinary service token, so the refusals below are the runner fence.
      await api().get(repos).set('Authorization', `Bearer ${ci}`).expect(200);
      await api().post(mcp).set('Authorization', `Bearer ${ci}`).send({}).expect(200);

      await api().get(repos).set('Authorization', `Bearer ${runner}`).expect(403);
      await api().post(mcp).set('Authorization', `Bearer ${runner}`).send({}).expect(403);

      await drainQueue(runner);
      await start(nextIssueKey()).expect(201);
      const claimed = await claim(runner).expect(200);
      const turnToken = claimed.body.mcp.token as string;
      await api().post(mcp).set('Authorization', `Bearer ${turnToken}`).send({}).expect(200);
      await api().get(repos).set('Authorization', `Bearer ${turnToken}`).expect(403);
      await api().get(runsBase()).set('Authorization', `Bearer ${turnToken}`).expect(403);
      await claim(turnToken).expect(403);
    });

    it('a runner token whose creator was demoted is refused, and settings say why', async () => {
      const token = await mintRunnerToken('runner-demoted', DEMOTED);
      await prisma.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId: DEMOTED.id } },
        data: { role: 'member' },
      });

      await claim(token).expect(403);
      const settings = await api().get(`${runsBase()}/settings`).set('Authorization', human(ADMIN)).expect(200);
      expect(settings.body.runnerTokens).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'runner-demoted', refusal: 'creator_not_admin' })]),
      );
    });

    it('non-members get 403', async () => {
      await api().get(runsBase(otherWorkspaceId)).set('Authorization', human(MEMBER)).expect(403);
    });
  });

  describe('partial unique indexes', () => {
    async function expectUniqueViolation(operation: Promise<unknown>): Promise<void> {
      const error = await operation.then(
        () => null,
        (caught: unknown) => caught,
      );
      const code = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: string } } } } | null)?.meta
        ?.driverAdapterError?.cause?.originalCode;
      expect(code).toBe('23505');
    }

    it('allow one open run per Jira issue and one queued or claimed turn per run', async () => {
      await enable();
      const { body: run } = await start(nextIssueKey()).expect(201);
      const row = await prisma.cloudAgentRun.findUniqueOrThrow({ where: { id: run.id } });
      const { id: _id, createdAt: _c, updatedAt: _u, ...copy } = row;

      await expectUniqueViolation(
        prisma.cloudAgentRun.create({
          data: { ...copy, repositories: [], droppedSeeds: [], pullRequests: [], jiraOutcome: {}, assumptions: [] },
        }),
      );
      await expectUniqueViolation(
        prisma.cloudAgentRunTurn.create({ data: { workspaceId, runId: run.id, ordinal: 2, kind: 'scope' } }),
      );

      // A terminal run frees the issue.
      await prisma.cloudAgentRun.update({ where: { id: run.id }, data: { status: 'failed' } });
      await prisma.cloudAgentRun.create({
        data: { ...copy, repositories: [], droppedSeeds: [], pullRequests: [], jiraOutcome: {}, assumptions: [] },
      });
    });
  });
});
