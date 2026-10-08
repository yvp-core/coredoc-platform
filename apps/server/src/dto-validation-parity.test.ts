/**
 * Frozen request-validation parity for the 17 routes that were validated by class-validator DTOs
 * and the global `ValidationPipe({ whitelist: true, transform: true })` this table was captured
 * against.
 *
 * Each row is a bad request captured against that stack together with the exact
 * `{ statusCode, message }` the global exception filter emitted for it — the decorator messages
 * joined with '; ', which is what a client matches on. The table is the guard for replacing each
 * DTO with a zod schema at the controller boundary and removing the global pipe
 * (`.scratch/server-structure-cleanup/spec.md`, Track B3): it must pass unchanged before and after.
 *
 * One file for all eight modules on purpose: it is one harness (the real controllers, stubbed
 * services, guards waved through) and splitting it per module would copy that harness eight times
 * without adding a single assertion.
 */
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthGuard } from './auth/auth.guard.js';
import { JwtOnlyGuard } from './auth/jwt-only.guard.js';
import { PermissionsGuard } from './auth/permissions.guard.js';
import { WorkspaceRoleGuard } from './auth/workspace-role.guard.js';
import { GlobalExceptionFilter } from './libs/global-exception.filter.js';
import { AgentRunsController } from './modules/agent-runs/agent-runs.controller.js';
import { AgentRunsService } from './modules/agent-runs/agent-runs.service.js';
import { ActorRegistryService } from './modules/delivery/actor-registry.service.js';
import { DeliveryController } from './modules/delivery/delivery.controller.js';
import { DeliveryEnabledGuard } from './modules/delivery/delivery-enabled.guard.js';
import { DeliveryService } from './modules/delivery/delivery.service.js';
import { JiraCanonicalProjectionService } from './modules/delivery/jira-canonical-projection.service.js';
import { StatusMapService } from './modules/delivery/status-map.service.js';
import { JobsController } from './modules/jobs/jobs.controller.js';
import { PushQueueService } from './modules/job-queue/push-queue.service.js';
import { InvitationRateLimitGuard } from './modules/members/invitation-rate-limit.guard.js';
import { MembersController } from './modules/members/members.controller.js';
import { MembersService } from './modules/members/members.service.js';
import { PushController } from './modules/push/push.controller.js';
import { PushService } from './modules/push/push.service.js';
import { ReposController } from './modules/repos/repos.controller.js';
import { ReposService } from './modules/repos/repos.service.js';
import { TelemetryTokenController } from './modules/tokens/telemetry-token.controller.js';
import { TokensController } from './modules/tokens/tokens.controller.js';
import { TokensService } from './modules/tokens/tokens.service.js';
import { ResolverService } from './modules/mapper/resolver.service.js';
import { WorkspacesController } from './modules/workspaces/workspaces.controller.js';
import { WorkspacesService } from './modules/workspaces/workspaces.service.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const API = '/api/v1';

interface ExpectedRejection {
  statusCode: number;
  message: string;
}

type Case = [
  label: string,
  method: 'POST' | 'PATCH' | 'PUT' | 'GET',
  path: string,
  payload: unknown,
  expected: ExpectedRejection,
];

