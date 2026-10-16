import { GithubApiError, GithubAuthError, GithubRateLimitError } from '../../libs/github/github-client.js';
import { ReleaseActorKind } from './intent-release.fold.js';
import { GithubIntentReleaseService } from './github-intent-release.service.js';
/** Real PostgreSQL and Ladybug, with GitHub observations and lease acquisition substituted.
 * Hosted OAuth / real forge merge remain a distinct post-deploy E2E gate. */
import '../../config/load-env.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildIntentGraphFixture,
  openIntentGraphFixture,
  FIXTURE_REPO_A_COMMIT,
  type IntentGraphFixture,
  type OpenedIntentGraphFixture,
} from '@coredoc/db/testing';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../database/prisma.service.js';
import type { WorkspaceMcpContextService } from '../../mcp/workspace-mcp-context.service.js';
import { graphRepoHashOf } from '../repos/repo-intent-identity.js';
import { IntentHandoffService } from './intent-handoff.service.js';
import { IntentHandoffProcessor } from './intent-handoff-processor.service.js';
import { IntentHandoffAnchorsService } from './intent-handoff-anchors.service.js';
import type { IntentHandoffGithubService } from './intent-handoff-github.service.js';
import { SaveIntentHandoffSchema } from './intent-handoff.operations.js';
import { IntentReleaseService } from './intent-release.service.js';
import { IntentReviewService } from './intent-review.service.js';
import { IntentProposeService } from './intent-propose.service.js';
import { IntentAnchorTargetService } from './intent-anchor-target.js';
import { IntentAnchorService } from './intent-anchor.service.js';
import { parseContract, ProposeIntentItemsSchema, ReviewIntentItemsSchema } from './contract/index.js';
import { IntentContextService } from './intent-context.service.js';
import { IntentDerivationService } from './derivation/intent-derivation.service.js';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import { IntentContextMode } from './intent-context.operations.js';

const URL = process.env.INTENT_BINDINGS_TEST_DATABASE_URL ?? '';
const REPO = 'github.com/acme/orders-api';
const HASH = graphRepoHashOf(REPO);
const HEAD = 'b'.repeat(40);
const VERSION = 'handoff-fixture-v1';
const FILE = 'src/app/guards.ts';
const FILE2 = 'src/app/handlers.ts';
const actor = { id: 'handoff-owner', role: 'owner' };

