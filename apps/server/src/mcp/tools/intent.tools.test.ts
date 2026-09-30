import type { IntentHandoffService } from '../../modules/intent/intent-handoff.service.js';
import type { IntentReleaseService } from '../../modules/intent/intent-release.service.js';
/**
 * The intent tools' contract: gates, typed states, selector parity with
 * REST, and untruncated error passthrough (spec §11/§12).
 *
 * Services are mocked. What is under test here is the tool layer itself — who
 * is allowed in, what a refusal looks like, which normalised request reaches
 * the service — not the intent services, which have their own unit and Postgres
 * integration suites.
 */
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { IntentKind, IntentSourceKind } from '@coredoc/core';
import { TokenPermission } from '../../auth/token-permissions.js';
import { PrismaService } from '../../database/prisma.service.js';
import { WorkspaceMemberRole } from '../../modules/members/dto/workspace-role.enum.js';
import type { MetricsService } from '../../modules/metrics/metrics.service.js';
import { IntentErrorCode, type IntentPublicException, parseContract } from '../../modules/intent/contract/index.js';
import {
  IntentContextMode,
  IntentContextQuerySchema,
  type IntentContextRequest,
  normalizeIntentContextRequest,
} from '../../modules/intent/intent-context.operations.js';
import type { IntentAnchorService } from '../../modules/intent/intent-anchor.service.js';
import type { IntentContextService } from '../../modules/intent/intent-context.service.js';
import type { IntentProposeService } from '../../modules/intent/intent-propose.service.js';
import type { IntentReviewService } from '../../modules/intent/intent-review.service.js';
import type { IntentTreeService } from '../../modules/intent/intent-tree.service.js';
import type { IntentItemService } from '../../modules/intent/intent-item.service.js';
import { McpAuthKind } from '../mcp-auth-context.js';
import { McpModule } from '../mcp.module.js';
import {
  IntentAnchorAction,
  IntentToolStatus,
  IntentTools,
  IntentTreeAction,
  NOT_CONFIGURED_MESSAGE,
} from './intent.tools.js';

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';

function mocks() {
  return {
    context: { read: vi.fn().mockResolvedValue({ mode: IntentContextMode.Context, matches: [] }) },
    propose: { propose: vi.fn().mockResolvedValue({ items: [] }) },
    review: { review: vi.fn().mockResolvedValue({ decisions: [] }) },
    tree: {
      hasIntentContent: vi.fn().mockResolvedValue(false),
      getTree: vi.fn().mockResolvedValue({ domains: [], nextCursor: null }),
      createDomain: vi.fn().mockResolvedValue({ id: 'payments', version: 1 }),
      updateDomain: vi.fn().mockResolvedValue({ id: 'payments' }),
      archiveDomain: vi.fn().mockResolvedValue({ id: 'payments' }),
      deleteDomain: vi.fn().mockResolvedValue({ id: 'payments' }),
      createFeature: vi.fn().mockResolvedValue({ id: 'refunds' }),
      updateFeature: vi.fn().mockResolvedValue({ id: 'refunds' }),
      archiveFeature: vi.fn().mockResolvedValue({ id: 'refunds' }),
      deleteFeature: vi.fn().mockResolvedValue({ id: 'refunds' }),
      putSeed: vi.fn().mockResolvedValue({ featureId: 'refunds' }),
      deleteSeed: vi.fn().mockResolvedValue({ featureId: 'refunds' }),
      createDimension: vi.fn().mockResolvedValue({ dimension: { id: 'country' } }),
    },
    anchors: {
      preview: vi.fn().mockResolvedValue({ wouldCreate: true, drifted: false }),
      add: vi.fn().mockResolvedValue({ created: true }),
      refresh: vi.fn().mockResolvedValue({ changed: true }),
      remove: vi.fn().mockResolvedValue({ removed: true }),
    },
    releases: {
      preview: vi.fn().mockResolvedValue({ itemId: 'br-rule', headSeq: 0 }),
      list: vi.fn().mockResolvedValue({ entries: [], headSeq: 0 }),
      record: vi.fn().mockResolvedValue({ headSeq: 1 }),
    },
    handoffs: {
      save: vi.fn().mockResolvedValue({ id: '22222222-2222-4222-8222-222222222222', version: 1 }),
      get: vi.fn().mockResolvedValue({}),
      list: vi.fn().mockResolvedValue({ operations: [] }),
    },
    items: { updateSource: vi.fn().mockResolvedValue({ ref: 'confluence:1', items: ['br-rule'] }) },
    metrics: { recordMcpQuery: vi.fn().mockResolvedValue(undefined) },
  };
}

type Mocks = ReturnType<typeof mocks>;

function build(m: Mocks): IntentTools {
  return new IntentTools(
    m.context as unknown as IntentContextService,
    m.propose as unknown as IntentProposeService,
    m.review as unknown as IntentReviewService,
    m.tree as unknown as IntentTreeService,
    m.anchors as unknown as IntentAnchorService,
    m.metrics as unknown as MetricsService,
    m.releases as unknown as IntentReleaseService,
    m.handoffs as unknown as IntentHandoffService,
    m.items as unknown as IntentItemService,
  );
}

/** A workspace that already holds intent content, so `not_configured` is out of the way. */
function configured(m: Mocks): void {
  m.tree.hasIntentContent.mockResolvedValue(true);
}

function userReq(role: WorkspaceMemberRole = WorkspaceMemberRole.Member): Request {
  return {
    workspaceId: WORKSPACE_ID,
    user: { id: 'user_1' },
    userWorkspaceRole: role,
    mcpAuthKind: McpAuthKind.Jwt,
  } as unknown as Request;
}

function tokenReq(permissions: string[], role: WorkspaceMemberRole = WorkspaceMemberRole.Owner): Request {
  return {
    workspaceId: WORKSPACE_ID,
    user: { id: 'token_creator' },
    userWorkspaceRole: role,
    mcpAuthKind: McpAuthKind.ServiceToken,
    serviceTokenPermissions: permissions,
  } as unknown as Request;
}

