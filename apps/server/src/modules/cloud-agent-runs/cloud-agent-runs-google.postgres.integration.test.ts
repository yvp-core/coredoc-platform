import '../../config/load-env.js';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { McpModule as McpNestModule } from '@rekog/mcp-nest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DeliveryKind,
  PhaseGate,
  RepositoryMode,
  RUNNER_LEASE_HEADER,
  RUNNER_PROTOCOL_VERSION,
  ToolAccess,
  type WorkflowShape,
} from '@coredoc/core/agent-runner';
import { AuthService } from '../../auth/auth.service.js';
import { CONNECTORS_CONFIG, STORAGE_CONFIG, configFromEnv } from '../../config/app-config.js';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import { encrypt } from '../../database/encryption.js';
import { PrismaService } from '../../database/prisma.service.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { AGENT_GOOGLE_FETCH, AgentGoogle, type GoogleFetch } from '../../libs/google/agent-google.js';
import { ROOT_ROUTES } from '../../libs/spa-serving.js';
import { MCP_SERVER_OPTIONS } from '../../mcp/mcp.module.js';
import { isMcpRequestPath, McpRewriteMiddleware } from '../../mcp/mcp-rewrite.middleware.js';
import { AgentGoogleTools } from '../../mcp/tools/agent-google.tools.js';
import { AgentJiraTools } from '../../mcp/tools/agent-jira.tools.js';
import { GITHUB_CLIENT_FACTORY } from '../delivery/github-importer.service.js';
import { JIRA_CLIENT_FACTORY } from '../delivery/jira-importer.service.js';
import { graphRepoHashOf } from '../repos/repo-intent-identity.js';
import { TokensController } from '../tokens/tokens.controller.js';
import { TokensService } from '../tokens/tokens.service.js';
import { CLOUD_AGENT_RUN_ARCHIVE_STORE } from './cloud-agent-run-archive.store.js';
import { CloudAgentRunnerController } from './cloud-agent-runner.controller.js';
import { CloudAgentRunsController } from './cloud-agent-runs.controller.js';
import {
  CLOUD_AGENT_RUNS_CLOCK,
  CLOUD_AGENT_RUNS_RETRY_DELAY,
  cloudAgentRunsCoreProviders,
} from './cloud-agent-runs.module.js';
import {
  advertising,
  FakeGithubPulls,
  FakeJira,
  InMemoryArchiveStore,
  paragraphDoc,
  setAgentRunsEnabled,
} from './cloud-agent-runs.test-support.js';
import { RUNNER_RATE_LIMIT } from './runner-rate-limit.guard.js';

const TEST_DATABASE_URL = process.env.CLOUD_AGENT_RUNS_TEST_DATABASE_URL ?? '';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
const ADMIN = { id: `${RUN}-admin`, email: 'admin@example.com' };
const DRIVE = 'drive-0001';
const PRIVATE_KEY = 'private-key-that-no-response-may-carry';

const PHASES = [
  { id: 'draft', gate: PhaseGate.Acceptance },
  { id: 'handoff', gate: PhaseGate.None },
];
const BOTH = [ToolAccess.Read, ToolAccess.Write];
const base = { repositories: RepositoryMode.None, delivery: DeliveryKind.None, phases: PHASES };
/** Grants Google and Jira write. */
const CONTRACT: WorkflowShape = { ...base, id: 'contract', title: 'Contract', tools: { jira: BOTH, google: BOTH } };
/** Grants neither. */
const PLAIN: WorkflowShape = { ...base, id: 'plain', title: 'Plain', tools: { jira: [], google: [] } };

const VALUES = [['Overtime', 1.5]];
/** Every tool of the toolset, each naming a file of the shared drive. */
const GOOGLE_CALLS: Array<[string, Record<string, unknown>]> = [
  ['read_doc', { documentId: 'spec' }],
  [
    'update_doc',
    { documentId: 'spec', requests: [{ insertText: { text: 'x' } }], writeControl: { requiredRevisionId: 'r1' } },
  ],
  ['search_files', { query: 'spec' }],
  ['get_file_metadata', { fileId: 'spec' }],
  ['read_file_content', { fileId: 'spec' }],
  ['create_file', { name: 'Notes', parentId: 'spec', mimeType: 'text/plain', content: 'x' }],
  ['trash_file', { fileId: 'spec' }],
  ['get_spreadsheet', { spreadsheetId: 'spec' }],
  ['get_values', { spreadsheetId: 'spec', range: 'A1:B2' }],
  ['append_values', { spreadsheetId: 'spec', range: 'A1', values: VALUES }],
  ['update_values', { spreadsheetId: 'spec', range: 'A1', values: VALUES }],
];

