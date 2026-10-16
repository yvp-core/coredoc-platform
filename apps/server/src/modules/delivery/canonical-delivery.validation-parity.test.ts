/**
 * Frozen request-validation parity for the five delivery v2 write routes.
 *
 * Each row is a bad body captured against the pre-zod controller/service pair together with the
 * exact `{ statusCode, message, code? }` the global exception filter emitted for it. The table is
 * the guard for moving validation from `canonical-delivery.service.ts` into a `ZodValidationPipe`
 * at the controller boundary (`.scratch/server-structure-cleanup/spec.md`, Track B1): it must pass
 * unchanged before and after that move.
 *
 * The real service is wired with a Prisma stub that throws on any access, so a row that stops
 * being rejected fails loudly instead of silently reaching the database.
 */
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { UserSessionGuard } from '../../auth/user-session.guard.js';
import { PermissionsGuard } from '../../auth/permissions.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import type { PrismaService } from '../../database/prisma.service.js';
import { GlobalExceptionFilter } from '../../libs/global-exception.filter.js';
import { CanonicalDeliveryController } from './canonical-delivery.controller.js';
import { CanonicalDeliveryService } from './canonical-delivery.service.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = 'cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ARTIFACT_ID = 'cda_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXTERNAL_REF_ID = '42';
const CONNECTOR_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SHIP_EVENT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SHIPPED_AT = '2026-08-17T12:34:56.789Z';

const BASE = `/api/v1/workspaces/${WORKSPACE_ID}/delivery/v2`;

const ENSURE_TASK = `PUT ${BASE}/tasks/:taskId`;
const ATTACH_REF = `POST ${BASE}/tasks/:taskId/external-refs`;
const DETACH_REF = `POST ${BASE}/tasks/:taskId/external-refs/:externalRefId/detach`;
const SHIP_EVIDENCE = `POST ${BASE}/tasks/:taskId/ship-evidence/coredoc`;
const ARTIFACT_REVISION = `PUT ${BASE}/artifacts/:artifactId/revisions`;

interface ExpectedRejection {
  statusCode: number;
  message: string;
  code?: string;
}

type Case = [route: string, label: string, body: unknown, expected: ExpectedRejection];

function rows(route: string, table: Array<[string, unknown, ExpectedRejection]>): Case[] {
  return table.map(([label, body, expected]) => [route, label, body, expected]);
}

const prismaStub = new Proxy(
  {},
  {
    get() {
      throw new Error('Prisma must not be reached by a rejected delivery v2 body');
    },
  },
) as PrismaService;

function validAttach(overrides: Record<string, unknown> = {}) {
  return { provider: 'jira', externalId: '10042', connectorId: CONNECTOR_ID, makeAuthority: false, ...overrides };
}

function validRevision(overrides: Record<string, unknown> = {}) {
  return {
    taskId: TASK_ID,
    repositoryKey: 'coredoc/coredoc-parser',
    kind: 'spec',
    checkpoint: 'run-finish',
    markdown: '# Spec',
    ...overrides,
  };
}