/** A request that never passed the middleware — no server-set trusted context. */
function untrustedReq(): Request {
  return {} as unknown as Request;
}

function read(result: { content: { type: 'text'; text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? 'null') as Record<string, unknown>;
}

const PROPOSAL = {
  idempotencyKey: 'idem-propose-1',
  items: [
    {
      kind: IntentKind.BusinessRule,
      title: 'Refunds close after 30 days',
      statement: 'A refund request is refused once the order is older than thirty days.',
      sources: [{ kind: IntentSourceKind.Spec, ref: 'docs/spec.md', localId: 'br-refund-window' }],
    },
  ],
};

const REVIEW = {
  idempotencyKey: 'idem-review-1',
  authorizingSource: {
    kind: 'spec' as const,
    ref: 'docs/spec.md',
    localId: 'review-pass-1',
    revision: 'sha256:reviewed-content',
  },
  decisions: [
    {
      itemId: 'br-refund-window',
      expectedVersion: 1,
      action: 'accept' as const,
      reason: 'Matches the shipped behaviour.',
    },
  ],
};

const DOMAIN_CREATE = { idempotencyKey: 'idem-tree-1', id: 'payments', title: 'Payments' };

const ANCHOR_IDENTITY = {
  itemId: 'br-refund-window',
  repoKey: 'github.com/acme/orders',
  nodeId: 'abcdef1234:function:src/refund.ts:refund',
};
const ANCHOR_WRITE = { idempotencyKey: 'idem-anchor-1', ...ANCHOR_IDENTITY };

describe('intent tools — registration', () => {
  /**
   * The tools are ALWAYS registered (spec §11), and every service they inject
   * has to be reachable from `McpModule`. Both facts only fail at boot
   * otherwise: the unit tests below construct the class by hand and would stay
   * green with a broken module graph.
   */
  it('compiles McpModule and resolves IntentTools with no env gate', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [McpModule] })
      .overrideProvider(PrismaService)
      .useValue({} as PrismaService)
      .compile();

    expect(moduleRef.get(IntentTools)).toBeInstanceOf(IntentTools);
    await moduleRef.close();
  });
});