const TABLE: Case[] = [
  // agent-runs
  [
    'agent-runs create with a non-string runId and an unknown outcome',
    'POST',
    `${API}/workspaces/${WORKSPACE_ID}/agent-runs`,
    {
      runId: 7,
      kind: 'author-profile',
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 1,
      turns: 1,
      toolCalls: 1,
      interventions: 1,
      outcome: 'exploded',
      durationMs: 1,
    },
    {
      statusCode: 400,
      message: 'runId must be a string; outcome must be one of the following values: success, cancelled, error',
    },
  ],
  // repos
  [
    'repos connect with an empty repoKey',
    'POST',
    `${API}/workspaces/${WORKSPACE_ID}/repos`,
    { repoKey: '', repoName: 'coredoc-parser' },
    { statusCode: 400, message: 'repoKey should not be empty' },
  ],
  [
    'repos patch with an unknown release trigger',
    'PATCH',
    `${API}/workspaces/${WORKSPACE_ID}/repos/repo-1`,
    { intentReleaseTrigger: 'whenever' },
    { statusCode: 400, message: 'intentReleaseTrigger must be one of the following values: manual, merge, deploy' },
  ],
  // workspaces
  [
    'workspace create with a short name and a bad slug',
    'POST',
    `${API}/workspaces`,
    { name: 'a', slug: 'Not A Slug' },
    {
      statusCode: 400,
      message:
        'name must be longer than or equal to 2 characters; slug must be lowercase alphanumeric with hyphens (e.g. my-workspace)',
    },
  ],
  [
    'workspace patch with a non-boolean flag',
    'PATCH',
    `${API}/workspaces/${WORKSPACE_ID}`,
    { ciCdEnabled: 'yes' },
    { statusCode: 400, message: 'ciCdEnabled must be a boolean value' },
  ],
  [
    'cloud enable with a non-boolean flag',
    'POST',
    `${API}/workspaces/${WORKSPACE_ID}/cloud/enable`,
    { ciCdEnabled: 'yes' },
    { statusCode: 400, message: 'ciCdEnabled must be a boolean value' },
  ],
  [
    'workspace resolve with a malformed parsed version',
    'POST',
    `${API}/workspaces/${WORKSPACE_ID}/resolve`,
    { targets: [{ repoName: 'coredoc-parser', parsedVersion: 'nope' }] },
    { statusCode: 400, message: 'targets.0.parsedVersion must be a 16-hex artifact version' },
  ],
  // push
  [
    'push with a missing parsedVersion',
    'POST',
    `${API}/workspaces/${WORKSPACE_ID}/repos/coredoc-parser/push`,
    { commitSha: 'abc' },
    { statusCode: 400, message: 'parsedVersion must be a string' },
  ],
  // delivery
  [
    'delivery settings with a non-boolean enabled',
    'PUT',
    `${API}/workspaces/${WORKSPACE_ID}/delivery/settings`,
    { enabled: 'yes' },
    { statusCode: 400, message: 'enabled must be a boolean value' },
  ],
  [
    'connector create with an unknown provider and an oversized token',
    'POST',
    `${API}/workspaces/${WORKSPACE_ID}/delivery/connectors`,
    { provider: 'gitlab', token: 'x'.repeat(4097) },
    {
      statusCode: 400,
      message:
        'provider must be one of the following values: github, jira; token must be shorter than or equal to 4096 characters',
    },
  ],
  [
    // The one DELIBERATE message change of Track B3. class-validator ran `@ArrayMaxSize`,
    // `@IsArray` and `@ValidateNested` independently on a value that is not an array and
    // reported all three, in that order; the schema says the one true thing once.
    'status map with a non-array entries',
    'PUT',
    `${API}/workspaces/${WORKSPACE_ID}/delivery/status-map/conn-1`,
    { entries: 'none' },
    { statusCode: 400, message: 'entries must be an array' },
  ],
  [
    'status map with an unknown lifecycle in an entry',
    'PUT',
    `${API}/workspaces/${WORKSPACE_ID}/delivery/status-map/conn-1`,
    { entries: [{ status: 'In Progress', lifecycle: 'paused' }] },
    {
      statusCode: 400,
      message: 'entries.0.lifecycle must be one of the following values: active, completed, abandoned, ',
    },
  ],
  [
    'actor merge with a non-UUID target',
    'POST',
    `${API}/workspaces/${WORKSPACE_ID}/delivery/actors/actor-1/merge`,
    { intoActorId: 'actor-2' },
    { statusCode: 400, message: 'intoActorId must be a UUID' },
  ],
  // members
  [
    'invite with a malformed email and an unassignable role',
    'POST',
    `${API}/workspaces/${WORKSPACE_ID}/members/invites`,
    { email: 'not-an-email', role: 'owner' },
    {
      statusCode: 400,
      message: 'email must be an email; role must be one of the following values: admin, product, member',
    },
  ],
  [
    'member role update with an unassignable role',
    'PATCH',
    `${API}/workspaces/${WORKSPACE_ID}/members/user-1`,
    { role: 'superuser' },
    { statusCode: 400, message: 'role must be one of: admin, product, member' },
  ],
  // jobs
  [
    'job list with an unknown status',
    'GET',
    `${API}/workspaces/${WORKSPACE_ID}/jobs?status=whenever`,
    undefined,
    { statusCode: 400, message: 'status must be one of the following values: pending, running, succeeded, failed' },
  ],
  [
    'job list with an out-of-range limit',
    'GET',
    `${API}/workspaces/${WORKSPACE_ID}/jobs?limit=500`,
    undefined,
    { statusCode: 400, message: 'limit must not be greater than 200' },
  ],
  // tokens
  [
    'token create with an empty name and an unknown scope',
    'POST',
    `${API}/workspaces/${WORKSPACE_ID}/tokens`,
    { name: '', scope: 'root' },
    {
      statusCode: 400,
      message:
        'name should not be empty; scope must be one of the following values: ci, intent-agent, telemetry, agent-runner',
    },
  ],
  [
    'telemetry token create with an oversized name',
    'POST',
    `${API}/workspaces/${WORKSPACE_ID}/telemetry-token`,
    { name: 'x'.repeat(129) },
    { statusCode: 400, message: 'name must be shorter than or equal to 128 characters' },
  ],
];

describe('class-validator DTO rejection parity', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        AgentRunsController,
        ReposController,
        WorkspacesController,
        PushController,
        DeliveryController,
        MembersController,
        JobsController,
        TokensController,
        TelemetryTokenController,
      ],
      providers: [
        AgentRunsService,
        ReposService,
        WorkspacesService,
        ResolverService,
        PushQueueService,
        PushService,
        DeliveryService,
        StatusMapService,
        JiraCanonicalProjectionService,
        ActorRegistryService,
        MembersService,
        TokensService,
        // Empty stubs: a row that stops being rejected calls a method that is not there and
        // fails with a TypeError rather than silently passing.
      ].map((provide) => ({ provide, useValue: {} })),
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const httpRequest = context.switchToHttp().getRequest();
          httpRequest.user = { id: 'actor-1', email: 'pilot@example.com' };
          httpRequest.userWorkspaceRole = 'owner';
          return true;
        },
      })
      .overrideGuard(WorkspaceRoleGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(JwtOnlyGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(DeliveryEnabledGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(InvitationRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    // The production bootstrap: `main.ts` installs no global pipe any more — each route declares
    // its own — and this filter is what turns a rejection into the body the rows below assert.
    app.useGlobalFilters(new GlobalExceptionFilter(app.get(HttpAdapterHost)));
    await app.init();
    // Bind IPv4 loopback: supertest's ephemeral '::' bind can collide with a 127.0.0.1-only local listener on macOS.
    await app.listen(0, '127.0.0.1');
  });

  afterEach(async () => {
    await app.close();
  });

  it.each(TABLE)('rejects %s', async (_label, method, path, payload, expected) => {
    const agent = request(app.getHttpServer());
    const call =
      method === 'GET'
        ? agent.get(path)
        : method === 'POST'
          ? agent.post(path).send(payload as object)
          : method === 'PUT'
            ? agent.put(path).send(payload as object)
            : agent.patch(path).send(payload as object);
    const response = await call.expect(expected.statusCode);

    expect({ statusCode: response.body.statusCode, message: response.body.message }).toEqual(expected);
  });
});