const TABLE: Case[] = [
  ...rows(ENSURE_TASK, [
    ['an array body', [], { statusCode: 400, message: 'delivery task ensure must be an object' }],
    [
      'an unsupported field',
      { externalRefs: [], createdBy: 'connector:1' },
      { statusCode: 400, message: 'Unsupported delivery task ensure field: createdBy' },
    ],
    [
      'an unknown lifecycle',
      { lifecycle: 'archived' },
      { statusCode: 400, message: 'Unsupported delivery task lifecycle: archived' },
    ],
    [
      'a non-string lifecycle',
      { lifecycle: 7 },
      { statusCode: 400, message: 'Unsupported delivery task lifecycle: 7' },
    ],
    [
      'a non-array externalRefs',
      { externalRefs: 'none' },
      { statusCode: 400, message: 'externalRefs must contain at most 32 entries' },
    ],
    [
      'an oversized externalRefs',
      { externalRefs: new Array(33).fill({ provider: 'jira' }) },
      { statusCode: 400, message: 'externalRefs must contain at most 32 entries' },
    ],
    [
      'an invalid repository key',
      { repositoryKey: 'not a repo', externalRefs: [] },
      { statusCode: 400, message: 'repositoryKey must be a normalized repository identifier' },
    ],
    [
      'connector authority',
      { authority: 'connector:jira', externalRefs: [] },
      {
        statusCode: 403,
        code: 'TASK_AUTHORITY_FORBIDDEN',
        message: 'Telemetry task ensure cannot submit connector authority or external references',
      },
    ],
    [
      'client-supplied external references',
      { authority: 'coredoc', externalRefs: [{ provider: 'jira', externalId: '10042' }] },
      {
        statusCode: 403,
        code: 'TASK_AUTHORITY_FORBIDDEN',
        message: 'Telemetry task ensure cannot submit connector authority or external references',
      },
    ],
  ]),
  ...rows(ATTACH_REF, [
    ['an array body', [], { statusCode: 400, message: 'task external reference attach must be an object' }],
    [
      'an unsupported field',
      validAttach({ externalKey: 'CORE-42' }),
      { statusCode: 400, message: 'Unsupported task external reference attach field: externalKey' },
    ],
    [
      'an invalid connector id',
      validAttach({ connectorId: 'connector-1' }),
      { statusCode: 400, message: 'connectorId must be a UUID' },
    ],
    [
      'a non-boolean makeAuthority',
      validAttach({ makeAuthority: 'yes' }),
      { statusCode: 400, message: 'makeAuthority must be a boolean' },
    ],
    [
      'a connector-less authority claim',
      validAttach({ connectorId: null, makeAuthority: true }),
      { statusCode: 400, message: 'A connector-less external reference cannot become lifecycle authority' },
    ],
    [
      'an invalid provider',
      validAttach({ provider: 'Jira Cloud' }),
      { statusCode: 400, message: 'provider must be a compact lowercase adapter key' },
    ],
    [
      'an empty external id',
      validAttach({ externalId: '' }),
      { statusCode: 400, message: 'externalId must contain between 1 and 256 characters' },
    ],
    [
      'an oversized external id',
      validAttach({ externalId: 'x'.repeat(257) }),
      { statusCode: 400, message: 'externalId must contain between 1 and 256 characters' },
    ],
  ]),
  ...rows(DETACH_REF, [
    ['an array body', [], { statusCode: 400, message: 'task external reference detach must be an object' }],
    [
      'an unsupported field',
      { reason: 'cleanup' },
      { statusCode: 400, message: 'Unsupported task external reference detach field: reason' },
    ],
    [
      'a non-object fallback',
      { fallbackAuthority: 'coredoc' },
      { statusCode: 400, message: 'fallbackAuthority must be an object' },
    ],
    [
      'an unknown fallback kind',
      { fallbackAuthority: { kind: 'connector' } },
      { statusCode: 400, message: 'fallbackAuthority kind must be coredoc or external_ref' },
    ],
    [
      'an extra Coredoc fallback field',
      { fallbackAuthority: { kind: 'coredoc', externalRefId: '43' } },
      { statusCode: 400, message: 'Unsupported Coredoc fallback authority field: externalRefId' },
    ],
    [
      'an extra external-ref fallback field',
      { fallbackAuthority: { kind: 'external_ref', externalRefId: '43', provider: 'jira' } },
      { statusCode: 400, message: 'Unsupported external-ref fallback authority field: provider' },
    ],
    [
      'an invalid fallback ref id',
      { fallbackAuthority: { kind: 'external_ref', externalRefId: '0' } },
      { statusCode: 400, message: 'fallbackAuthority.externalRefId must be a positive bounded decimal string' },
    ],
  ]),
  ...rows(SHIP_EVIDENCE, [
    ['an array body', [], { statusCode: 400, message: 'Coredoc ship evidence must be an object' }],
    [
      'an unsupported field',
      { eventId: SHIP_EVENT_ID, shippedAt: SHIPPED_AT, note: 'deployed' },
      { statusCode: 400, message: 'Unsupported Coredoc ship evidence field: note' },
    ],
    ['a missing event id', { shippedAt: SHIPPED_AT }, { statusCode: 400, message: 'eventId must be a UUID' }],
    [
      'an invalid event id',
      { eventId: 'ship-42', shippedAt: SHIPPED_AT },
      { statusCode: 400, message: 'eventId must be a UUID' },
    ],
    [
      'a missing occurrence time',
      { eventId: SHIP_EVENT_ID },
      { statusCode: 400, message: 'shippedAt must be an ISO-8601 timestamp' },
    ],
    [
      'a date-only occurrence time',
      { eventId: SHIP_EVENT_ID, shippedAt: '2026-08-17' },
      { statusCode: 400, message: 'shippedAt must be an ISO-8601 timestamp' },
    ],
    [
      'an impossible calendar day',
      { eventId: SHIP_EVENT_ID, shippedAt: '2026-02-30T12:34:56Z' },
      { statusCode: 400, message: 'shippedAt must be an ISO-8601 timestamp' },
    ],
    [
      'an out-of-range clock',
      { eventId: SHIP_EVENT_ID, shippedAt: '2026-08-17T24:00:00-04:00' },
      { statusCode: 400, message: 'shippedAt must be an ISO-8601 timestamp' },
    ],
  ]),
  ...rows(ARTIFACT_REVISION, [
    ['an array body', [], { statusCode: 400, message: 'Artifact revision body must be an object' }],
    [
      'an unsupported field',
      validRevision({ author: 'me' }),
      { statusCode: 400, message: 'Artifact revision body contains an unsupported field' },
    ],
    [
      'a missing markdown',
      { taskId: TASK_ID, repositoryKey: 'coredoc/coredoc-parser', kind: 'spec', checkpoint: 'run-finish' },
      { statusCode: 400, message: 'Artifact revision body requires markdown' },
    ],
    [
      'an unknown kind',
      validRevision({ kind: 'note' }),
      { statusCode: 400, message: 'kind must be spec, design, or implementation_issue' },
    ],
    [
      'an unknown checkpoint',
      validRevision({ checkpoint: 'mid-run' }),
      { statusCode: 400, message: 'checkpoint must be run-finish, session-end, or session-start-reconcile' },
    ],
    [
      'a non-string markdown',
      validRevision({ markdown: 42 }),
      { statusCode: 400, message: 'markdown must be a string' },
    ],
    [
      'a control character in markdown',
      validRevision({ markdown: 'a\u0001b' }),
      { statusCode: 400, message: 'markdown contains an unsupported control character' },
    ],
    [
      'a lone surrogate in markdown',
      validRevision({ markdown: 'a\ud800b' }),
      { statusCode: 400, message: 'markdown must be well-formed Unicode' },
    ],
    [
      'an invalid run id',
      validRevision({ runId: 'run-1' }),
      { statusCode: 400, message: 'runId must use the canonical cdr-YYYYMMDD-xxxxxx format' },
    ],
    [
      'an invalid body task id',
      validRevision({ taskId: 'task-1' }),
      { statusCode: 400, message: 'taskId must use the canonical cdt_<UUID> format' },
    ],
    [
      'an invalid body repository key',
      validRevision({ repositoryKey: 'not a repo' }),
      { statusCode: 400, message: 'repositoryKey must be a normalized repository identifier' },
    ],
  ]),
];