describe('intent tools — gate matrix', () => {
  let m: Mocks;
  let tools: IntentTools;

  beforeEach(() => {
    m = mocks();
    configured(m);
    tools = build(m);
  });

  it('serves get_intent_context to a service token carrying intent:read', async () => {
    const answer = read(await tools.getIntentContext({}, {} as never, tokenReq([TokenPermission.IntentRead])));
    expect(answer.status).toBeUndefined();
    expect(m.context.read).toHaveBeenCalledTimes(1);
  });

  it('serves get_intent_context to a plain member session — membership is the read gate', async () => {
    const answer = read(await tools.getIntentContext({}, {} as never, userReq(WorkspaceMemberRole.Member)));
    expect(answer.status).toBeUndefined();
  });

  it('refuses get_intent_context for a token without intent:read, naming the permission', async () => {
    const answer = read(await tools.getIntentContext({}, {} as never, tokenReq([TokenPermission.IntentPropose])));
    expect(answer.status).toBe(IntentToolStatus.PermissionDenied);
    expect(answer.requires).toEqual({ permission: TokenPermission.IntentRead });
    expect(m.context.read).not.toHaveBeenCalled();
  });

  it('lets a propose-scoped token propose, auditing it as the machine it is', async () => {
    const answer = read(await tools.intentPropose(PROPOSAL, {} as never, tokenReq([TokenPermission.IntentPropose])));
    expect(answer.status).toBeUndefined();
    // NOT the token creator's `owner` membership: a service token's audit role
    // is its own kind, or the trail attributes machine writes to a human.
    expect(m.propose.propose).toHaveBeenCalledWith(
      WORKSPACE_ID,
      { id: 'token_creator', role: 'service_token' },
      PROPOSAL,
    );
  });

  it('refuses propose for a read-only token, naming intent:propose', async () => {
    const answer = read(await tools.intentPropose(PROPOSAL, {} as never, tokenReq([TokenPermission.IntentRead])));
    expect(answer.status).toBe(IntentToolStatus.PermissionDenied);
    expect(answer.requires).toEqual({ permission: TokenPermission.IntentPropose });
    expect(m.propose.propose).not.toHaveBeenCalled();
  });

  it.each([
    ['intent_review', (t: IntentTools, r: Request) => t.intentReview(REVIEW, {} as never, r)],
    ...(['record', 'rollback', 'plan', 'withdraw', 'reinstate'] as const).map(
      (action) =>
        [
          `intent_release.${action}`,
          (t: IntentTools, r: Request) => t.intentRelease({ action, request: {} }, {} as never, r),
        ] as const,
    ),
    [
      'intent_tree',
      (t: IntentTools, r: Request) =>
        t.intentTree({ action: IntentTreeAction.DomainCreate, request: DOMAIN_CREATE }, {} as never, r),
    ],
    [
      'intent_anchor',
      (t: IntentTools, r: Request) =>
        t.intentAnchor({ action: IntentAnchorAction.Add, request: ANCHOR_WRITE }, {} as never, r),
    ],
  ])('refuses %s for an omnipotent service token — no machine path to authority', async (_name, call) => {
    const request = tokenReq([TokenPermission.IntentRead, TokenPermission.IntentPropose, '*', 'token:manage']);
    const answer = read(await call(tools, request));
    expect(answer.status).toBe(IntentToolStatus.PermissionDenied);
    expect(answer.requires).toEqual({
      userSession: true,
      roles: [WorkspaceMemberRole.Owner, WorkspaceMemberRole.Admin, WorkspaceMemberRole.Member],
    });
    expect(answer.message).toMatch(/user session, not a service token/);
    expect(m.review.review).not.toHaveBeenCalled();
    expect(m.tree.createDomain).not.toHaveBeenCalled();
    expect(m.anchors.add).not.toHaveBeenCalled();
  });

  it.each([
    ['intent_review', (t: IntentTools, r: Request) => t.intentReview(REVIEW, {} as never, r)],
    ...(['record', 'rollback', 'plan', 'withdraw', 'reinstate'] as const).map(
      (action) =>
        [
          `intent_release.${action}`,
          (t: IntentTools, r: Request) => t.intentRelease({ action, request: {} }, {} as never, r),
        ] as const,
    ),
    [
      'intent_tree',
      (t: IntentTools, r: Request) =>
        t.intentTree({ action: IntentTreeAction.DomainCreate, request: DOMAIN_CREATE }, {} as never, r),
    ],
    [
      'intent_anchor',
      (t: IntentTools, r: Request) =>
        t.intentAnchor({ action: IntentAnchorAction.Refresh, request: ANCHOR_WRITE }, {} as never, r),
    ],
  ])('does not refuse %s for a member session (BR-1)', async (_name, call) => {
    configured(m);
    const answer = read(await call(tools, userReq(WorkspaceMemberRole.Member)));
    expect(answer.status).not.toBe(IntentToolStatus.PermissionDenied);
  });

  it.each([
    WorkspaceMemberRole.Admin,
    WorkspaceMemberRole.Owner,
    WorkspaceMemberRole.Member,
  ])('admits a %s session to review', async (role) => {
    const answer = read(await tools.intentReview(REVIEW, {} as never, userReq(role)));
    expect(answer.status).toBeUndefined();
    expect(m.review.review).toHaveBeenCalledWith(WORKSPACE_ID, { id: 'user_1', role }, REVIEW);
  });

  it.each([
    WorkspaceMemberRole.Admin,
    WorkspaceMemberRole.Owner,
    WorkspaceMemberRole.Member,
  ])('admits a %s session to the tree', async (role) => {
    const answer = read(
      await tools.intentTree(
        { action: IntentTreeAction.DomainCreate, request: DOMAIN_CREATE },
        {} as never,
        userReq(role),
      ),
    );
    expect(answer.status).toBeUndefined();
    expect(m.tree.createDomain).toHaveBeenCalledWith(WORKSPACE_ID, { id: 'user_1', role }, DOMAIN_CREATE);
  });

  // Preview writes nothing and returns graph facts a member can already read,
  // so REST gates it at `intent:read` — the tool must not be stricter, or the
  // preview-before-write rule stops being reachable from a read-scoped session.
  it('serves intent_anchor preview to a service token carrying intent:read', async () => {
    const answer = read(
      await tools.intentAnchor(
        { action: IntentAnchorAction.Preview, request: ANCHOR_IDENTITY },
        {} as never,
        tokenReq([TokenPermission.IntentRead]),
      ),
    );
    expect(answer.status).toBeUndefined();
    expect(m.anchors.preview).toHaveBeenCalledWith(WORKSPACE_ID, ANCHOR_IDENTITY);
  });

  it('serves intent_anchor preview to a plain member session', async () => {
    const answer = read(
      await tools.intentAnchor(
        { action: IntentAnchorAction.Preview, request: ANCHOR_IDENTITY },
        {} as never,
        userReq(WorkspaceMemberRole.Member),
      ),
    );
    expect(answer.status).toBeUndefined();
  });

  it('refuses intent_anchor preview for a token without intent:read, naming the permission', async () => {
    const answer = read(
      await tools.intentAnchor(
        { action: IntentAnchorAction.Preview, request: ANCHOR_IDENTITY },
        {} as never,
        tokenReq([TokenPermission.IntentPropose]),
      ),
    );
    expect(answer.status).toBe(IntentToolStatus.PermissionDenied);
    expect(answer.requires).toEqual({ permission: TokenPermission.IntentRead });
    expect(m.anchors.preview).not.toHaveBeenCalled();
  });

  it.each([
    WorkspaceMemberRole.Admin,
    WorkspaceMemberRole.Owner,
    WorkspaceMemberRole.Member,
  ])('admits a %s session to an anchor write', async (role) => {
    const answer = read(
      await tools.intentAnchor({ action: IntentAnchorAction.Add, request: ANCHOR_WRITE }, {} as never, userReq(role)),
    );
    expect(answer.status).toBeUndefined();
    expect(m.anchors.add).toHaveBeenCalledWith(WORKSPACE_ID, { id: 'user_1', role }, ANCHOR_WRITE);
  });

  it('refuses every tool on a request with no server-set trusted context', async () => {
    const calls: Array<Promise<{ content: { type: 'text'; text: string }[] }>> = [
      tools.getIntentContext({}, {} as never, untrustedReq()),
      tools.intentPropose(PROPOSAL, {} as never, untrustedReq()),
      tools.intentReview(REVIEW, {} as never, untrustedReq()),
      tools.intentTree({ action: IntentTreeAction.DomainCreate, request: DOMAIN_CREATE }, {} as never, untrustedReq()),
      tools.intentAnchor({ action: IntentAnchorAction.Preview, request: ANCHOR_IDENTITY }, {} as never, untrustedReq()),
      tools.intentAnchor({ action: IntentAnchorAction.Add, request: ANCHOR_WRITE }, {} as never, untrustedReq()),
    ];
    for (const call of calls) {
      const answer = read(await call);
      expect(answer.status).toBe(IntentToolStatus.PermissionDenied);
      expect(answer.message).toMatch(/Trusted MCP workspace identity/);
    }
  });
});