interface Runner {
  token: string;
  versions: ReturnType<typeof advertising>;
}
interface Turn {
  id: string;
  lease: string;
  mcpToken: string;
  kind: string;
}

describe.skipIf(!TEST_DATABASE_URL)('cloud agent runs: Google and Jira-write tools (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let previousDatabaseUrl: string | undefined;
  let previousEncryptionKey: string | undefined;
  let app: NestExpressApplication;
  let baseUrl: string;
  /** The workspace the server's Google configuration names. */
  let configured: string;
  /** A second workspace of the same server. */
  let other: string;
  const runners = new Map<string, Runner>();
  let issueSeed = 0;
  const jira = new FakeJira();
  const github = new FakeGithubPulls();
  const googleRequests: string[] = [];
  const google: GoogleFetch = async (url, init) => {
    googleRequests.push(`${init.method} ${new URL(url).pathname}`);
    return new Response(JSON.stringify({ id: 'spec', name: 'Spec', mimeType: 'text/plain', driveId: DRIVE }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };

  async function seedWorkspace(name: string): Promise<string> {
    const workspace = await prisma.workspace.create({ data: { name, slug: name, deliveryEnabled: true } });
    const workspaceId = workspace.id;
    await prisma.workspaceMember.create({
      data: { workspaceId, userId: ADMIN.id, email: ADMIN.email, role: 'admin' },
    });
    const jiraConnector = await prisma.deliveryConnector.create({
      data: {
        workspaceId,
        provider: 'jira',
        displayName: 'Jira',
        baseUrl: 'https://example.atlassian.net',
        credentialsEncrypted: encrypt(JSON.stringify({ email: 'bot@example.com', apiToken: 'jira-token' })),
        config: { projects: ['PROJ'] },
      },
    });
    await prisma.deliveryConnector.create({
      data: {
        workspaceId,
        provider: 'github',
        displayName: 'GitHub',
        credentialsEncrypted: encrypt('ghp_read_only'),
        config: { repos: [] },
      },
    });
    await prisma.deliveryStatusMap.createMany({
      data: [
        { workspaceId, connectorId: jiraConnector.id, statusRaw: 'To Do', lifecycle: null },
        { workspaceId, connectorId: jiraConnector.id, statusRaw: 'Done', lifecycle: 'completed' },
      ],
    });
    await prisma.workspaceRepo.create({
      data: {
        workspaceId,
        repoKey: graphRepoHashOf('orders-api'),
        repoName: 'orders-api',
        intentRepoKey: 'orders-api',
        normalizedGitRemote: 'github.com/example-org/orders-api',
      },
    });
    return workspaceId;
  }

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    previousEncryptionKey = process.env.SERVER_ENCRYPTION_KEY;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.SERVER_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    pool = buildPrismaAdapter();
    prisma = new PrismaClient({ adapter: pool?.adapter } as never);
    await prisma.$connect();
    configured = await seedWorkspace(`carg-${RUN}`);
    other = await seedWorkspace(`carg-other-${RUN}`);

    const storage = configFromEnv().storage;
    const authService = {
      async verifyAccessToken(token: string) {
        if (token !== `jwt:${ADMIN.id}`) throw new Error('unknown test user');
        return ADMIN;
      },
    };
    const moduleRef = await Test.createTestingModule({
      imports: [McpNestModule.forRoot(MCP_SERVER_OPTIONS)],
      controllers: [CloudAgentRunsController, CloudAgentRunnerController, TokensController],
      providers: [
        { provide: PrismaService, useValue: prisma as unknown as PrismaService },
        ControlPlaneService,
        TokensService,
        ...cloudAgentRunsCoreProviders,
        AgentJiraTools,
        AgentGoogleTools,
        AgentGoogle,
        {
          provide: CONNECTORS_CONFIG,
          useValue: {
            agentGoogle: {
              serviceAccount: { clientEmail: 'agent@example.iam.gserviceaccount.com', privateKey: PRIVATE_KEY },
              sharedDriveId: DRIVE,
              workspaceId: configured,
            },
          },
        },
        { provide: AGENT_GOOGLE_FETCH, useValue: google },
        { provide: CLOUD_AGENT_RUNS_CLOCK, useValue: () => new Date() },
        { provide: CLOUD_AGENT_RUNS_RETRY_DELAY, useValue: () => 0 },
        { provide: JIRA_CLIENT_FACTORY, useValue: () => jira.client() },
        { provide: GITHUB_CLIENT_FACTORY, useValue: () => github.client() },
        { provide: CLOUD_AGENT_RUN_ARCHIVE_STORE, useValue: new InMemoryArchiveStore() },
        { provide: RUNNER_RATE_LIMIT, useValue: { burst: 10_000, refillPerSec: 100 } },
        { provide: STORAGE_CONFIG, useValue: { ...storage, r2: { ...storage.r2, endpoint: 'https://r2.example' } } },
        { provide: AuthService, useValue: authService },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    const middleware = new McpRewriteMiddleware(
      authService as unknown as AuthService,
      moduleRef.get(ControlPlaneService),
    );
    app.useBodyParser('json');
    app.use((req: Request, res: Response, next: NextFunction) =>
      isMcpRequestPath(req.url) ? middleware.use(req, res, next) : next(),
    );
    app.setGlobalPrefix('api/v1', { exclude: ROOT_ROUTES });
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;

    for (const workspaceId of [configured, other]) {
      await setAgentRunsEnabled(prisma, workspaceId);
      await api()
        .put(`${runsBase(workspaceId)}/settings`)
        .set('Authorization', human)
        .send({ takeOverOwnership: true, maxStartedRuns: 50 })
        .expect(200);
      runners.set(workspaceId, await advertise(workspaceId));
    }
  });

  afterAll(async () => {
    (app?.getHttpServer() as Server | undefined)?.closeAllConnections();
    await app?.close();
    for (const workspaceId of [configured, other]) {
      if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    }
    await prisma.$disconnect();
    if (pool?.pool) await pool.pool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousEncryptionKey === undefined) delete process.env.SERVER_ENCRYPTION_KEY;
    else process.env.SERVER_ENCRYPTION_KEY = previousEncryptionKey;
  });

  const api = () => request(app.getHttpServer());
  const human = `Bearer jwt:${ADMIN.id}`;
  const runsBase = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/cloud-agent-runs`;
  const runnerBase = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/agent-runner`;

  /** A runner token of the workspace whose first claim advertises both workflows. */
  async function advertise(workspaceId: string): Promise<Runner> {
    const minted = await api()
      .post(`/api/v1/workspaces/${workspaceId}/tokens`)
      .set('Authorization', human)
      .send({ name: 'google-runner', scope: 'agent-runner' })
      .expect(201);
    const runner = {
      token: minted.body.token as string,
      versions: advertising({ runner: '0.0.1-test' }, [CONTRACT, PLAIN]),
    };
    await claim(workspaceId, runner).expect(204);
    return runner;
  }

  const claim = (workspaceId: string, runner = runners.get(workspaceId)!) =>
    api()
      .post(`${runnerBase(workspaceId)}/claim`)
      .set('Authorization', `Bearer ${runner.token}`)
      .send({ protocolVersion: RUNNER_PROTOCOL_VERSION, versions: runner.versions });

  async function claimTurn(workspaceId: string): Promise<Turn> {
    const { body } = await claim(workspaceId).expect(200);
    return { id: body.turn.id, lease: body.lease.token, mcpToken: body.mcp.token, kind: body.turn.kind };
  }

  const turnCall = (workspaceId: string, turn: Turn, path: string, body: object) =>
    api()
      .post(`${runnerBase(workspaceId)}/turns/${turn.id}/${path}`)
      .set('Authorization', `Bearer ${runners.get(workspaceId)!.token}`)
      .set(RUNNER_LEASE_HEADER, turn.lease)
      .send(body);

  function newIssue(): string {
    issueSeed += 1;
    return jira.add({
      key: `PROJ-${issueSeed}`,
      summary: `Contract ${issueSeed}`,
      project: 'PROJ',
      description: paragraphDoc('Prepare it for country X.'),
      labels: ['stub'],
    }).key;
  }

  const start = (workspaceId: string, workflow: string, issueKey = newIssue()) =>
    api().post(runsBase(workspaceId)).set('Authorization', human).send({ issueKey, workflow });

  /** Ends the gated first phase with an accepted proposal and claims the final phase's turn. */
  async function finalTurn(workspaceId: string, runId: string, draft: Turn): Promise<Turn> {
    const proposal = { title: 'Contract', summary: 'Drafted.', specMarkdown: '# Contract\n', repositories: [] };
    expect((await turnCall(workspaceId, draft, 'propose-scope', proposal).expect(200)).body.accepted).toBe(true);
    await turnCall(workspaceId, draft, 'complete', {
      outcome: { kind: 'ended' },
      spend: { costUsd: 0.1, sdkTurns: 1 },
      versions: runners.get(workspaceId)!.versions,
      repositories: [],
      deliveries: [],
    }).expect(200);
    await api()
      .post(`${runsBase(workspaceId)}/${runId}/specs/1/accept`)
      .set('Authorization', human)
      .send({})
      .expect(200);
    const turn = await claimTurn(workspaceId);
    expect(turn.kind).toBe('handoff');
    return turn;
  }

  const permissionsOf = async (turn: Turn) =>
    (await prisma.serviceToken.findFirstOrThrow({ where: { owningTurnId: turn.id } })).permissions.sort();

  /** One tool call over the MCP endpoint with the turn's own token, as the runner's session makes it. */
  async function callTool(
    workspaceId: string,
    turn: Turn,
    toolset: 'agent-google' | 'agent-jira',
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ refused: boolean; text: string }> {
    const client = new Client({ name: 'agent-turn', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`/api/v1/workspaces/${workspaceId}/mcp?toolset=${toolset}`, baseUrl), {
        requestInit: { headers: { Authorization: `Bearer ${turn.mcpToken}` } },
      }),
    );
    try {
      const result = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      return { refused: result.isError === true, text: result.content.map((part) => part.text).join('\n') };
    } catch (error) {
      return { refused: true, text: (error as Error).message };
    } finally {
      await client.close();
    }
  }

  it('settings and the workflow list show Google only for the workspace the server is configured for', async () => {
    const settings = async (workspaceId: string) =>
      (
        await api()
          .get(`${runsBase(workspaceId)}/settings`)
          .set('Authorization', human)
          .expect(200)
      ).body;
    const workflows = async (workspaceId: string) =>
      (
        await api()
          .get(`${runsBase(workspaceId)}/workflows`)
          .set('Authorization', human)
          .expect(200)
      ).body.workflows as Array<{ id: string; startable: boolean; reason: string | null }>;

    const named = await settings(configured);
    expect(named.google).toEqual({ configured: true, sharedDriveId: DRIVE });
    expect(JSON.stringify(named)).not.toContain(PRIVATE_KEY);
    expect((await settings(other)).google).toEqual({ configured: false, sharedDriveId: null });

    expect((await workflows(configured)).find(({ id }) => id === 'contract')).toMatchObject({ startable: true });
    const elsewhere = await workflows(other);
    expect(elsewhere.find(({ id }) => id === 'contract')).toMatchObject({
      startable: false,
      reason: expect.stringContaining('Google'),
    });
    expect(elsewhere.find(({ id }) => id === 'plain')).toMatchObject({ startable: true });
  });

  it('a workflow that grants Google starts only in the configured workspace', async () => {
    const refused = await start(other, 'contract').expect(400);
    expect(refused.body.code).toBe('AGENT_RUNS_UNAVAILABLE');
    expect(await prisma.cloudAgentRun.count({ where: { workspaceId: other } })).toBe(0);

    await start(configured, 'contract').expect(201);
    await claimTurn(configured);
  });

  it('a granted workflow’s turns hold the Google permissions in every phase and Jira write only in the final one', async () => {
    const issueKey = newIssue();
    const bystander = newIssue();
    const { body: run } = await start(configured, 'contract', issueKey).expect(201);

    const draft = await claimTurn(configured);
    expect(await permissionsOf(draft)).toEqual(['google:read', 'google:write', 'intent:read', 'jira:read']);
    const read = await callTool(configured, draft, 'agent-google', 'get_file_metadata', { fileId: 'spec' });
    expect(read).toMatchObject({ refused: false, text: expect.stringContaining('"name":"Spec"') });
    const update = { description: paragraphDoc('The engineering story.'), addLabels: ['contract-ready'] };
    expect((await callTool(configured, draft, 'agent-jira', 'jira_update_issue', update)).refused).toBe(true);
    expect(jira.issues.get(issueKey)).toMatchObject({ labels: ['stub'] });

    const handoff = await finalTurn(configured, run.id, draft);
    expect(await permissionsOf(handoff)).toEqual([
      'google:read',
      'google:write',
      'intent:propose',
      'intent:read',
      'jira:read',
      'jira:write',
    ]);
    expect((await callTool(configured, handoff, 'agent-google', 'get_file_metadata', { fileId: 'spec' })).refused).toBe(
      false,
    );
    // Arguments that try to name another issue reach nothing: the tool has no issue argument.
    const updated = await callTool(configured, handoff, 'agent-jira', 'jira_update_issue', {
      ...update,
      key: bystander,
      issueKey: bystander,
    });
    expect(updated).toMatchObject({ refused: false, text: expect.stringContaining(issueKey) });
    expect(jira.issues.get(issueKey)).toMatchObject({
      description: update.description,
      labels: ['stub', 'contract-ready'],
    });
    expect(jira.callsOn(bystander).filter((call) => call.startsWith('updateIssue'))).toEqual([]);
    expect(jira.issues.get(bystander)).toMatchObject({ labels: ['stub'] });
  });

  it('a workflow that grants nothing gets neither permission, and its calls to the tools are refused', async () => {
    const issueKey = newIssue();
    const { body: run } = await start(configured, 'plain', issueKey).expect(201);
    const draft = await claimTurn(configured);
    expect(await permissionsOf(draft)).toEqual(['intent:read', 'jira:read']);
    const handoff = await finalTurn(configured, run.id, draft);
    expect(await permissionsOf(handoff)).toEqual(['intent:propose', 'intent:read', 'jira:read']);

    googleRequests.length = 0;
    expect((await callTool(configured, handoff, 'agent-google', 'get_file_metadata', { fileId: 'spec' })).refused).toBe(
      true,
    );
    expect(googleRequests).toEqual([]);
    const update = { addLabels: ['contract-ready'] };
    expect((await callTool(configured, handoff, 'agent-jira', 'jira_update_issue', update)).refused).toBe(true);
    expect(jira.issues.get(issueKey)).toMatchObject({ labels: ['stub'] });
  });

  it('every Google tool refuses a turn of another workspace, whatever its workflow grants', async () => {
    // A run whose shape grants Google in a workspace the configuration does not name: one that
    // started before the server's configuration was pointed elsewhere.
    const { body: run } = await start(other, 'plain').expect(201);
    await prisma.cloudAgentRun.update({
      where: { id: run.id },
      data: { workflowShape: { ...PLAIN, tools: CONTRACT.tools } },
    });
    const turn = await claimTurn(other);
    expect(await permissionsOf(turn)).toEqual(expect.arrayContaining(['google:read', 'google:write']));

    googleRequests.length = 0;
    for (const [name, args] of GOOGLE_CALLS) {
      expect(await callTool(other, turn, 'agent-google', name, args), name).toMatchObject({ refused: true });
    }
    expect(googleRequests).toEqual([]);

    // The same calls from the configured workspace reach Google, so the refusals above are the workspace's.
    await start(configured, 'contract').expect(201);
    const served = await claimTurn(configured);
    for (const [name, args] of GOOGLE_CALLS) await callTool(configured, served, 'agent-google', name, args);
    expect(googleRequests.length).toBeGreaterThanOrEqual(GOOGLE_CALLS.length);
  });
});
