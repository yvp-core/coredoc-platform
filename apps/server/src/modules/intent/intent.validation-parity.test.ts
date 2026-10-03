/**
 * Frozen request-validation parity for the intent REST surface, one route per controller.
 *
 * Each row is a bad request captured while the handlers still called `parseContract` themselves,
 * together with the exact `IntentExceptionFilter` body it produced. The table is the guard for
 * moving that call to the controller boundary (`.scratch/server-structure-cleanup/spec.md`,
 * Track B2): it must pass unchanged before and after.
 *
 * The services are stubbed empty, so a row that stops being rejected fails on a missing method
 * instead of silently passing.
 */
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { PermissionsGuard } from '../../auth/permissions.guard.js';
import { UserSessionGuard } from '../../auth/user-session.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { IntentAnchorController } from './intent-anchor.controller.js';
import { IntentAnchorService } from './intent-anchor.service.js';
import { IntentEnabledGuard } from './intent-enabled.guard.js';
import { IntentContextController } from './intent-context.controller.js';
import { IntentContextService } from './intent-context.service.js';
import { IntentImportController } from './intent-import.controller.js';
import { IntentImportService } from './intent-import.service.js';
import { IntentWorkspaceImportService } from './intent-workspace-import.js';
import { IntentItemService } from './intent-item.service.js';
import { IntentReadService } from './intent-read.service.js';
import { IntentHandoffProcessor } from './intent-handoff-processor.service.js';
import { IntentReleaseController } from './intent-release.controller.js';
import { IntentReleaseService } from './intent-release.service.js';
import { IntentReviewController } from './intent-review.controller.js';
import { IntentReviewQueueController } from './intent-review-queue.controller.js';
import { IntentReviewQueueService } from './intent-review-queue.service.js';
import { IntentReviewService } from './intent-review.service.js';
import { IntentTransitionsService } from './intent-transitions.service.js';
import { IntentTreeService } from './intent-tree.service.js';
import { IntentController } from './intent.controller.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const ITEM_ID = 'itm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BASE = `/api/v1/workspaces/${WORKSPACE_ID}/intent`;

interface IntentErrorDetail {
  code: string;
  message: string;
  path: string[];
}

interface ExpectedRejection extends IntentErrorDetail {
  statusCode: number;
  details?: IntentErrorDetail[];
}

type Case = [
  controller: string,
  label: string,
  method: 'GET' | 'POST',
  path: string,
  payload: unknown,
  expected: ExpectedRejection,
];