describe('intent tools — not_configured', () => {
  let m: Mocks;
  let tools: IntentTools;

  beforeEach(() => {
    m = mocks();
    tools = build(m);
  });

  it('answers a workspace with no domains and no items with the typed state', async () => {
    const answers = [
      read(await tools.getIntentContext({}, {} as never, userReq(WorkspaceMemberRole.Owner))),
      read(await tools.intentPropose(PROPOSAL, {} as never, userReq(WorkspaceMemberRole.Owner))),
      read(await tools.intentReview(REVIEW, {} as never, userReq(WorkspaceMemberRole.Owner))),
      read(
        await tools.intentTree(
          {
            action: IntentTreeAction.FeatureCreate,
            request: { idempotencyKey: 'k', id: 'refunds', domainId: 'payments', title: 'Refunds' },
          },
          {} as never,
          userReq(WorkspaceMemberRole.Owner),
        ),
      ),
      read(
        await tools.intentAnchor(
          { action: IntentAnchorAction.Preview, request: ANCHOR_IDENTITY },
          {} as never,
          userReq(WorkspaceMemberRole.Owner),
        ),
      ),
      ...(await Promise.all(
        [IntentAnchorAction.Add, IntentAnchorAction.Refresh, IntentAnchorAction.Remove].map(async (action) =>
          read(
            await tools.intentAnchor(
              { action, request: ANCHOR_WRITE },
              {} as never,
              userReq(WorkspaceMemberRole.Owner),
            ),
          ),
        ),
      )),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(IntentToolStatus.NotConfigured);
      expect(answer.message).toBe(NOT_CONFIGURED_MESSAGE);
    }
    expect(m.propose.propose).not.toHaveBeenCalled();
    expect(m.review.review).not.toHaveBeenCalled();
    expect(m.tree.createFeature).not.toHaveBeenCalled();
    for (const call of [m.anchors.preview, m.anchors.add, m.anchors.refresh, m.anchors.remove]) {
      expect(call).not.toHaveBeenCalled();
    }
  });

  // Gating this one would make the state permanent — the bootstrap has to land.
  it('still performs domain.create, the action that ends the state', async () => {
    const answer = read(
      await tools.intentTree(
        { action: IntentTreeAction.DomainCreate, request: DOMAIN_CREATE },
        {} as never,
        userReq(WorkspaceMemberRole.Owner),
      ),
    );
    expect(answer.status).toBeUndefined();
    expect(m.tree.createDomain).toHaveBeenCalledTimes(1);
  });

  // Dimensions are declared before any item can condition on them, so they bootstrap too.
  it('still performs dimension.create on an empty workspace', async () => {
    const answer = read(
      await tools.intentTree(
        {
          action: IntentTreeAction.DimensionCreate,
          request: {
            idempotencyKey: 'idem-dim-1',
            id: 'country',
            title: 'Country',
            values: [{ id: 'de', title: 'DE' }],
          },
        },
        {} as never,
        userReq(WorkspaceMemberRole.Owner),
      ),
    );
    expect(answer.status).toBeUndefined();
    expect(m.tree.createDimension).toHaveBeenCalledTimes(1);
  });

  // Archiving is a visibility state, not a deletion: the workspace is configured.
  it('does not call a workspace with only archived domains unconfigured', async () => {
    m.tree.hasIntentContent.mockResolvedValue(true);
    const answer = read(await tools.intentReview(REVIEW, {} as never, userReq(WorkspaceMemberRole.Admin)));
    expect(answer.status).toBeUndefined();
  });

  it('is a state, not an empty answer: a configured workspace with no match returns the read', async () => {
    m.tree.hasIntentContent.mockResolvedValue(true);
    const answer = read(await tools.getIntentContext({}, {} as never, userReq()));
    expect(answer.status).toBeUndefined();
    expect(answer.matches).toEqual([]);
  });

  it('never probes for content when the read already returned something', async () => {
    m.context.read.mockResolvedValue({ mode: IntentContextMode.Context, matches: [{ id: 'br-refund-window' }] });
    const answer = read(await tools.getIntentContext({}, {} as never, userReq()));
    expect(answer.status).toBeUndefined();
    expect(m.tree.hasIntentContent).not.toHaveBeenCalled();
  });

  it('probes with the cheap EXISTS predicate, never by paging the tree', async () => {
    read(await tools.getIntentContext({}, {} as never, userReq()));
    expect(m.tree.hasIntentContent).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(m.tree.getTree).not.toHaveBeenCalled();
  });

  // The body is validated BEFORE not_configured (issue 08): a malformed body
  // must fail with its own schema error even against an empty workspace,
  // rather than being masked by a state check that never looked at the body.
  it('intent_propose: a malformed body fails with its own schema error, not not_configured', async () => {
    const answer = read(
      await tools.intentPropose({ ...PROPOSAL, items: [] }, {} as never, userReq(WorkspaceMemberRole.Owner)),
    );
    expect(answer.status).toBe(IntentToolStatus.Error);
    expect(m.tree.hasIntentContent).not.toHaveBeenCalled();
    expect(m.propose.propose).not.toHaveBeenCalled();
  });

  it('intent_review: a malformed body fails with its own schema error, not not_configured', async () => {
    const answer = read(
      await tools.intentReview({ ...REVIEW, decisions: [] }, {} as never, userReq(WorkspaceMemberRole.Owner)),
    );
    expect(answer.status).toBe(IntentToolStatus.Error);
    expect(m.tree.hasIntentContent).not.toHaveBeenCalled();
    expect(m.review.review).not.toHaveBeenCalled();
  });

  it('intent_anchor add: a malformed body fails with its own schema error, not not_configured', async () => {
    const answer = read(
      await tools.intentAnchor(
        { action: IntentAnchorAction.Add, request: { ...ANCHOR_WRITE, nodeId: undefined } },
        {} as never,
        userReq(WorkspaceMemberRole.Owner),
      ),
    );
    expect(answer.status).toBe(IntentToolStatus.Error);
    expect(m.tree.hasIntentContent).not.toHaveBeenCalled();
    expect(m.anchors.add).not.toHaveBeenCalled();
  });

  it('intent_anchor preview: a malformed body fails with its own schema error, not not_configured', async () => {
    const answer = read(
      await tools.intentAnchor(
        { action: IntentAnchorAction.Preview, request: { ...ANCHOR_IDENTITY, nodeId: undefined } },
        {} as never,
        userReq(WorkspaceMemberRole.Owner),
      ),
    );
    expect(answer.status).toBe(IntentToolStatus.Error);
    expect(m.tree.hasIntentContent).not.toHaveBeenCalled();
    expect(m.anchors.preview).not.toHaveBeenCalled();
  });
});