describe('delivery v2 write-route validation parity', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CanonicalDeliveryController],
      providers: [{ provide: CanonicalDeliveryService, useValue: new CanonicalDeliveryService(prismaStub) }],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const httpRequest = context.switchToHttp().getRequest();
          httpRequest.user = { id: 'actor-1', email: 'pilot@example.com' };
          httpRequest.userWorkspaceRole = 'admin';
          httpRequest.serviceTokenWorkspaceId = WORKSPACE_ID;
          return true;
        },
      })
      .overrideGuard(WorkspaceRoleGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(UserSessionGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new GlobalExceptionFilter(app.get(HttpAdapterHost)));
    await app.init();
    // Bind IPv4 loopback: supertest's ephemeral '::' bind can collide with a 127.0.0.1-only local listener on macOS.
    await app.listen(0, '127.0.0.1');
  });

  afterEach(async () => {
    await app.close();
  });

  it.each(TABLE)('%s rejects %s', async (route, _label, body, expected) => {
    const [method, template] = route.split(' ');
    const path = template
      .replace(':taskId', TASK_ID)
      .replace(':externalRefId', EXTERNAL_REF_ID)
      .replace(':artifactId', ARTIFACT_ID);
    const agent = request(app.getHttpServer());
    const call = method === 'PUT' ? agent.put(path) : agent.post(path);
    const response = await call.send(body as object).expect(expected.statusCode);

    expect({
      statusCode: response.body.statusCode,
      message: response.body.message,
      ...(response.body.code === undefined ? {} : { code: response.body.code }),
    }).toEqual(expected);
  });
});