const TABLE: Case[] = [
  [
    'IntentController',
    'a domain create missing its id and carrying an unknown key',
    'POST',
    `${BASE}/domains`,
    { slug: 'billing', title: 'Billing', idempotencyKey: 'k', surprise: 1 },
    {
      statusCode: 400,
      code: 'schema_violation',
      message: 'Invalid input: expected string, received undefined',
      path: ['id'],
      details: [
        { code: 'schema_violation', message: 'Invalid input: expected string, received undefined', path: ['id'] },
        { code: 'schema_violation', message: 'Unrecognized keys: "slug", "surprise"', path: [] },
      ],
    },
  ],
  [
    'IntentController',
    'a non-numeric tree query limit (rejected after the contract, in the handler)',
    'GET',
    `${BASE}/tree?limit=lots`,
    undefined,
    {
      statusCode: 400,
      code: 'invalid_page_limit',
      message: 'limit must be an integer between 1 and 200',
      path: ['limit'],
    },
  ],
  [
    'IntentAnchorController',
    'an anchor refresh with an unslugged item id and no target',
    'POST',
    `${BASE}/items/${ITEM_ID}/anchors/refresh`,
    { itemId: ITEM_ID, idempotencyKey: 'k' },
    {
      statusCode: 400,
      code: 'schema_violation',
      message: 'id must be a lowercase slug: a-z0-9 words joined by single hyphens',
      path: ['itemId'],
      details: [
        {
          code: 'schema_violation',
          message: 'id must be a lowercase slug: a-z0-9 words joined by single hyphens',
          path: ['itemId'],
        },
        { code: 'schema_violation', message: 'Invalid input: expected string, received undefined', path: ['repoKey'] },
        { code: 'schema_violation', message: 'Invalid input: expected string, received undefined', path: ['nodeId'] },
      ],
    },
  ],
  [
    'IntentContextController',
    'an unrecognized context query key',
    'GET',
    `${BASE}/context?surprise=1`,
    undefined,
    {
      statusCode: 400,
      code: 'schema_violation',
      message: 'Unrecognized key: "surprise"',
      path: [],
    },
  ],
  [
    'IntentContextController',
    'a context parameter that is not JSON',
    'GET',
    `${BASE}/context?context=not-json`,
    undefined,
    {
      statusCode: 400,
      code: 'schema_violation',
      message: 'Each context parameter is a JSON object of dimension ids to value ids',
      path: ['context'],
    },
  ],
  [
    'IntentContextController',
    'a context parameter longer than its byte bound',
    'GET',
    `${BASE}/context?context=${'x'.repeat(4001)}`,
    undefined,
    {
      statusCode: 400,
      code: 'schema_violation',
      message: 'Too big: expected string to have <=4000 characters',
      path: ['context'],
    },
  ],
  [
    'IntentContextController',
    'a context parameter within the character bound but over its byte bound',
    'GET',
    `${BASE}/context?context=${encodeURIComponent('é'.repeat(2001))}`,
    undefined,
    {
      statusCode: 400,
      code: 'schema_violation',
      message: 'context accepts at most 4000 bytes of JSON',
      path: ['context'],
    },
  ],
  [
    'IntentContextController',
    'a context parameter that is a JSON array',
    'GET',
    `${BASE}/context?context=${encodeURIComponent('["de"]')}`,
    undefined,
    {
      statusCode: 400,
      code: 'schema_violation',
      message: 'Invalid input: expected record, received array',
      path: ['context'],
    },
  ],
  [
    'IntentImportController',
    'an import overlay that is not an object',
    'POST',
    `${BASE}/import`,
    [],
    {
      statusCode: 400,
      code: 'schema_violation',
      message: 'Invalid input: expected object, received array',
      path: [],
    },
  ],
  [
    'IntentReleaseController',
    'a release batch preview with an unslugged id and an unknown key',
    'POST',
    `${BASE}/items/release-preview`,
    { itemIds: [ITEM_ID], surprise: 1 },
    {
      statusCode: 400,
      code: 'schema_violation',
      message: 'id must be a lowercase slug: a-z0-9 words joined by single hyphens',
      path: ['itemIds', '0'],
      details: [
        {
          code: 'schema_violation',
          message: 'id must be a lowercase slug: a-z0-9 words joined by single hyphens',
          path: ['itemIds', '0'],
        },
        { code: 'schema_violation', message: 'Unrecognized key: "surprise"', path: [] },
      ],
    },
  ],
  [
    'IntentReviewController',
    'a review batch with no decisions, no authorizing source and an unknown key',
    'POST',
    `${BASE}/items/review`,
    { decisions: [], idempotencyKey: 'k', surprise: 1 },
    {
      statusCode: 400,
      code: 'schema_violation',
      message: 'Invalid input: expected object, received undefined',
      path: ['authorizingSource'],
      details: [
        {
          code: 'schema_violation',
          message: 'Invalid input: expected object, received undefined',
          path: ['authorizingSource'],
        },
        { code: 'schema_violation', message: 'Too small: expected array to have >=1 items', path: ['decisions'] },
        { code: 'schema_violation', message: 'Unrecognized key: "surprise"', path: [] },
      ],
    },
  ],
  [
    'IntentReviewQueueController',
    'an unrecognized review-queue query key',
    'GET',
    `${BASE}/review-queue?surprise=1`,
    undefined,
    {
      statusCode: 400,
      code: 'schema_violation',
      message: 'Unrecognized key: "surprise"',
      path: [],
    },
  ],
];

describe('intent request-validation parity', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        IntentController,
        IntentAnchorController,
        IntentContextController,
        IntentImportController,
        IntentReleaseController,
        IntentReviewController,
        IntentReviewQueueController,
      ],
      providers: [
        IntentTreeService,
        IntentItemService,
        IntentReadService,
        IntentAnchorService,
        IntentContextService,
        IntentImportService,
        IntentWorkspaceImportService,
        IntentReleaseService,
        IntentHandoffProcessor,
        IntentReviewService,
        IntentTransitionsService,
        IntentReviewQueueService,
        // Empty stubs: a row that stops being rejected calls a method that is not there and
        // fails with a TypeError rather than silently passing.
      ].map((provide) => ({ provide, useValue: {} })),
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const httpRequest = context.switchToHttp().getRequest();
          httpRequest.user = { id: 'actor-1', email: 'pilot@example.com' };
          httpRequest.userWorkspaceRole = 'admin';
          return true;
        },
      })
      .overrideGuard(WorkspaceRoleGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(UserSessionGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(IntentEnabledGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    // Bind IPv4 loopback: supertest's ephemeral '::' bind can collide with a 127.0.0.1-only local listener on macOS.
    await app.listen(0, '127.0.0.1');
  });

  afterEach(async () => {
    await app.close();
  });

  it.each(TABLE)('%s rejects %s', async (_controller, _label, method, path, payload, expected) => {
    const agent = request(app.getHttpServer());
    const call = method === 'GET' ? agent.get(path) : agent.post(path).send(payload as object);
    const response = await call.expect(expected.statusCode);

    expect({
      statusCode: response.body.statusCode,
      code: response.body.code,
      message: response.body.message,
      path: response.body.path,
      ...(response.body.details === undefined ? {} : { details: response.body.details }),
    }).toEqual(expected);
  });
});