describe('get_intent_context — selector passthrough', () => {
  let m: Mocks;
  let tools: IntentTools;

  beforeEach(() => {
    m = mocks();
    configured(m);
    tools = build(m);
  });

  it('accepts the same multiline task as REST', async () => {
    const task = 'Update the hosted graph query to respect repository scope.\n'.repeat(12).trim();
    await tools.getIntentContext({ task }, {} as never, userReq());
    expect(m.context.read).toHaveBeenCalledWith(
      WORKSPACE_ID,
      expect.objectContaining({ task: task.replace(/\n/g, ' ') }),
    );
  });

  it('fuses task text, touched files and known ids in one request', async () => {
    const input = {
      task: 'Add refund handling without bypassing the administrator guard.',
      files: [{ repoKey: 'github.com/acme/orders', path: 'src/refund.ts' }],
      intentIds: ['br-refund-window'],
      nodeIds: [],
      domain: 'payments',
    };
    await tools.getIntentContext(input, {} as never, userReq());
    expect(m.context.read).toHaveBeenCalledWith(WORKSPACE_ID, expect.objectContaining(input));
  });

  it('hands the service the same normalised request the REST route builds', async () => {
    await tools.getIntentContext(
      {
        mode: IntentContextMode.List,
        intentIds: ['br-refund-window'],
        nodeIds: ['function:src/refund.ts:refund'],
        domain: 'payments',
        feature: 'refunds',
        kind: IntentKind.BusinessRule,
        includeCandidates: true,
        includeDiagnostics: true,
        limit: 25,
        observed: ['github.com/acme/orders@ABCDEF1234567:dirty'],
      },
      {} as never,
      userReq(),
    );

    const [workspaceId, request] = m.context.read.mock.calls[0] as [string, IntentContextRequest];
    expect(workspaceId).toBe(WORKSPACE_ID);
    expect(request).toEqual({
      mode: IntentContextMode.List,
      intentIds: ['br-refund-window'],
      nodeIds: ['function:src/refund.ts:refund'],
      domain: 'payments',
      feature: 'refunds',
      kinds: [IntentKind.BusinessRule],
      includeCandidates: true,
      includeDiagnostics: true,
      limit: 25,
      observed: { 'github.com/acme/orders': { commit: 'abcdef1234567', dirty: true } },
    });
  });

  // The narrowest possible question must not be answered with the widest
  // possible answer.
  it('keeps a present-but-empty selector present', async () => {
    await tools.getIntentContext({ intentIds: [], nodeIds: [] }, {} as never, userReq());
    const [, request] = m.context.read.mock.calls[0] as [string, IntentContextRequest];
    expect(request.intentIds).toEqual([]);
    expect(request.nodeIds).toEqual([]);
  });

  it('passes sourceRefs through and refuses more than the bound with a path', async () => {
    await tools.getIntentContext({ sourceRefs: ['jira:DAY-123', 'spec/ordering.md'] }, {} as never, userReq());
    const [, request] = m.context.read.mock.calls[0] as [string, IntentContextRequest];
    expect(request.sourceRefs).toEqual(['jira:DAY-123', 'spec/ordering.md']);

    const refs = Array.from({ length: 11 }, (_, index) => `jira:DAY-${index}`);
    const answer = read(await tools.getIntentContext({ sourceRefs: refs }, {} as never, userReq()));
    const error = answer.error as { code: string; path: string[] };
    expect(error.code).toBe(IntentErrorCode.SchemaViolation);
    expect(error.path).toEqual(['sourceRefs']);
    expect(m.context.read).toHaveBeenCalledTimes(1);
  });

  it('defaults to context mode with accepted intent only', async () => {
    await tools.getIntentContext({}, {} as never, userReq());
    const [, request] = m.context.read.mock.calls[0] as [string, IntentContextRequest];
    expect(request.mode).toBe(IntentContextMode.Context);
    expect(request.includeCandidates).toBe(false);
    expect(request.observed).toEqual({});
  });

  it('validates a kind list the way REST validates the same kinds', async () => {
    const rest = (kind: string | string[]) => {
      try {
        return normalizeIntentContextRequest(parseContract(IntentContextQuerySchema, { kind })).kinds;
      } catch (error) {
        return (error as IntentPublicException).publicError;
      }
    };
    const mcp = async (kind: string | string[]) => {
      m.context.read.mockClear();
      const answer = read(await tools.getIntentContext({ kind }, {} as never, userReq()));
      return answer.status === IntentToolStatus.Error
        ? answer.error
        : (m.context.read.mock.calls[0] as [string, IntentContextRequest])[1].kinds;
    };
    for (const kind of [
      IntentKind.BusinessRule,
      [IntentKind.UseCase, IntentKind.BusinessRule],
      [IntentKind.UseCase, 'rules'],
      [],
      [...Object.values(IntentKind), IntentKind.UseCase],
    ]) {
      expect(await mcp(kind), JSON.stringify(kind)).toEqual(rest(kind));
    }
  });

  it('refuses an unknown kind by name rather than reporting a miss', async () => {
    const answer = read(await tools.getIntentContext({ kind: 'rules' }, {} as never, userReq()));
    expect(answer.status).toBe(IntentToolStatus.Error);
    expect((answer.error as { code: string }).code).toBe('unknown_kind');
    expect((answer.error as { message: string }).message).toContain('business_rule');
    expect(m.context.read).not.toHaveBeenCalled();
  });
});