describe.skipIf(!URL)('hosted handoff server flow (PostgreSQL + graph)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let workspaceId: string;
  let dir: string;
  let fixture: IntentGraphFixture;
  let opened: OpenedIntentGraphFixture;
  let store: IntentHandoffService;
  let processor: IntentHandoffProcessor;
  let anchors: IntentHandoffAnchorsService;
  let manual: IntentAnchorService;
  let reviewer: IntentReviewService;
  let proposer: IntentProposeService;
  let context: IntentContextService;
  let graphContext: WorkspaceMcpContextService;
  let github: IntentHandoffGithubService;
  let source: Record<string, any>;
  let includes = true;
  let afterPrepare: (() => Promise<void>) | undefined;
  let previousUrl: string | undefined;
  let counter = 0;

  beforeAll(async () => {
    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = URL;
    pool = buildPrismaAdapter();
    prisma = new PrismaClient({ adapter: pool?.adapter } as never);
    await prisma.$connect();
    dir = mkdtempSync(join(tmpdir(), 'handoff-pg-'));
    fixture = await buildIntentGraphFixture(join(dir, 'graph.ladybug'), {
      repoKeys: { a: REPO, b: 'github.com/acme/reports-web' },
    });
    opened = await openIntentGraphFixture(fixture.path, { readOnly: true });
    const ws = await prisma.workspace.create({
      data: { name: 'handoff', slug: `handoff-${randomUUID()}`, intentReleaseTrigger: 'merge', intentEnabled: true },
    });
    workspaceId = ws.id;
    await prisma.workspaceMember.create({
      data: { workspaceId, userId: actor.id, email: 'handoff@example.com', role: 'owner' },
    });
    await prisma.workspaceRepo.create({
      data: { workspaceId, repoKey: HASH, repoName: 'orders-api', intentRepoKey: REPO, productionBranch: 'main' },
    });
    await prisma.workspaceGraphVersion.create({
      data: {
        workspaceId,
        versionId: VERSION,
        engine: 'ladybug',
        r2Key: 'fixture',
        sha256: 'a'.repeat(64),
        sizeBytes: 1,
        storageFormatVersion: 1,
        manifest: {},
      },
    });
    const db = prisma as unknown as PrismaService;
    graphContext = {
      async withContextByWorkspaceId(wsId: string, callback: (ctx: never) => Promise<unknown>) {
        const repos = await prisma.workspaceRepo.findMany({ where: { workspaceId: wsId } });
        return callback({
          repository: opened.repository,
          scope: {},
          repos,
          versionId: VERSION,
          graphBackend: 'file_snapshot',
        } as never);
      },
    } as WorkspaceMcpContextService;
    store = new IntentHandoffService(db);
    anchors = new IntentHandoffAnchorsService(db, graphContext);
    const prepare = anchors.prepare.bind(anchors);
    vi.spyOn(anchors, 'prepare').mockImplementation(async (...args) => {
      const result = await prepare(...args);
      const hook = afterPrepare;
      afterPrepare = undefined;
      await hook?.();
      return result;
    });
    github = {
      source: async () => source,
      pull: async (_ws: string, _repo: string, number: number) => ({
        ...source,
        pull: { ...source.pull, ...source.pulls?.[number], number },
      }),
      includes: async () => includes,
    } as unknown as IntentHandoffGithubService;
    processor = new IntentHandoffProcessor(
      db,
      github,
      graphContext,
      anchors,
      new IntentReleaseService(db),
      new GithubIntentReleaseService(db, new IntentReleaseService(db)),
    );
    const target = new IntentAnchorTargetService(graphContext);
    manual = new IntentAnchorService(db, target);
    reviewer = new IntentReviewService(db);
    proposer = new IntentProposeService(db, target);
    context = new IntentContextService(
      db,
      new IntentDerivationService(graphContext, new ControlPlaneService(db)),
      new ControlPlaneService(db),
    );
  });
  beforeEach(async () => {
    afterPrepare = undefined;
    includes = true;
    await prisma.intentHandoff.deleteMany({ where: { workspaceId } });
    await prisma.intentAnchor.deleteMany({ where: { workspaceId } });
    await prisma.intentReleaseEvent.deleteMany({ where: { workspaceId } });
    await prisma.intentMutationRequest.deleteMany({ where: { workspaceId } });
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { activeGraphVersionId: VERSION, intentReleaseTrigger: 'merge' },
    });
    source = {
      repo: await prisma.workspaceRepo.findFirstOrThrow({ where: { workspaceId } }),
      owner: 'acme',
      name: 'orders-api',
      client: { pullsForCommit: async () => [1] },
      pull: {
        number: 1,
        state: 'closed',
        merged: true,
        draft: false,
        head: { sha: HEAD },
        base: { ref: 'main', repo: { full_name: 'acme/orders-api', default_branch: 'main' } },
        merge_commit_sha: FIXTURE_REPO_A_COMMIT,
        merged_at: '2026-09-14T12:00:00Z',
      },
    };
  });
  afterAll(async () => {
    await opened?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (workspaceId) {
      await prisma.workspace.update({ where: { id: workspaceId }, data: { activeGraphVersionId: null } });
      await prisma.workspace.delete({ where: { id: workspaceId } });
    }
    await prisma?.$disconnect();
    await pool?.pool?.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  });

  async function item(authority: 'accepted' | 'candidate' = 'accepted') {
    const id = `br-handoff-${++counter}`;
    await prisma.intentItem.create({
      data: {
        workspaceId,
        id,
        kind: 'business_rule',
        title: 'Only admins',
        statement: 'Only admins can change authorization.',
        authority,
        createdBy: actor.id,
        updatedBy: actor.id,
      },
    });
    return id;
  }
  async function save(itemId: string, extra: Record<string, unknown> = {}) {
    const input = SaveIntentHandoffSchema.parse({
      id: randomUUID(),
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
      repoKey: REPO,
      headSha: HEAD,
      prNumber: 1,
      bindings: [{ itemId, files: [FILE] }],
      ...extra,
    });
    return { input, saved: await store.save(workspaceId, actor, input) };
  }
  const read = (id: string) => prisma.intentHandoff.findUniqueOrThrow({ where: { id } });
  const links = (itemId: string) => prisma.intentAnchor.findMany({ where: { workspaceId, itemId } });

  it('saves without graph/PR, replays, attaches PR and rejects concurrent or cross-tenant updates', async () => {
    await prisma.workspace.update({ where: { id: workspaceId }, data: { activeGraphVersionId: null } });
    const id = await item();
    const { input, saved } = await save(id, { prNumber: undefined });
    expect(await store.save(workspaceId, actor, input)).toEqual(saved);
    expect(await links(id)).toEqual([]);
    const next = { ...input, expectedVersion: 1, idempotencyKey: randomUUID(), prNumber: 1 };
    await store.save(workspaceId, actor, next);
    await expect(store.save(workspaceId, actor, { ...next, idempotencyKey: randomUUID() })).rejects.toThrow(
      'handoff_version_changed',
    );
    await expect(store.get(randomUUID(), input.id)).rejects.toThrow('handoff_not_found');
    expect((await store.list(randomUUID(), { limit: 20 })).operations).toEqual([]);
  });

  it.each([
    false,
    true,
  ])('refuses a racing create without overwriting the winner (cross-tenant=%s)', async (crossTenant) => {
    const other = crossTenant
      ? await prisma.workspace.create({ data: { name: 'other-handoff', slug: randomUUID() } })
      : null;
    try {
      if (other)
        await prisma.workspaceRepo.create({
          data: { workspaceId: other.id, repoKey: HASH, repoName: 'orders-api', intentRepoKey: REPO },
        });
      const id = randomUUID();
      let arrivals = 0;
      let unblock!: () => void;
      const barrier = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      const racing = prisma.$extends({
        query: {
          intentHandoff: {
            async findUnique({ args, query }) {
              const row = await query(args);
              if (args.where.id === id && !row) {
                if (++arrivals === 2) unblock();
                await barrier;
              }
              return row;
            },
          },
        },
      });
      const racingStore = new IntentHandoffService(racing as unknown as PrismaService);
      const input = SaveIntentHandoffSchema.parse({
        id,
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
        repoKey: REPO,
        headSha: HEAD,
      });
      const results = await Promise.allSettled([
        racingStore.save(workspaceId, actor, input),
        racingStore.save(other?.id ?? workspaceId, actor, {
          ...input,
          idempotencyKey: randomUUID(),
          headSha: 'c'.repeat(40),
        }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      const row = await read(id);
      expect(row.version).toBe(1);
      expect(row.headSha).toBe(results[0].status === 'fulfilled' ? HEAD : 'c'.repeat(40));
      if (other) expect(row.workspaceId).toBe(results[0].status === 'fulfilled' ? workspaceId : other.id);
    } finally {
      if (other) await prisma.workspace.delete({ where: { id: other.id } });
    }
  });

  it('paginates equal creation timestamps without losing operations or accepting a foreign cursor', async () => {
    const itemId = await item();
    for (const prNumber of [1, 2, 3]) await save(itemId, { prNumber });
    await prisma.intentHandoff.updateMany({
      where: { workspaceId },
      data: { createdAt: new Date('2026-09-14T10:00:00Z') },
    });
    const first = await store.list(workspaceId, { limit: 1 });
    const second = await store.list(workspaceId, { limit: 1, before: first.nextBefore! });
    const third = await store.list(workspaceId, { limit: 1, before: second.nextBefore! });
    expect(new Set([...first.operations, ...second.operations, ...third.operations].map((r) => r.id)).size).toBe(3);
    expect(third.nextBefore).toBeNull();
    await expect(store.list(randomUUID(), { limit: 1, before: first.nextBefore! })).rejects.toThrow(
      'handoff_cursor_not_found',
    );
  });

  it('carries one spec approval through capture, handoff, delivery and the next context read', async () => {
    const id = `br-approved-handoff-${++counter}`;
    const source = { kind: 'spec', ref: 'test/spec.md', localId: 'BR-1', revision: 'sha256:approved-fixture' };
    await proposer.propose(
      workspaceId,
      actor,
      parseContract(ProposeIntentItemsSchema, {
        idempotencyKey: randomUUID(),
        items: [
          {
            id,
            kind: 'business_rule',
            title: 'Authorized action',
            statement: 'Only an administrator authorizes the action.',
            payload: {
              condition: 'An action is requested.',
              requiredOutcome: 'An administrator authorizes it.',
              observer: 'The request response.',
              exceptions: [],
            },
            sources: [source],
          },
        ],
      }),
    );
    const decision = parseContract(ReviewIntentItemsSchema, {
      idempotencyKey: randomUUID(),
      authorizingSource: source,
      decisions: [
        { itemId: id, expectedVersion: 1, action: 'accept', reason: 'Explicit approval of test/spec.md BR-1.' },
      ],
    });
    const accepted = await reviewer.review(workspaceId, actor, decision);
    expect(await reviewer.review(workspaceId, actor, decision)).toEqual(accepted);
    expect(await prisma.intentAuthorityTransition.count({ where: { workspaceId, itemId: id } })).toBe(1);
    const { input } = await save(id, { delivers: [{ itemId: id, version: 2 }] });
    await processor.process(workspaceId, input.id);
    expect(await read(input.id)).toMatchObject({ mappingState: 'applied', deliveryState: 'recorded' });
    const next = await context.read(workspaceId, {
      mode: IntentContextMode.Context,
      intentIds: [id],
      includeCandidates: false,
      limit: 10,
    });
    expect(next).toMatchObject({ matches: [{ id, authority: 'accepted', anchors: [{ repoKey: REPO }] }] });
  });

  it.each(['merge-first', 'publish-first'])('converges %s without requiring another code change', async (order) => {
    const id = await item();
    const { input } = await save(id, { delivers: [{ itemId: id, version: 1 }] });
    if (order === 'merge-first')
      await prisma.workspace.update({ where: { id: workspaceId }, data: { activeGraphVersionId: null } });
    else {
      source.pull.merged = false;
      source.pull.state = 'open';
    }
    await processor.process(workspaceId, input.id);
    expect((await read(input.id)).mappingState).toBe('pending');
    if (order === 'merge-first') expect((await read(input.id)).deliveryState).toBe('recorded');
    source.pull.merged = true;
    await prisma.workspace.update({ where: { id: workspaceId }, data: { activeGraphVersionId: VERSION } });
    await processor.process(workspaceId, input.id);
    await processor.process(workspaceId, input.id);
    expect(await read(input.id)).toMatchObject({ mappingState: 'applied', deliveryState: 'recorded' });
    expect(await links(id)).toHaveLength(1);
    expect(await prisma.intentReleaseEvent.count({ where: { workspaceId, kind: 'release' } })).toBe(1);
    const next = await context.read(workspaceId, {
      mode: IntentContextMode.Context,
      intentIds: [id],
      includeCandidates: false,
      limit: 10,
      observed: {},
      effectivity: true,
    });
    expect((next as any).matches[0]).toMatchObject({ id, effectivity: 'effective' });
    expect((next as any).matches[0].anchors).toHaveLength(1);
  });

  it('does nothing at all while intent is disabled, and resumes when the flag comes back', async () => {
    const id = await item();
    const { input } = await save(id, { delivers: [{ itemId: id, version: 1 }] });
    const before = await read(input.id);
    try {
      await prisma.workspace.update({ where: { id: workspaceId }, data: { intentEnabled: false } });
      await processor.process(workspaceId, input.id);
      expect(await prisma.intentReleaseEvent.count({ where: { workspaceId } })).toBe(0);
      expect(await links(id)).toEqual([]);
      // The row is byte-for-byte untouched — including nextAttemptAt, so the work survives.
      expect(await read(input.id)).toEqual(before);
      // A disabled workspace is not even claimed by the worker tick.
      expect(
        await prisma.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM intent_handoffs WHERE next_attempt_at <= now() AND workspace_id = ${workspaceId}::uuid
          AND workspace_id IN (SELECT id FROM workspaces WHERE intent_enabled = true)`,
      ).toEqual([]);
    } finally {
      await prisma.workspace.update({ where: { id: workspaceId }, data: { intentEnabled: true } });
    }
    await processor.process(workspaceId, input.id);
    expect(await read(input.id)).toMatchObject({ mappingState: 'applied', deliveryState: 'recorded' });
    expect(await prisma.intentReleaseEvent.count({ where: { workspaceId, kind: 'release' } })).toBe(1);
  });

  it('two PRs apply to one snapshot without a checkpoint consuming either', async () => {
    const a = await item();
    const b = await item();
    const one = await save(a);
    const two = await save(b, { prNumber: 2 });
    await processor.process(workspaceId, two.input.id);
    await processor.process(workspaceId, one.input.id);
    expect(await links(a)).toHaveLength(1);
    expect(await links(b)).toHaveLength(1);
  });

  it('a push after the save does not block delivery; a re-save after merge may move head and bindings', async () => {
    const id = await item();
    // Saved at commit A (HEAD); the PR head then moved to commit B before the merge.
    const { input } = await save(id, { delivers: [{ itemId: id, version: 1 }] });
    source.pull.head.sha = 'c'.repeat(40);
    await processor.process(workspaceId, input.id);
    expect(await read(input.id)).toMatchObject({ mappingState: 'applied', deliveryState: 'recorded', headSha: HEAD });
    expect(await links(id)).toHaveLength(1);
    expect(await prisma.intentReleaseEvent.count({ where: { workspaceId, kind: 'release' } })).toBe(1);
    // Same declaration, new head and a binding whose file vanished: accepted and re-mapped.
    await store.save(workspaceId, actor, {
      ...input,
      headSha: source.pull.head.sha,
      bindings: [{ itemId: id, files: ['src/vanished.ts'], symbols: [], replaceNodeIds: [] }],
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
    });
    await processor.process(workspaceId, input.id);
    const row = await read(input.id);
    expect(row).toMatchObject({ mappingState: 'needs_attention', deliveryState: 'recorded' });
    expect(row.results).toEqual([
      expect.objectContaining({ itemId: id, outcome: 'unresolved', reason: 'target_unresolved' }),
    ]);
    expect(await prisma.intentReleaseEvent.count({ where: { workspaceId, kind: 'release' } })).toBe(1);
    // The delivery declaration itself stays frozen once recorded.
    await expect(
      store.save(workspaceId, actor, { ...input, expectedVersion: 2, idempotencyKey: randomUUID(), delivers: [] }),
    ).rejects.toThrow('recorded_delivery_immutable');
  });

  it('deploy mode records a handoff saved before the last push', async () => {
    await prisma.workspace.update({ where: { id: workspaceId }, data: { intentReleaseTrigger: 'deploy' } });
    const id = await item();
    const { input } = await save(id, { delivers: [{ itemId: id, version: 1 }] });
    source.pull.head.sha = 'c'.repeat(40);
    await processor.process(workspaceId, input.id);
    expect(await read(input.id)).toMatchObject({ mappingState: 'applied', deliveryState: 'pending' });
    await processor.recordDeployment(workspaceId, {
      kind: 'release',
      repoKey: REPO,
      deliveredRef: FIXTURE_REPO_A_COMMIT,
      deployId: 'after-push',
      deployedAt: '2026-09-14T13:00:00Z',
    });
    expect((await read(input.id)).deliveryState).toBe('recorded');
    expect(await prisma.intentReleaseEvent.count({ where: { workspaceId, kind: 'release' } })).toBe(1);
  });

  it('does not confuse ancestry with inclusion; no anchors until the snapshot includes merge', async () => {
    const id = await item();
    const { input } = await save(id);
    includes = false;
    await processor.process(workspaceId, input.id);
    expect(await links(id)).toEqual([]);
    expect((await read(input.id)).mappingReason).toBe('snapshot_does_not_include_merge');
    includes = true;
    await processor.process(workspaceId, input.id);
    expect(await links(id)).toHaveLength(1);
  });

  it('partial mapping preserves old links and a valid delivery; retries do not refresh completed baselines', async () => {
    const a = await item();
    const b = await item();
    const { input } = await save(a, {
      bindings: [
        { itemId: a, files: ['src/missing.ts'] },
        { itemId: b, files: [FILE2] },
      ],
      delivers: [{ itemId: a, version: 1 }],
    });
    await processor.process(workspaceId, input.id);
    expect(await read(input.id)).toMatchObject({ mappingState: 'needs_attention', deliveryState: 'recorded' });
    const before = await links(b);
    await processor.process(workspaceId, input.id);
    expect(await links(b)).toEqual(before);
    await expect(
      store.save(workspaceId, actor, { ...input, expectedVersion: 1, idempotencyKey: randomUUID(), delivers: [] }),
    ).rejects.toThrow('recorded_delivery_immutable');
  });

  it('stale delivery version does not block accepted mapping', async () => {
    const id = await item();
    const { input } = await save(id, { delivers: [{ itemId: id, version: 99 }] });
    await processor.process(workspaceId, input.id);
    expect(await read(input.id)).toMatchObject({ mappingState: 'applied', deliveryState: 'needs_attention' });
    expect(await links(id)).toHaveLength(1);
  });

  it('accepts under the real reviewer between resolve/apply; no graph ID is minted by the agent', async () => {
    const id = await item('candidate');
    const { input } = await save(id);
    afterPrepare = async () => {
      await reviewer.review(
        workspaceId,
        actor,
        parseContract(ReviewIntentItemsSchema, {
          idempotencyKey: randomUUID(),
          authorizingSource: { kind: 'spec', ref: 'fixture/spec.md', localId: 'BR-1', revision: 'v1' },
          decisions: [{ itemId: id, expectedVersion: 1, action: 'accept', reason: 'Explicit fixture approval.' }],
        }),
      );
    };
    await processor.process(workspaceId, input.id);
    expect((await read(input.id)).results).toMatchObject([{ outcome: 'mapped', authorityVersion: 2 }]);
  });

  it('rejects a moved graph or revised handoff after resolution', async () => {
    const id = await item();
    const { input } = await save(id);
    afterPrepare = async () => {
      await prisma.workspace.update({ where: { id: workspaceId }, data: { activeGraphVersionId: null } });
    };
    await processor.process(workspaceId, input.id);
    expect(await links(id)).toEqual([]);
    await prisma.workspace.update({ where: { id: workspaceId }, data: { activeGraphVersionId: VERSION } });
    afterPrepare = async () => {
      await store.save(workspaceId, actor, {
        ...input,
        expectedVersion: 1,
        idempotencyKey: randomUUID(),
        bindings: [{ itemId: id, files: [FILE2], symbols: [], replaceNodeIds: [] }],
      });
    };
    await processor.process(workspaceId, input.id);
    expect(await links(id)).toEqual([]);
    await processor.process(workspaceId, input.id);
    expect((await links(id))[0].nodeId).toBe(fixture.repoA.handlersFile);
  });

  it('manual removal survives automatic apply; explicit restore remains a manual operation', async () => {
    const id = await item();
    const { input } = await save(id);
    await processor.process(workspaceId, input.id);
    const identity = { itemId: id, repoKey: REPO, nodeId: fixture.repoA.guardsFile };
    await manual.remove(workspaceId, actor, { ...identity, idempotencyKey: randomUUID() });
    await store.save(workspaceId, actor, {
      ...input,
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
      bindings: [{ itemId: id, files: [FILE], symbols: [], replaceNodeIds: [fixture.repoA.guardsFile] }],
    });
    await processor.process(workspaceId, input.id);
    expect((await links(id))[0].disabledAt).not.toBeNull();
    await manual.add(workspaceId, actor, { ...identity, idempotencyKey: randomUUID() });
    expect((await links(id))[0].disabledAt).toBeNull();
  });

  it('explicit successor closes only an unresolved mapping, retaining predecessor delivery', async () => {
    const id = await item();
    const first = await save(id, {
      bindings: [{ itemId: id, files: ['src/old.ts'] }],
      delivers: [{ itemId: id, version: 1 }],
    });
    await processor.process(workspaceId, first.input.id);
    const next = await save(id, { prNumber: 2, supersedesMappingIds: [first.input.id] });
    await processor.process(workspaceId, next.input.id);
    expect(await read(first.input.id)).toMatchObject({ mappingState: 'superseded', deliveryState: 'recorded' });
  });

  it('records two merges sharing an item in merge order even when the worker visits the newer handoff first', async () => {
    const newerItem = await item();
    const olderItem = await item();
    // BR-6: only a shared item orders the two PRs.
    const newer = await save(newerItem, {
      prNumber: 2,
      delivers: [
        { itemId: newerItem, version: 1 },
        { itemId: olderItem, version: 1 },
      ],
    });
    const older = await save(olderItem, { prNumber: 1, delivers: [{ itemId: olderItem, version: 1 }] });
    source.pulls = {
      1: { merged_at: new Date(Date.now() - 120_000).toISOString(), merge_commit_sha: 'd'.repeat(40) },
      2: { merged_at: new Date(Date.now() - 60_000).toISOString(), merge_commit_sha: 'e'.repeat(40) },
    };
    // The older handoff need not belong to the currently claimed worker batch.
    await prisma.intentHandoff.update({
      where: { id: older.input.id },
      data: { nextAttemptAt: new Date(Date.now() + 300_000) },
    });
    await processor.process(workspaceId, newer.input.id);
    expect(await read(newer.input.id)).toMatchObject({
      mappingState: 'applied',
      deliveryState: 'pending',
      deliveryReason: 'awaiting_earlier_merge',
    });
    await processor.process(workspaceId, older.input.id);
    await processor.process(workspaceId, newer.input.id);
    const events = await prisma.intentReleaseEvent.findMany({
      where: { workspaceId, kind: 'release' },
      orderBy: { seq: 'asc' },
    });
    expect(events.map((event) => [...(event.data as { included: string[] }).included].sort())).toEqual([
      [olderItem],
      [newerItem, olderItem].sort(),
    ]);
    expect((await read(newer.input.id)).deliveryState).toBe('recorded');
    expect((await read(older.input.id)).deliveryState).toBe('recorded');
  });

  it('AC-5: a newer PR on a disjoint item records first; the earlier-merged PR still records', async () => {
    const itemY = await item();
    const itemX = await item();
    const y = await save(itemY, { prNumber: 2, delivers: [{ itemId: itemY, version: 1 }] });
    const x = await save(itemX, { prNumber: 1, delivers: [{ itemId: itemX, version: 1 }] });
    source.pulls = {
      1: { merged_at: new Date(Date.now() - 120_000).toISOString(), merge_commit_sha: 'd'.repeat(40) },
      2: { merged_at: new Date(Date.now() - 60_000).toISOString(), merge_commit_sha: 'e'.repeat(40) },
    };
    await processor.process(workspaceId, y.input.id);
    expect((await read(y.input.id)).deliveryState).toBe('recorded');
    await processor.process(workspaceId, x.input.id);
    expect((await read(x.input.id)).deliveryState).toBe('recorded');
    const events = await prisma.intentReleaseEvent.findMany({
      where: { workspaceId, kind: 'release' },
      orderBy: { seq: 'asc' },
    });
    expect(events.map((event) => (event.data as { included: string[] }).included)).toEqual([[itemY], [itemX]]);
  });

  it('never exposes a merged observation as fresh-open to a concurrent worker', async () => {
    const olderItem = await item();
    const newerItem = await item();
    const older = await save(olderItem, { prNumber: 1, delivers: [{ itemId: olderItem, version: 1 }] });
    const newer = await save(newerItem, {
      prNumber: 2,
      delivers: [
        { itemId: newerItem, version: 1 },
        { itemId: olderItem, version: 1 },
      ],
    });
    source.pulls = {
      1: { merged_at: new Date(Date.now() - 120_000).toISOString(), merge_commit_sha: 'd'.repeat(40) },
      2: { merged_at: new Date(Date.now() - 60_000).toISOString(), merge_commit_sha: 'e'.repeat(40) },
    };
    let interleaved = false;
    const observing = prisma.$extends({
      query: {
        intentHandoff: {
          async updateMany({ args, query }) {
            const result = await query(args);
            if (!interleaved && args.where?.id === older.input.id && args.data.prObservedAt) {
              interleaved = true;
              await processor.process(workspaceId, newer.input.id);
              expect((await read(newer.input.id)).deliveryState).toBe('pending');
            }
            return result;
          },
        },
      },
    });
    const db = observing as unknown as PrismaService;
    const observedProcessor = new IntentHandoffProcessor(
      db,
      github,
      graphContext,
      anchors,
      new IntentReleaseService(db),
      new GithubIntentReleaseService(db, new IntentReleaseService(db)),
    );
    await observedProcessor.process(workspaceId, older.input.id);
    expect(interleaved).toBe(true);
    await processor.process(workspaceId, newer.input.id);
    expect((await read(older.input.id)).deliveryState).toBe('recorded');
    expect((await read(newer.input.id)).deliveryState).toBe('recorded');
  });

  it('keeps deploy version refusals visible until a session repairs the declaration', async () => {
    await prisma.workspace.update({ where: { id: workspaceId }, data: { intentReleaseTrigger: 'deploy' } });
    const id = await item();
    const { input } = await save(id, { delivers: [{ itemId: id, version: 1 }] });
    await processor.process(workspaceId, input.id);
    await prisma.intentItem.update({ where: { workspaceId_id: { workspaceId, id } }, data: { version: 2 } });
    const deployment = {
      kind: 'release' as const,
      repoKey: REPO,
      deliveredRef: FIXTURE_REPO_A_COMMIT,
      deployId: 'failed-then-repaired',
      deployedAt: '2026-09-14T13:00:00Z',
    };
    await expect(processor.recordDeployment(workspaceId, deployment)).rejects.toThrow();
    expect(await read(input.id)).toMatchObject({ mappingState: 'applied', deliveryState: 'needs_attention' });
    const reason = (await read(input.id)).deliveryReason;
    expect(reason).toBeTruthy();
    await processor.process(workspaceId, input.id);
    expect((await read(input.id)).deliveryReason).toBe(reason);
    expect(await prisma.intentReleaseEvent.count({ where: { workspaceId, kind: 'release' } })).toBe(0);
    await store.save(workspaceId, actor, {
      ...input,
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
      delivers: [{ itemId: id, version: 2 }],
    });
    await processor.recordDeployment(workspaceId, deployment);
    expect((await read(input.id)).deliveryState).toBe('recorded');
  });

  it.each([
    [new GithubAuthError('provider credential detail'), 'github_auth_required'],
    [new GithubApiError(403, '/private/source'), 'github_access_denied'],
    [new GithubApiError(404, '/private/source'), 'github_source_unavailable'],
    [new Error('repository_remote_missing'), 'repository_remote_missing'],
    [new Error('github_connector_unavailable'), 'github_connector_unavailable'],
  ])('keeps permanent source failure actionable and lets later merges proceed: %s', async (failure, reason) => {
    const olderItem = await item();
    const older = await save(olderItem, { prNumber: 1, delivers: [{ itemId: olderItem, version: 1 }] });
    vi.spyOn(github, 'pull').mockRejectedValueOnce(failure);
    await processor.process(workspaceId, older.input.id);
    expect(await read(older.input.id)).toMatchObject({
      mappingState: 'needs_attention',
      deliveryState: 'needs_attention',
      mappingReason: reason,
      deliveryReason: reason,
      nextAttemptAt: null,
    });
    const nextItem = await item();
    const next = await save(nextItem, { prNumber: 2, delivers: [{ itemId: nextItem, version: 1 }] });
    await processor.process(workspaceId, next.input.id);
    expect((await read(next.input.id)).deliveryState).toBe('recorded');
  });

  it.each([
    new GithubRateLimitError('rate limited'),
    new Error('network timeout'),
  ])('retries temporary source failures without exposing provider messages: %s', async (failure) => {
    const { input } = await save(await item());
    vi.spyOn(github, 'pull').mockRejectedValueOnce(failure);
    await processor.process(workspaceId, input.id);
    const row = await read(input.id);
    expect(row).toMatchObject({
      mappingState: 'pending',
      deliveryState: 'pending',
      mappingReason: 'github_unavailable',
    });
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    await processor.process(workspaceId, input.id);
    expect((await read(input.id)).mappingState).toBe('applied');
  });

  it.each([true, false])('attaches an existing deployment replay to its handoff (cache=%s)', async (cached) => {
    await prisma.workspace.update({ where: { id: workspaceId }, data: { intentReleaseTrigger: 'deploy' } });
    const id = await item();
    const deployment = {
      kind: 'release' as const,
      repoKey: REPO,
      deliveredRef: FIXTURE_REPO_A_COMMIT,
      deployId: 'before-handoff',
      deployedAt: '2026-09-14T13:00:00Z',
    };
    const original = await new IntentReleaseService(prisma as unknown as PrismaService).record(
      workspaceId,
      { id: 'system:legacy-ci', role: 'system' },
      {
        ...deployment,
        trailers: { delivers: [{ itemId: id, version: 1 }], retires: [] },
        pr: { repoKey: REPO, number: 1 },
      },
      ReleaseActorKind.Ci,
    );
    if (!cached) await prisma.intentMutationRequest.deleteMany({ where: { workspaceId } });
    const { input } = await save(id, { delivers: [{ itemId: id, version: 1 }] });
    expect((await read(input.id)).deliveryState).toBe('pending');
    // The worker observes the merge; only an observed merge is deployable without a handoffId.
    await processor.process(workspaceId, input.id);
    expect((await read(input.id)).deliveryState).toBe('pending');
    expect(await processor.recordDeployment(workspaceId, deployment)).toMatchObject({
      ...(original as object),
      deliveries: [{ handoffId: input.id, pr: 1, outcome: 'recorded', seq: 1 }],
    });
    expect((await read(input.id)).deliveryState).toBe('recorded');
    expect(await prisma.intentReleaseEvent.count({ where: { workspaceId, kind: 'release' } })).toBe(1);
    await expect(
      store.save(workspaceId, actor, { ...input, expectedVersion: 1, idempotencyKey: randomUUID(), delivers: [] }),
    ).rejects.toThrow('recorded_delivery_immutable');
  });

  it('deploy mode records only after verified production evidence and replays the same deployment', async () => {
    await prisma.workspace.update({ where: { id: workspaceId }, data: { intentReleaseTrigger: 'deploy' } });
    const id = await item();
    const { input } = await save(id, { delivers: [{ itemId: id, version: 1 }] });
    await processor.process(workspaceId, input.id);
    expect(await read(input.id)).toMatchObject({ mappingState: 'applied', deliveryState: 'pending' });
    const deployment = {
      kind: 'release' as const,
      repoKey: REPO,
      deliveredRef: FIXTURE_REPO_A_COMMIT,
      deployId: 'run-1',
      deployedAt: '2026-09-14T13:00:00Z',
    };
    const response = await processor.recordDeployment(workspaceId, deployment);
    expect(await processor.recordDeployment(workspaceId, deployment)).toEqual(response);
    expect((await read(input.id)).deliveryState).toBe('recorded');
    includes = false;
    // Without a handoffId a ref that includes no pending merge records nothing...
    expect(await processor.recordDeployment(workspaceId, { ...deployment, deployId: 'run-2' })).toEqual({
      outcome: 'no_delivery',
      reason: 'no_handoff',
    });
    // ...while a named handoff still refuses a deploy that does not include its merge.
    await expect(
      processor.recordDeployment(workspaceId, { ...deployment, deployId: 'run-2', handoffId: input.id }),
    ).rejects.toThrow('deployment_does_not_include_merge');
  });

  it('a retry of a deploy re-attempts only the PRs that failed in that deploy', async () => {
    await prisma.workspace.update({ where: { id: workspaceId }, data: { intentReleaseTrigger: 'deploy' } });
    const good = await item();
    const stale = await item();
    const ok = await save(good, { prNumber: 1, delivers: [{ itemId: good, version: 1 }] });
    const bad = await save(stale, { prNumber: 2, delivers: [{ itemId: stale, version: 1 }] });
    source.pulls = {
      1: { merged_at: '2026-09-14T10:00:00Z', merge_commit_sha: 'd'.repeat(40) },
      2: { merged_at: '2026-09-14T11:00:00Z', merge_commit_sha: 'e'.repeat(40) },
    };
    await processor.process(workspaceId, ok.input.id);
    await processor.process(workspaceId, bad.input.id);
    // The declared version goes stale, so PR 2 fails while PR 1 records.
    await prisma.intentItem.update({ where: { workspaceId_id: { workspaceId, id: stale } }, data: { version: 2 } });
    const deployment = {
      kind: 'release' as const,
      repoKey: REPO,
      deliveredRef: 'f'.repeat(40),
      deployId: 'partial',
      deployedAt: '2026-09-14T13:00:00Z',
    };
    await expect(processor.recordDeployment(workspaceId, deployment)).rejects.toThrow();
    expect(await read(ok.input.id)).toMatchObject({ deliveryState: 'recorded', deliveryDeployId: null });
    expect(await read(bad.input.id)).toMatchObject({ deliveryState: 'needs_attention', deliveryDeployId: 'partial' });
    // Retrying THIS deploy re-attempts PR 2 and fails again, never a silent success.
    await expect(processor.recordDeployment(workspaceId, deployment)).rejects.toThrow();
    // Another deploy of the same ref leaves that failure out.
    await expect(
      processor.recordDeployment(workspaceId, { ...deployment, deployId: 'unrelated' }),
    ).resolves.toMatchObject({ outcome: 'no_delivery' });
    expect(await prisma.intentReleaseEvent.count({ where: { workspaceId, kind: 'release' } })).toBe(1);
  });

  it('AC-4: one deploy without handoffId records every included merged PR in merge order', async () => {
    await prisma.workspace.update({ where: { id: workspaceId }, data: { intentReleaseTrigger: 'deploy' } });
    const olderItem = await item();
    const newerItem = await item();
    const shared = await item();
    // Saved newest first; each PR also delivers `shared`, so both events name it.
    const newer = await save(newerItem, {
      prNumber: 2,
      delivers: [
        { itemId: newerItem, version: 1 },
        { itemId: shared, version: 1 },
      ],
    });
    const older = await save(olderItem, {
      prNumber: 1,
      delivers: [
        { itemId: olderItem, version: 1 },
        { itemId: shared, version: 1 },
      ],
    });
    source.pulls = {
      1: { merged_at: '2026-09-14T10:00:00Z', merge_commit_sha: 'd'.repeat(40) },
      2: { merged_at: '2026-09-14T11:00:00Z', merge_commit_sha: 'e'.repeat(40) },
    };
    await processor.process(workspaceId, newer.input.id);
    await processor.process(workspaceId, older.input.id);
    expect(await read(older.input.id)).toMatchObject({ deliveryState: 'pending', mergeCommit: 'd'.repeat(40) });
    expect(await read(newer.input.id)).toMatchObject({ deliveryState: 'pending', mergeCommit: 'e'.repeat(40) });
    const result = await processor.recordDeployment(workspaceId, {
      kind: 'release',
      repoKey: REPO,
      deliveredRef: 'f'.repeat(40),
      deployId: 'ships-both',
      deployedAt: '2026-09-14T13:00:00Z',
    });
    expect(result).toMatchObject({
      deliveries: [
        { handoffId: older.input.id, pr: 1, outcome: 'recorded', seq: 1 },
        { handoffId: newer.input.id, pr: 2, outcome: 'recorded', seq: 2 },
      ],
    });
    const events = await prisma.intentReleaseEvent.findMany({
      where: { workspaceId, kind: 'release' },
      orderBy: { seq: 'asc' },
    });
    expect(events.map((e) => [(e.data as { pr: { number: number } }).pr.number, e.deliveredRef])).toEqual([
      [1, 'f'.repeat(40)],
      [2, 'f'.repeat(40)],
    ]);
    expect(events.map((e) => e.idempotencyKey)).toEqual([
      `${REPO}:${'f'.repeat(40)}:ships-both:1`,
      `${REPO}:${'f'.repeat(40)}:ships-both:2`,
    ]);
    expect((await read(older.input.id)).deliveryState).toBe('recorded');
    expect((await read(newer.input.id)).deliveryState).toBe('recorded');
  });

  it('recognises an event recorded under the pre-BR-5 key as this PR delivery instead of refusing the ref', async () => {
    await prisma.workspace.update({ where: { id: workspaceId }, data: { intentReleaseTrigger: 'deploy' } });
    const id = await item();
    const deployment = {
      kind: 'release' as const,
      repoKey: REPO,
      deliveredRef: FIXTURE_REPO_A_COMMIT,
      deployId: 'legacy-run',
      deployedAt: '2026-09-14T13:00:00Z',
    };
    const original = await new IntentReleaseService(prisma as unknown as PrismaService).record(
      workspaceId,
      { id: 'system:legacy-ci', role: 'system' },
      {
        ...deployment,
        trailers: { delivers: [{ itemId: id, version: 1 }], retires: [] },
        pr: { repoKey: REPO, number: 1 },
      },
      ReleaseActorKind.Ci,
    );
    // Rewrite it into the old key format (no PR) and drop the replay cache: a pre-BR-5 row.
    await prisma.intentReleaseEvent.updateMany({
      where: { workspaceId },
      data: { idempotencyKey: `${REPO}:${FIXTURE_REPO_A_COMMIT}:legacy-run` },
    });
    await prisma.intentMutationRequest.deleteMany({ where: { workspaceId } });
    const { input } = await save(id, { delivers: [{ itemId: id, version: 1 }] });
    await processor.process(workspaceId, input.id);
    // A named handoff and a PR-enumerating deploy both attach the old event.
    expect(await processor.recordDeployment(workspaceId, { ...deployment, handoffId: input.id })).toEqual(original);
    expect((await read(input.id)).deliveryState).toBe('recorded');
    expect(await processor.recordDeployment(workspaceId, deployment)).toMatchObject({
      deliveries: [{ handoffId: input.id, pr: 1, outcome: 'recorded', seq: 1 }],
    });
    expect(await prisma.intentReleaseEvent.count({ where: { workspaceId, kind: 'release' } })).toBe(1);
  });
});
