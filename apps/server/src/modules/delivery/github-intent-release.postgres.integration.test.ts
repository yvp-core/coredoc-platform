import { randomUUID } from 'node:crypto';
import { IntentHandoffService } from '../intent/intent-handoff.service.js';
import { IntentHandoffProcessor } from '../intent/intent-handoff-processor.service.js';
import { SaveIntentHandoffSchema } from '../intent/intent-handoff.operations.js';
/**
 * RE-03 acceptance: the GitHub connector as an automatic intent actor.
 *
 * Drives the REAL chain for every case — provider PR payload → normalizer →
 * code-change persistence → canonical projection → release ledger — because the
 * facts under test (the trailer projection surviving on `CodeChange.attrs`, the
 * production-branch gate, a refusal that must not fail the sync) only exist
 * where those pieces meet.
 *
 * C0.7=B: every provider-shaped value here is synthetic.
 */
import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import type { PrismaService } from '../../database/prisma.service.js';
import { DeliveryProvider, IntentReleaseTrigger, Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { ReleaseActorKind } from '../intent/intent-release.fold.js';
import { IntentReleaseService, readReleaseSnapshot } from '../intent/intent-release.service.js';
import { graphRepoHashOf } from '../repos/repo-intent-identity.js';
import { GithubCanonicalProjectionService } from './github-canonical-projection.service.js';
import { GithubCodeChangePersistenceService } from './github-code-change-persistence.service.js';
import { GithubIntentReleaseService } from '../intent/github-intent-release.service.js';
import { normalizePullRequest } from './github-normalizer.js';

const TEST_DATABASE_URL = process.env.GITHUB_CANONICAL_TEST_DATABASE_URL ?? '';
const RUN = `github-intent-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
const GITHUB_REPO = 'synthetic/orders-api';
const INTENT_REPO_KEY = 'github.com/synthetic/orders-api';

type PrSeed = {
  number: number;
  handoff?: false;
  /** A GitHub repository the workspace does not hold — the PR links to no workspace repo. */
  repoFullName?: string;
  delivers?: string;
  retires?: string;
  body?: string;
  draft?: boolean;
  closed?: boolean;
  mergedAt?: string;
  mergeCommitSha?: string;
  targetBranch?: string;
};

describe.skipIf(!TEST_DATABASE_URL)('GitHub connector intent actors (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let projection: GithubCanonicalProjectionService;
  let codeChanges: GithubCodeChangePersistenceService;
  let releases: IntentReleaseService;
  let previousDatabaseUrl: string | undefined;
  const workspaceIds: string[] = [];
  /** Monotonic provider clock: the persistence layer refuses a write that is not newer. */
  let tick = 0;

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    pool = buildPrismaAdapter();
    prisma = new PrismaClient({ adapter: pool?.adapter } as never);
    const prismaService = prisma as unknown as PrismaService;
    releases = new IntentReleaseService(prismaService);
    codeChanges = new GithubCodeChangePersistenceService(prismaService);
    projection = new GithubCanonicalProjectionService(
      prismaService,
      new GithubIntentReleaseService(prismaService, releases),
    );
    await prisma.$connect();
  });

  afterAll(async () => {
    for (const workspaceId of workspaceIds.reverse()) {
      await prisma.workspace.delete({ where: { id: workspaceId } });
    }
    await prisma.$disconnect();
    if (pool?.pool) await pool.pool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  async function setup(
    suffix: string,
    options: {
      repoTrigger?: IntentReleaseTrigger;
      trigger?: IntentReleaseTrigger;
      productionBranch?: string;
      itemVersion?: number;
    } = {},
  ) {
    const workspace = await prisma.workspace.create({
      data: {
        name: `${RUN}-${suffix}`,
        slug: `${RUN}-${suffix}`,
        // The connector is gated on the feature flag before it reads anything.
        intentEnabled: true,
        intentReleaseTrigger: options.trigger ?? IntentReleaseTrigger.merge,
      },
      select: { id: true },
    });
    workspaceIds.push(workspace.id);
    const repo = await prisma.workspaceRepo.create({
      data: {
        workspaceId: workspace.id,
        repoKey: graphRepoHashOf(INTENT_REPO_KEY),
        repoName: 'orders-api',
        intentReleaseTrigger: options.repoTrigger ?? null,
        gitUrl: `https://github.com/${GITHUB_REPO}.git`,
        intentRepoKey: INTENT_REPO_KEY,
        ...(options.productionBranch ? { productionBranch: options.productionBranch } : {}),
      },
      select: { id: true },
    });
    const connector = await prisma.deliveryConnector.create({
      data: {
        workspaceId: workspace.id,
        provider: DeliveryProvider.github,
        providerVariant: suffix,
        displayName: `Synthetic GitHub ${suffix}`,
        config: { repos: [GITHUB_REPO] },
      },
      select: { id: true },
    });
    await prisma.intentItem.create({
      data: {
        workspaceId: workspace.id,
        id: 'cap-alpha',
        kind: 'capability',
        authority: 'accepted',
        version: options.itemVersion ?? 1,
        title: 'Alpha',
        statement: 'Alpha applies.',
        createdBy: 'synthetic-owner',
        updatedBy: 'synthetic-owner',
      },
    });
    return { workspaceId: workspace.id, workspaceRepoId: repo.id, connectorId: connector.id };
  }

  /** One connector sync of one pull request, through the whole real chain. */
  async function sync(
    context: { workspaceId: string; workspaceRepoId: string; connectorId: string },
    seed: PrSeed,
  ): Promise<{ rawPayloadId: bigint; codeChangeId: string }> {
    tick += 1;
    const updatedAt = new Date(Date.UTC(2026, 8, 11, 0, 0, tick)).toISOString();
    const pr: Record<string, unknown> = {
      number: seed.number,
      title: `Synthetic pull request #${seed.number}`,
      state: seed.closed || seed.mergedAt ? 'closed' : 'open',
      draft: seed.draft ?? false,
      created_at: '2026-09-11T09:00:00.000Z',
      updated_at: updatedAt,
      merged_at: seed.mergedAt ?? null,
      closed_at: seed.mergedAt ?? (seed.closed ? updatedAt : null),
      merge_commit_sha: seed.mergeCommitSha ?? null,
      body: [
        seed.body ?? 'Synthetic body.',
        ...(seed.delivers ? [`Coredoc-Intent-Delivers: ${seed.delivers}`] : []),
        ...(seed.retires ? [`Coredoc-Intent-Retires: ${seed.retires}`] : []),
      ].join('\n'),
      user: { login: 'synthetic-contributor' },
      head: { ref: `feature/synthetic-${seed.number}`, sha: 'b'.repeat(40) },
      base: {
        ref: seed.targetBranch ?? 'main',
        repo: { full_name: seed.repoFullName ?? GITHUB_REPO, default_branch: 'main' },
      },
    };
    const raw = await prisma.deliveryRawPayload.create({
      data: {
        workspaceId: context.workspaceId,
        connectorId: context.connectorId,
        resourceType: 'pull_request',
        externalId: String(seed.number),
        payload: {
          repo: seed.repoFullName ?? GITHUB_REPO,
          pr,
          prDetail: {},
          reviews: [],
          files: [],
          commits: [],
          commitsIncomplete: false,
        } as unknown as Prisma.InputJsonValue,
        truncated: false,
        fetchedAt: new Date(updatedAt),
      },
      select: { id: true },
    });
    const norm = normalizePullRequest(pr, [], [], [], {}, false)!;
    const change = await codeChanges.persist({
      workspaceId: context.workspaceId,
      connectorId: context.connectorId,
      repoExternalId: seed.repoFullName ?? GITHUB_REPO,
      externalId: norm.externalId,
      sourceUpdatedAt: updatedAt,
      // The importer resolves this by `gitUrl`; a repository the workspace does not hold
      // resolves to null, exactly as it does in production.
      workspaceRepoId: seed.repoFullName ? null : context.workspaceRepoId,
      norm,
    });
    // Explicit fixture declarations are written through the session service, not extracted from PR prose.
    if (!seed.repoFullName && seed.handoff !== false) {
      const existing = await prisma.intentHandoff.findFirst({
        where: { workspaceId: context.workspaceId, repoKey: INTENT_REPO_KEY, prNumber: seed.number },
      });
      const refs = (v?: string) =>
        v
          ? v.split(',').map((part) => {
              const [itemId, version] = part.trim().split('@');
              return { itemId, version: Number(version) };
            })
          : [];
      const input = SaveIntentHandoffSchema.parse({
        id: existing?.id ?? randomUUID(),
        expectedVersion: existing?.version ?? 0,
        idempotencyKey: randomUUID(),
        repoKey: INTENT_REPO_KEY,
        headSha: 'b'.repeat(40),
        prNumber: seed.number,
        bindings: [],
        delivers: refs(seed.delivers),
        retires: refs(seed.retires),
      });
      await new IntentHandoffService(prisma as unknown as PrismaService).save(
        context.workspaceId,
        { id: 'synthetic-owner', role: 'owner' },
        input,
      );
      const repo = await prisma.workspaceRepo.findUniqueOrThrow({ where: { id: context.workspaceRepoId } });
      const observation = { repo, pull: { ...pr, merged: Boolean(seed.mergedAt) } };
      const processor = new IntentHandoffProcessor(
        prisma as unknown as PrismaService,
        { pull: async () => observation } as never,
        {} as never,
        {} as never,
        releases,
        new GithubIntentReleaseService(prisma as unknown as PrismaService, releases),
      );
      await processor.process(context.workspaceId, input.id);
    }
    await projection.projectRawPayload({
      workspaceId: context.workspaceId,
      rawPayloadId: raw.id,
      codeChangeId: change.id,
    });
    return { rawPayloadId: raw.id, codeChangeId: change.id };
  }

  /**
   * The ledger stamps `recordedAt` with the SERVER clock, so "this merge happened after
   * the plan" is expressed RELATIVE to that clock. A calendar fixture would decide the
   * comparison by the hour the suite happens to run.
   */
  const mergedAfterThePlan = () => new Date(Date.now() + 60_000).toISOString();
  /** Long before any plan this suite writes — a historical production merge. */
  const mergedBeforeAnyPlan = '2020-01-01T00:00:00.000Z';

  const ledger = async (workspaceId: string) => readReleaseSnapshot(prisma as unknown as PrismaService, workspaceId);
  const kinds = async (workspaceId: string) =>
    (await prisma.intentReleaseEvent.findMany({ where: { workspaceId }, orderBy: { seq: 'asc' } })).map(
      (row) => row.kind,
    );

  it.each([
    [IntentReleaseTrigger.manual, IntentReleaseTrigger.merge, true],
    [IntentReleaseTrigger.merge, IntentReleaseTrigger.manual, false],
    [IntentReleaseTrigger.merge, IntentReleaseTrigger.deploy, false],
  ])('applies repository %s override %s to the real merge path', async (trigger, repoTrigger, delivered) => {
    const context = await setup(`repo-mode-${trigger}-${repoTrigger}`, { trigger, repoTrigger });
    await sync(context, {
      number: 501,
      delivers: 'cap-alpha@1',
      mergedAt: '2026-09-12T12:00:00Z',
      mergeCommitSha: 'a'.repeat(40),
    });
    const events = await prisma.intentReleaseEvent.findMany({
      where: { workspaceId: context.workspaceId, kind: 'release' },
    });
    expect(events.length).toBe(delivered ? 1 : 0);
    if (repoTrigger === IntentReleaseTrigger.manual) {
      expect(await prisma.intentReleaseEvent.count({ where: { workspaceId: context.workspaceId } })).toBe(0);
    }
  });

  it('preserves pre-handoff plans until their originating PR explicitly joins the new flow', async () => {
    const context = await setup('legacy-plan-cutover');
    await releases.record(
      context.workspaceId,
      { id: 'system:github-connector', role: 'system' },
      {
        kind: 'plan',
        itemId: 'cap-alpha',
        expectedVersion: 1,
        expectedHeadSeq: 0,
        idempotencyKey: randomUUID(),
        reason: 'Existing connector plan before cutover.',
        pr: { repoKey: INTENT_REPO_KEY, number: 1 },
      },
      ReleaseActorKind.Connector,
    );
    await sync(context, { number: 1, handoff: false });
    await sync(context, { number: 2, handoff: false });
    expect(await kinds(context.workspaceId)).toEqual(['plan']);
    expect((await ledger(context.workspaceId)).planState('cap-alpha')).toBe('active');

    await sync(context, { number: 1, delivers: 'cap-alpha@1' });
    expect(await kinds(context.workspaceId)).toEqual(['plan']);
    await sync(context, { number: 1 });
    expect(await kinds(context.workspaceId)).toEqual(['plan', 'withdraw']);
  });

  it('does not release a worker claim while reconciling session-only plans', async () => {
    const context = await setup('handoff-worker-claim');
    await sync(context, { number: 1 });
    const row = await prisma.intentHandoff.findFirstOrThrow({ where: { workspaceId: context.workspaceId } });
    const claimedUntil = new Date(Date.now() + 300_000);
    await prisma.intentHandoff.update({ where: { id: row.id }, data: { nextAttemptAt: claimedUntil } });
    await new GithubIntentReleaseService(prisma as unknown as PrismaService, releases).applyToHandoff(
      context.workspaceId,
      INTENT_REPO_KEY,
      1,
    );
    expect((await prisma.intentHandoff.findUniqueOrThrow({ where: { id: row.id } })).nextAttemptAt).toEqual(
      claimedUntil,
    );
    expect(await prisma.intentHandoff.count({ where: { id: row.id, nextAttemptAt: { lte: new Date() } } })).toBe(0);
  });

  it('reconciles session-only declaration edits without another GitHub import', async () => {
    const context = await setup('handoff-only');
    await sync(context, { number: 1 });
    const db = prisma as unknown as PrismaService;
    const store = new IntentHandoffService(db);
    const row = await prisma.intentHandoff.findFirstOrThrow({
      where: { workspaceId: context.workspaceId, prNumber: 1 },
    });
    const processor = new IntentHandoffProcessor(
      db,
      { pull: async () => ({ pull: { merged: false, state: 'open' } }) } as never,
      {} as never,
      {} as never,
      releases,
      new GithubIntentReleaseService(db, releases),
    );
    const input = SaveIntentHandoffSchema.parse({
      id: row.id,
      expectedVersion: row.version,
      idempotencyKey: randomUUID(),
      repoKey: INTENT_REPO_KEY,
      headSha: row.headSha,
      prNumber: 1,
      delivers: [{ itemId: 'cap-alpha', version: 1 }],
    });
    await store.save(context.workspaceId, { id: 'synthetic-owner', role: 'owner' }, input);
    await processor.process(context.workspaceId, row.id);
    expect((await ledger(context.workspaceId)).effectivity('cap-alpha')).toBe('planned');
    await store.save(
      context.workspaceId,
      { id: 'synthetic-owner', role: 'owner' },
      {
        ...input,
        expectedVersion: row.version + 1,
        idempotencyKey: randomUUID(),
        delivers: [],
      },
    );
    await processor.process(context.workspaceId, row.id);
    expect((await ledger(context.workspaceId)).effectivity('cap-alpha')).toBe('withdrawn');
  });

  it('plans on open, withdraws on close, and reinstates on reopen — never a second plan', async () => {
    const context = await setup('lifecycle');
    await sync(context, { number: 1, delivers: 'cap-alpha@1' });
    expect((await ledger(context.workspaceId)).effectivity('cap-alpha')).toBe('planned');

    await sync(context, { number: 1, delivers: 'cap-alpha@1', closed: true });
    expect((await ledger(context.workspaceId)).effectivity('cap-alpha')).toBe('withdrawn');

    await sync(context, { number: 1, delivers: 'cap-alpha@1' });
    expect((await ledger(context.workspaceId)).effectivity('cap-alpha')).toBe('planned');
    expect(await kinds(context.workspaceId)).toEqual(['plan', 'withdraw', 'reinstate']);

    // The plan event carries the PR it came from, written by the connector.
    const [plan] = await prisma.intentReleaseEvent.findMany({ where: { workspaceId: context.workspaceId, seq: 1 } });
    expect(plan.data).toMatchObject({
      itemId: 'cap-alpha',
      actorKind: ReleaseActorKind.Connector,
      pr: { repoKey: INTENT_REPO_KEY, number: 1 },
    });
    expect(plan.recordedBy).toBe('system:github-connector');
  });

  it('emits nothing on a re-sync that changed no pull-request fact', async () => {
    const context = await setup('idempotent');
    await sync(context, { number: 1, delivers: 'cap-alpha@1' });
    await sync(context, { number: 1, delivers: 'cap-alpha@1' });
    expect(await kinds(context.workspaceId)).toEqual(['plan']);
  });

  it('keeps an item planned while a second non-draft PR names it, and a draft PR never holds it', async () => {
    const context = await setup('two-prs');
    await sync(context, { number: 1, delivers: 'cap-alpha@1' });
    await sync(context, { number: 2, delivers: 'cap-alpha@1' });
    expect(await kinds(context.workspaceId)).toEqual(['plan']);

    await sync(context, { number: 1, delivers: 'cap-alpha@1', closed: true });
    expect((await ledger(context.workspaceId)).effectivity('cap-alpha')).toBe('planned');

    // #3 is a draft naming the same item: it neither plans nor holds the plan.
    await sync(context, { number: 3, delivers: 'cap-alpha@1', draft: true });
    await sync(context, { number: 2, delivers: 'cap-alpha@1', closed: true });
    expect((await ledger(context.workspaceId)).effectivity('cap-alpha')).toBe('withdrawn');
  });

  it('withdraws an item removed from the handoff of a still-open pull request', async () => {
    const context = await setup('removal');
    await sync(context, { number: 1, delivers: 'cap-alpha@1' });
    await sync(context, { number: 1 });
    expect(await kinds(context.workspaceId)).toEqual(['plan', 'withdraw']);
  });

  it('keeps the plan when an unrelated pull request that declared nothing syncs', async () => {
    const context = await setup('unrelated-sweep');
    await sync(context, { number: 1, delivers: 'cap-alpha@1' });
    // #2 has no handoff at all: its sync runs the sweep, but #1 still holds the plan.
    await sync(context, { number: 2, handoff: false });
    expect(await kinds(context.workspaceId)).toEqual(['plan']);
    expect((await ledger(context.workspaceId)).planState('cap-alpha')).toBe('active');

    // Only the holder closing takes the plan away.
    await sync(context, { number: 1, delivers: 'cap-alpha@1', closed: true });
    expect(await kinds(context.workspaceId)).toEqual(['plan', 'withdraw']);
  });

  it('keeps the plan of an OPEN pull request whose handoff a stale observation discarded', async () => {
    const context = await setup('discarded-open-holder');
    await sync(context, { number: 1, delivers: 'cap-alpha@1' });
    // The handoff worker observed #1 as closed and discarded the handoff, while the
    // imported pull request is still open. An open pull request holds what it declared:
    // an unrelated sync must not read the discard as "nobody names this item".
    const db = prisma as unknown as PrismaService;
    const row = await prisma.intentHandoff.findFirstOrThrow({
      where: { workspaceId: context.workspaceId, prNumber: 1 },
    });
    await new IntentHandoffProcessor(
      db,
      { pull: async () => ({ pull: { merged: false, state: 'closed' } }) } as never,
      {} as never,
      {} as never,
      releases,
      new GithubIntentReleaseService(db, releases),
    ).process(context.workspaceId, row.id);
    expect((await prisma.intentHandoff.findUniqueOrThrow({ where: { id: row.id } })).deliveryState).toBe('discarded');

    await sync(context, { number: 2, handoff: false });
    expect(await kinds(context.workspaceId)).toEqual(['plan']);
    expect((await ledger(context.workspaceId)).planState('cap-alpha')).toBe('active');
  });

  it('counts a long-lived PR whose raw payload the retention sweep already deleted', async () => {
    const context = await setup('retention');
    const a = await sync(context, { number: 1, delivers: 'cap-alpha@1' });
    await sync(context, { number: 2, delivers: 'cap-alpha@1' });
    // The retention job sweeps raw payloads; the trailer projection on the row survives.
    await prisma.deliveryRawPayload.delete({ where: { id: a.rawPayloadId } });

    await sync(context, { number: 2, delivers: 'cap-alpha@1', closed: true });
    expect(await kinds(context.workspaceId)).toEqual(['plan']);
    expect((await ledger(context.workspaceId)).effectivity('cap-alpha')).toBe('planned');
  });

  it('records the delivery when a merge-mode PR merges into the production branch', async () => {
    const context = await setup('merge');
    await sync(context, { number: 1, delivers: 'cap-alpha@1' });
    await sync(context, {
      number: 1,
      delivers: 'cap-alpha@1',
      mergedAt: '2026-09-11T12:00:00.000Z',
      mergeCommitSha: 'a'.repeat(40),
    });

    const snapshot = await ledger(context.workspaceId);
    expect(snapshot.effectivity('cap-alpha')).toBe('effective');
    expect(await kinds(context.workspaceId)).toEqual(['plan', 'release']);
    expect(snapshot.currentRelease).toMatchObject({
      deliveredRef: 'a'.repeat(40),
      repoKey: INTENT_REPO_KEY,
      orderingToken: '2026-09-11T12:00:00.000Z',
      actorKind: ReleaseActorKind.Connector,
      pr: { repoKey: INTENT_REPO_KEY, number: 1 },
    });
  });

  it('records nothing when the merge went into a branch that is not production', async () => {
    const context = await setup('feature-branch', { productionBranch: 'release' });
    await sync(context, {
      number: 1,
      delivers: 'cap-alpha@1',
      targetBranch: 'main',
      mergedAt: '2026-09-11T12:00:00.000Z',
      mergeCommitSha: 'b'.repeat(40),
    });
    expect(await kinds(context.workspaceId)).toEqual([]);
    expect((await ledger(context.workspaceId)).effectivity('cap-alpha')).toBe('unknown');
  });

  it('never records a release in deploy mode — the CI step is that actor', async () => {
    const context = await setup('deploy-mode', { trigger: IntentReleaseTrigger.deploy });
    await sync(context, { number: 1, delivers: 'cap-alpha@1' });
    await sync(context, {
      number: 1,
      delivers: 'cap-alpha@1',
      mergedAt: '2026-09-11T12:00:00.000Z',
      mergeCommitSha: 'c'.repeat(40),
    });
    expect(await kinds(context.workspaceId)).toEqual(['plan']);
  });

  it('does not withdraw another repository plan after that repository switches to manual', async () => {
    const a = await setup('manual-plan-owner');
    await sync(a, { number: 1, delivers: 'cap-alpha@1' });
    await prisma.workspaceRepo.update({ where: { id: a.workspaceRepoId }, data: { intentReleaseTrigger: 'manual' } });
    const repo = await prisma.workspaceRepo.create({
      data: {
        workspaceId: a.workspaceId,
        repoKey: graphRepoHashOf('github.com/acme/other'),
        repoName: 'other',
        intentRepoKey: 'github.com/acme/other',
        intentReleaseTrigger: 'merge',
      },
    });
    await sync({ ...a, workspaceRepoId: repo.id }, { number: 2 });
    expect(await kinds(a.workspaceId)).toEqual(['plan']);
    expect((await ledger(a.workspaceId)).planState('cap-alpha')).toBe('active');
  });

  it('leaves a manual workspace byte-for-byte inert', async () => {
    const context = await setup('manual-mode', { trigger: IntentReleaseTrigger.manual });
    await sync(context, {
      number: 1,
      delivers: 'cap-alpha@1',
      mergedAt: '2026-09-11T12:00:00.000Z',
      mergeCommitSha: 'd'.repeat(40),
    });
    expect(await kinds(context.workspaceId)).toEqual([]);
  });

  it('never withdraws the plan a rollback restored — the merged PR still names its items', async () => {
    const context = await setup('rollback');
    await sync(context, { number: 1, delivers: 'cap-alpha@1' });
    await sync(context, {
      number: 1,
      delivers: 'cap-alpha@1',
      mergedAt: mergedAfterThePlan(),
      mergeCommitSha: 'f'.repeat(40),
    });
    const merged = await ledger(context.workspaceId);
    expect(merged.effectivity('cap-alpha')).toBe('effective');

    // The maintainer rolls the delivery back (§1.5/AC4): the consumed plan returns, and
    // the pull request that named it is merged, so no OPEN pull request names it.
    await releases.record(
      context.workspaceId,
      { id: 'synthetic-owner', role: 'owner' },
      {
        kind: 'rollback',
        releaseSeq: merged.currentRelease!.seq,
        idempotencyKey: `rollback-${context.workspaceId}`,
        expectedHeadSeq: merged.headSeq,
        reason: 'Production restored',
      },
    );
    expect((await ledger(context.workspaceId)).effectivity('cap-alpha')).toBe('planned');

    // An unrelated pull request syncs and runs the sweep.
    await sync(context, { number: 2 });
    expect(await kinds(context.workspaceId)).toEqual(['plan', 'release', 'rollback']);
    expect((await ledger(context.workspaceId)).effectivity('cap-alpha')).toBe('planned');
  });

  it('withdraws when the only other PR naming the item merged into a non-production branch', async () => {
    const context = await setup('non-production-merge');
    // #1 is merged, but into a feature branch: it delivered nothing, so it holds no plan.
    await sync(context, {
      number: 1,
      delivers: 'cap-alpha@1',
      targetBranch: 'feature/x',
      mergedAt: '2026-09-11T12:00:00.000Z',
      mergeCommitSha: '2'.repeat(40),
    });
    await sync(context, { number: 2, delivers: 'cap-alpha@1' });
    expect((await ledger(context.workspaceId)).effectivity('cap-alpha')).toBe('planned');

    await sync(context, { number: 2, delivers: 'cap-alpha@1', closed: true });
    expect(await kinds(context.workspaceId)).toEqual(['plan', 'withdraw']);
    expect((await ledger(context.workspaceId)).effectivity('cap-alpha')).toBe('withdrawn');
  });

  it('withdraws when the only other PR naming the item merged without ever planning it', async () => {
    // The merge happened while the workspace was `manual`, so it wrote no plan event at
    // all. A historical production merge is not a plan holder: the only live plan is #2's,
    // and closing #2 must withdraw it.
    const context = await setup('historical-merge', { trigger: IntentReleaseTrigger.manual });
    await sync(context, {
      number: 1,
      delivers: 'cap-alpha@1',
      mergedAt: mergedBeforeAnyPlan,
      mergeCommitSha: '4'.repeat(40),
    });
    expect(await kinds(context.workspaceId)).toEqual([]);

    await prisma.workspace.update({
      where: { id: context.workspaceId },
      data: { intentReleaseTrigger: IntentReleaseTrigger.deploy },
    });
    await sync(context, { number: 2, delivers: 'cap-alpha@1' });
    expect((await ledger(context.workspaceId)).effectivity('cap-alpha')).toBe('planned');

    await sync(context, { number: 2, delivers: 'cap-alpha@1', closed: true });
    expect(await kinds(context.workspaceId)).toEqual(['plan', 'withdraw']);
    expect((await ledger(context.workspaceId)).effectivity('cap-alpha')).toBe('withdrawn');
  });

  it('keeps the plan of a deploy-mode PR merged into production while the deploy is pending', async () => {
    const context = await setup('deploy-pending', { trigger: IntentReleaseTrigger.deploy });
    await sync(context, { number: 1, delivers: 'cap-alpha@1' });
    await sync(context, {
      number: 1,
      delivers: 'cap-alpha@1',
      mergedAt: mergedAfterThePlan(),
      mergeCommitSha: '3'.repeat(40),
    });

    // The CI step has not recorded the release yet; an unrelated sync runs the sweep.
    await sync(context, { number: 2 });
    expect(await kinds(context.workspaceId)).toEqual(['plan']);
    expect((await ledger(context.workspaceId)).effectivity('cap-alpha')).toBe('planned');
  });

  it('keeps a shared plan alive when the PR that merged it is not the one that planned it', async () => {
    // #1 writes the plan, #2 names the same item, #1 closes unmerged, #2 merges into
    // production. In `deploy` mode the CI record is still pending, so the plan must
    // survive the next unrelated sweep — the item IS in production-bound code.
    const context = await setup('shared-plan', { trigger: IntentReleaseTrigger.deploy });
    await sync(context, { number: 1, delivers: 'cap-alpha@1' });
    await sync(context, { number: 2, delivers: 'cap-alpha@1' });
    await sync(context, { number: 1, delivers: 'cap-alpha@1', closed: true });
    expect(await kinds(context.workspaceId)).toEqual(['plan']);

    await sync(context, {
      number: 2,
      delivers: 'cap-alpha@1',
      mergedAt: mergedAfterThePlan(),
      mergeCommitSha: '7'.repeat(40),
    });
    await sync(context, { number: 3 });
    expect(await kinds(context.workspaceId)).toEqual(['plan']);
    expect((await ledger(context.workspaceId)).effectivity('cap-alpha')).toBe('planned');
  });

  it('keeps a rolled-back plan alive when another PR merged it into production', async () => {
    // Same shared plan, `merge` mode: #2's merge records the delivery, the maintainer
    // rolls it back, and the restored plan must not be swept because the PR holding it
    // is #2 rather than the #1 that wrote the plan event.
    const context = await setup('shared-plan-rollback');
    await sync(context, { number: 1, delivers: 'cap-alpha@1' });
    await sync(context, { number: 2, delivers: 'cap-alpha@1' });
    await sync(context, { number: 1, delivers: 'cap-alpha@1', closed: true });
    await sync(context, {
      number: 2,
      delivers: 'cap-alpha@1',
      mergedAt: mergedAfterThePlan(),
      mergeCommitSha: '8'.repeat(40),
    });
    const merged = await ledger(context.workspaceId);
    expect(merged.effectivity('cap-alpha')).toBe('effective');

    await releases.record(
      context.workspaceId,
      { id: 'synthetic-owner', role: 'owner' },
      {
        kind: 'rollback',
        releaseSeq: merged.currentRelease!.seq,
        idempotencyKey: `rollback-${context.workspaceId}`,
        expectedHeadSeq: merged.headSeq,
        reason: 'Production restored',
      },
    );
    await sync(context, { number: 3 });
    expect(await kinds(context.workspaceId)).toEqual(['plan', 'release', 'rollback']);
    expect((await ledger(context.workspaceId)).effectivity('cap-alpha')).toBe('planned');
  });

  it('records nothing for a pull request whose repository is not linked to a workspace repo', async () => {
    const context = await setup('unlinked-repo');
    const UNLINKED = 'synthetic/not-linked';
    const warn = vi.spyOn(Logger.prototype, 'warn');
    let openLog: string[] = [];
    let mergedLog: string[] = [];
    let quietLog: string[] = [];
    try {
      await sync(context, { number: 1, repoFullName: UNLINKED, delivers: 'cap-alpha@1' });
      openLog = warn.mock.calls.flat().map(String);
      warn.mockClear();

      await sync(context, {
        number: 1,
        repoFullName: UNLINKED,
        delivers: 'cap-alpha@1',
        mergedAt: '2026-09-11T12:00:00.000Z',
        mergeCommitSha: '9'.repeat(40),
      });
      mergedLog = warn.mock.calls.flat().map(String);
      warn.mockClear();

      // A trailer-less unlinked PR asks nothing of intent: it must pass in silence.
      await sync(context, { number: 2, repoFullName: UNLINKED });
      quietLog = warn.mock.calls.flat().map(String);
    } finally {
      warn.mockRestore();
    }

    expect(await kinds(context.workspaceId)).toEqual([]);
    expect((await ledger(context.workspaceId)).effectivity('cap-alpha')).toBe('unknown');
    expect(openLog.filter((line) => line.includes(`PR ${UNLINKED}#1`))).toHaveLength(0);
    expect(mergedLog.filter((line) => line.includes(`PR ${UNLINKED}#1`))).toHaveLength(0);
    expect(quietLog.filter((line) => line.includes(`PR ${UNLINKED}#2`))).toHaveLength(0);
  });

  it('withdraws when the PR that planned an item closes and only an unlinked PR still names it', async () => {
    const context = await setup('unlinked-holder');
    await sync(context, { number: 1, delivers: 'cap-alpha@1' });
    // #2 lives in a repository the workspace does not hold: it can hold no plan.
    await sync(context, { number: 2, repoFullName: 'synthetic/not-linked', delivers: 'cap-alpha@1' });
    await sync(context, { number: 1, delivers: 'cap-alpha@1', closed: true });

    expect(await kinds(context.workspaceId)).toEqual(['plan', 'withdraw']);
    expect((await ledger(context.workspaceId)).effectivity('cap-alpha')).toBe('withdrawn');
  });
});