describe('intent_anchor — action dispatch', () => {
  let m: Mocks;
  let tools: IntentTools;

  beforeEach(() => {
    m = mocks();
    configured(m);
    tools = build(m);
  });

  it.each([
    [IntentAnchorAction.Add, 'add' as const],
    [IntentAnchorAction.Refresh, 'refresh' as const],
    [IntentAnchorAction.Remove, 'remove' as const],
  ])('routes %s to the shared REST operation schema and its service call', async (action, method) => {
    const answer = read(
      await tools.intentAnchor({ action, request: ANCHOR_WRITE }, {} as never, userReq(WorkspaceMemberRole.Owner)),
    );
    expect(answer.status).toBeUndefined();
    expect(m.anchors[method]).toHaveBeenCalledWith(WORKSPACE_ID, { id: 'user_1', role: 'owner' }, ANCHOR_WRITE);
    for (const other of ['add', 'refresh', 'remove'] as const) {
      if (other !== method) expect(m.anchors[other]).not.toHaveBeenCalled();
    }
  });

  // Preview is a read: no idempotency key in its shape, and none spent.
  it('refuses an idempotencyKey on preview — the read spends no key', async () => {
    const answer = read(
      await tools.intentAnchor(
        { action: IntentAnchorAction.Preview, request: ANCHOR_WRITE },
        {} as never,
        userReq(WorkspaceMemberRole.Owner),
      ),
    );
    expect(answer.status).toBe(IntentToolStatus.Error);
    expect((answer.error as { code: string }).code).toBe(IntentErrorCode.SchemaViolation);
    expect(m.anchors.preview).not.toHaveBeenCalled();
  });

  // Graph facts are the server's answer, never the caller's claim — and the
  // refusal is the REST contract's own, because it is the same schema.
  it('refuses a caller-supplied node type, naming the key', async () => {
    const answer = read(
      await tools.intentAnchor(
        { action: IntentAnchorAction.Add, request: { ...ANCHOR_WRITE, nodeType: 'function' } },
        {} as never,
        userReq(WorkspaceMemberRole.Owner),
      ),
    );
    const error = answer.error as { code: string; message: string };
    expect(error.code).toBe(IntentErrorCode.SchemaViolation);
    expect(error.message).toContain('nodeType');
    expect(m.anchors.add).not.toHaveBeenCalled();
  });

  it('refuses an unknown anchor action with the full valid list', async () => {
    const answer = read(
      await tools.intentAnchor(
        { action: 'anchor.add', request: ANCHOR_WRITE },
        {} as never,
        userReq(WorkspaceMemberRole.Owner),
      ),
    );
    const error = answer.error as { code: string; message: string; path: string[] };
    expect(answer.status).toBe(IntentToolStatus.Error);
    expect(error.path).toEqual(['action']);
    for (const action of Object.values(IntentAnchorAction)) expect(error.message).toContain(action);
    expect(error.message).not.toMatch(/…$/);
  });
});

describe('intent tools — error passthrough (§12)', () => {
  let m: Mocks;
  let tools: IntentTools;

  beforeEach(() => {
    m = mocks();
    configured(m);
    tools = build(m);
  });

  it('surfaces a content violation with its code and exact path, untruncated', async () => {
    const proposal = {
      ...PROPOSAL,
      items: [{ ...PROPOSAL.items[0], rationale: 'Raised by owner@example.com in review.' }],
    };
    const answer = read(await tools.intentPropose(proposal, {} as never, userReq()));
    expect(answer.status).toBe(IntentToolStatus.Error);
    const error = answer.error as { code: string; message: string; path: string[] };
    expect(error.code).toBe(IntentErrorCode.ContentEmailShaped);
    expect(error.path).toEqual(['items', '0', 'rationale']);
    expect(error.message).not.toMatch(/…$/);
    expect(m.propose.propose).not.toHaveBeenCalled();
  });

  it('surfaces a schema violation with the failing field path', async () => {
    const answer = read(
      await tools.intentPropose(
        { ...PROPOSAL, items: [{ ...PROPOSAL.items[0], sources: [] }] },
        {} as never,
        userReq(),
      ),
    );
    const error = answer.error as { code: string; path: string[] };
    expect(error.code).toBe(IntentErrorCode.SchemaViolation);
    expect(error.path).toEqual(['items', '0', 'sources']);
  });

  it('refuses an unknown tree action with the full valid list', async () => {
    const answer = read(
      await tools.intentTree({ action: 'domain.rename', request: {} }, {} as never, userReq(WorkspaceMemberRole.Owner)),
    );
    const error = answer.error as { code: string; message: string; path: string[]; details: { message: string }[] };
    expect(answer.status).toBe(IntentToolStatus.Error);
    expect(error.path).toEqual(['action']);
    expect(error.details.map((detail) => detail.message)).toEqual(Object.values(IntentTreeAction));
    expect(error.message).not.toMatch(/…$/);
  });

  it('renders an unexpected service failure as the fixed internal shape, leaking nothing', async () => {
    m.context.read.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.4:5432'));
    const answer = read(await tools.getIntentContext({}, {} as never, userReq()));
    expect(answer.status).toBe(IntentToolStatus.Error);
    const error = answer.error as { code: string; message: string };
    expect(error.code).toBe(IntentErrorCode.InternalError);
    expect(error.message).not.toMatch(/ECONNREFUSED|10\.0\.0\.4/);
  });
});

describe('intent tools — metrics', () => {
  let m: Mocks;
  let tools: IntentTools;

  beforeEach(() => {
    m = mocks();
    configured(m);
    tools = build(m);
  });

  it('records a served read with its result count', async () => {
    m.context.read.mockResolvedValue({ mode: IntentContextMode.Context, matches: [{ id: 'a' }, { id: 'b' }] });
    await tools.getIntentContext({}, {} as never, userReq());
    expect(m.metrics.recordMcpQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        toolName: 'get_intent_context',
        userId: 'user_1',
        success: true,
        resultCount: 2,
      }),
    );
  });

  it('records a refusal as an unsuccessful call', async () => {
    await tools.intentReview(REVIEW, {} as never, tokenReq([TokenPermission.IntentPropose]));
    expect(m.metrics.recordMcpQuery).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'intent_review', success: false }),
    );
  });

  it('does not fail a tool call when the metric write fails', async () => {
    m.metrics.recordMcpQuery.mockRejectedValue(new Error('metrics down'));
    const answer = read(await tools.getIntentContext({}, {} as never, userReq()));
    expect(answer.status).toBeUndefined();
  });
});

describe('intent_release gates and shared contracts', () => {
  it('lists with an omitted request using the default page size', async () => {
    const m = mocks();
    configured(m);
    await build(m).intentRelease({ action: 'list' }, {} as never, tokenReq([TokenPermission.IntentRead]));
    expect(m.releases.list).toHaveBeenCalledWith(WORKSPACE_ID, { limit: 50 });
  });
  // A WELL-FORMED body per action: not_configured must still win over a valid
  // request against an empty workspace (issue 08 moved schema validation
  // BEFORE this check, so it needs a body that actually passes its schema to
  // still exercise the not_configured path rather than a schema error).
  const wellFormedReleaseRequest: Record<string, unknown> = {
    preview: { itemId: 'br-x' },
    list: {},
    record: {
      idempotencyKey: 'k',
      expectedHeadSeq: 0,
      kind: 'release',
      deliveredRef: 'refs/heads/main',
      included: [{ itemId: 'br-x', contentHash: 'a'.repeat(64) }],
    },
    rollback: { idempotencyKey: 'k', expectedHeadSeq: 1, reason: 'reverting a bad release', releaseSeq: 1 },
    plan: { idempotencyKey: 'k', expectedHeadSeq: 0, reason: 'roadmap intent', itemId: 'br-x', expectedVersion: 1 },
    withdraw: { idempotencyKey: 'k', expectedHeadSeq: 0, itemId: 'br-x' },
    reinstate: { idempotencyKey: 'k', expectedHeadSeq: 0, itemId: 'br-x' },
  };

  it.each([
    'preview',
    'list',
    'record',
    'rollback',
    'plan',
    'withdraw',
    'reinstate',
  ])('returns not_configured for %s in an empty workspace, once the body itself validates', async (action) => {
    const m = mocks();
    const tools = build(m);
    const answer = read(
      await tools.intentRelease(
        { action, request: wellFormedReleaseRequest[action] },
        {} as never,
        userReq(WorkspaceMemberRole.Owner),
      ),
    );
    expect(answer.status).toBe(IntentToolStatus.NotConfigured);
    expect(m.releases.preview).not.toHaveBeenCalled();
    expect(m.releases.list).not.toHaveBeenCalled();
    expect(m.releases.record).not.toHaveBeenCalled();
  });

  it('validates the body before the not_configured check: a malformed record fails with its own schema error', async () => {
    const m = mocks();
    const tools = build(m);
    const answer = read(
      await tools.intentRelease({ action: 'record', request: {} }, {} as never, userReq(WorkspaceMemberRole.Owner)),
    );
    expect(answer.status).toBe(IntentToolStatus.Error);
    expect(m.tree.hasIntentContent).not.toHaveBeenCalled();
    expect(m.releases.record).not.toHaveBeenCalled();
  });

  it('allows read tokens to preview but refuses machine writes', async () => {
    const m = mocks();
    configured(m);
    const tools = build(m);
    const result = read(
      await tools.intentRelease(
        { action: 'preview', request: { itemId: 'br-rule' } },
        {} as never,
        tokenReq([TokenPermission.IntentRead]),
      ),
    );
    expect(result.itemId).toBe('br-rule');
    expect(m.releases.preview).toHaveBeenCalledWith(WORKSPACE_ID, 'br-rule');
    for (const req of [tokenReq([TokenPermission.IntentRead, TokenPermission.IntentRelease])]) {
      const refused = read(await tools.intentRelease({ action: 'plan', request: {} }, {} as never, req));
      expect(refused.status).toBe('permission_denied');
    }
    expect(m.releases.record).not.toHaveBeenCalled();
  });
  it.each([
    [
      'record',
      {
        idempotencyKey: 'release-one',
        expectedHeadSeq: 0,
        deliveredRef: 'deploy-one',
        included: [{ itemId: 'br-rule', contentHash: 'a'.repeat(64) }],
        reason: 'Verified availability',
      },
      { kind: 'release', retired: [] },
    ],
    [
      'rollback',
      { idempotencyKey: 'rollback-one', expectedHeadSeq: 1, releaseSeq: 1, reason: 'Restored previous release' },
      { kind: 'rollback' },
    ],
    [
      'withdraw',
      { idempotencyKey: 'withdraw-one', expectedHeadSeq: 1, itemId: 'br-rule', reason: 'Cancelled task' },
      { kind: 'withdraw' },
    ],
    [
      'reinstate',
      { idempotencyKey: 'reinstate-one', expectedHeadSeq: 2, itemId: 'br-rule', reason: 'Task resumed' },
      { kind: 'reinstate' },
    ],
  ])('routes %s from a member session through the shared validated command', async (action, body, defaults) => {
    const m = mocks();
    configured(m);
    const tools = build(m);
    await tools.intentRelease({ action, request: body }, {} as never, userReq(WorkspaceMemberRole.Member));
    expect(m.releases.record).toHaveBeenCalledWith(
      WORKSPACE_ID,
      { id: 'user_1', role: 'member' },
      { ...body, ...defaults },
    );
  });

  it('serves paged release history to read tokens', async () => {
    const m = mocks();
    configured(m);
    const tools = build(m);
    await tools.intentRelease(
      { action: 'list', request: { beforeSeq: 10, limit: 2 } },
      {} as never,
      tokenReq([TokenPermission.IntentRead]),
    );
    expect(m.releases.list).toHaveBeenCalledWith(WORKSPACE_ID, { beforeSeq: 10, limit: 2 });
  });

  it('routes a human plan through the validated REST command and forwards effectivity opt-in', async () => {
    const m = mocks();
    configured(m);
    const tools = build(m);
    const body = {
      itemId: 'br-rule',
      expectedVersion: 1,
      idempotencyKey: 'plan-one',
      expectedHeadSeq: 0,
      reason: 'Approved task',
    };
    await tools.intentRelease({ action: 'plan', request: body }, {} as never, userReq(WorkspaceMemberRole.Owner));
    expect(m.releases.record).toHaveBeenCalledWith(WORKSPACE_ID, expect.objectContaining({ id: 'user_1' }), {
      ...body,
      kind: 'plan',
    });
    await tools.getIntentContext({ effectivity: true }, {} as never, userReq());
    expect(m.context.read).toHaveBeenCalledWith(WORKSPACE_ID, expect.objectContaining({ effectivity: true }));
  });
});

describe('intent_handoff hosted session boundary', () => {
  const draft = {
    id: '22222222-2222-4222-8222-222222222222',
    expectedVersion: 0,
    idempotencyKey: 'handoff-session-1',
    repoKey: 'github.com/acme/api',
    headSha: 'a'.repeat(40),
    bindings: [{ itemId: 'br-rule', files: ['src/new.ts'] }],
    delivers: [{ itemId: 'br-rule', version: 2 }],
  };
  it('allows a member session to save locators without graph access or authority review', async () => {
    const m = mocks();
    configured(m);
    const tools = build(m);
    const answer = read(await tools.intentHandoff({ action: 'save', request: draft }, {} as Context, userReq()));
    expect(answer).toEqual({ id: draft.id, version: 1 });
    expect(m.handoffs.save).toHaveBeenCalledWith(
      WORKSPACE_ID,
      { id: 'user_1', role: WorkspaceMemberRole.Member },
      expect.objectContaining({ headSha: draft.headSha }),
    );
    expect(m.review.review).not.toHaveBeenCalled();
    expect(m.anchors.add).not.toHaveBeenCalled();
  });
  it('refuses an owner-created machine token even with all intent mutation grants', async () => {
    const m = mocks();
    const tools = build(m);
    const answer = read(
      await tools.intentHandoff(
        { action: 'save', request: draft },
        {} as Context,
        tokenReq(['intent:propose', 'intent:release', 'intent:bindings']),
      ),
    );
    expect(answer.status).toBe('permission_denied');
    expect(m.handoffs.save).not.toHaveBeenCalled();
  });
  it('uses trusted workspace for reads and refuses an injected workspace argument', async () => {
    const m = mocks();
    configured(m);
    const tools = build(m);
    await tools.intentHandoff({ action: 'get', request: { id: draft.id } }, {} as Context, tokenReq(['intent:read']));
    expect(m.handoffs.get).toHaveBeenCalledWith(WORKSPACE_ID, draft.id);
    m.handoffs.get.mockClear();
    const answer = read(
      await tools.intentHandoff(
        { action: 'get', request: { id: draft.id, workspaceId: 'other' } },
        {} as Context,
        userReq(),
      ),
    );
    expect(answer.status).toBe('error');
    expect(m.handoffs.get).not.toHaveBeenCalled();
  });

  it.each([
    'save',
    'get',
    'list',
  ] as const)('returns not_configured for %s in an empty workspace, after the body still validates', async (action) => {
    const m = mocks();
    const tools = build(m);
    const request = action === 'save' ? draft : action === 'get' ? { id: draft.id } : { repoKey: draft.repoKey };
    const answer = read(await tools.intentHandoff({ action, request }, {} as Context, userReq()));
    expect(answer.status).toBe(IntentToolStatus.NotConfigured);
    expect(m.handoffs.save).not.toHaveBeenCalled();
    expect(m.handoffs.get).not.toHaveBeenCalled();
    expect(m.handoffs.list).not.toHaveBeenCalled();
  });

  it('still validates the body against an empty workspace: a malformed save fails with its own schema error', async () => {
    const m = mocks();
    const tools = build(m);
    const answer = read(
      await tools.intentHandoff(
        { action: 'save', request: { ...draft, headSha: 'not-a-sha' } },
        {} as Context,
        userReq(),
      ),
    );
    expect(answer.status).toBe(IntentToolStatus.Error);
    expect(m.tree.hasIntentContent).not.toHaveBeenCalled();
    expect(m.handoffs.save).not.toHaveBeenCalled();
  });
});

describe('intent_source_update', () => {
  const body = {
    idempotencyKey: 'source-title-1',
    ref: 'confluence:1234567890',
    title: 'Overtime – International',
    url: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/1234567890',
  };

  it('lets a member session re-describe a source on every citing item', async () => {
    const m = mocks();
    configured(m);
    const answer = read(await build(m).intentSourceUpdate(body, {} as Context, userReq()));
    expect(answer).toEqual({ ref: 'confluence:1', items: ['br-rule'] });
    expect(m.items.updateSource).toHaveBeenCalledWith(
      WORKSPACE_ID,
      { id: 'user_1', role: WorkspaceMemberRole.Member },
      body,
    );
  });

  it('refuses a service token, whatever it holds', async () => {
    const m = mocks();
    configured(m);
    const answer = read(await build(m).intentSourceUpdate(body, {} as Context, tokenReq(['intent:propose'])));
    expect(answer.status).toBe('permission_denied');
    expect(m.items.updateSource).not.toHaveBeenCalled();
  });

  it('refuses a body that sets neither title nor url, and a non-http url', async () => {
    const m = mocks();
    configured(m);
    const tools = build(m);
    const empty = read(await tools.intentSourceUpdate({ idempotencyKey: 'k', ref: 'x' }, {} as Context, userReq()));
    expect(empty.status).toBe('error');
    const js = read(await tools.intentSourceUpdate({ ...body, url: 'javascript:alert(1)' }, {} as Context, userReq()));
    expect(js.status).toBe('error');
    expect(m.items.updateSource).not.toHaveBeenCalled();
  });
});
