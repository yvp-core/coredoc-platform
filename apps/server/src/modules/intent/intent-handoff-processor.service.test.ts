import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service.js';
import type { GithubIntentReleaseService } from './github-intent-release.service.js';
import { IntentErrorCode } from './contract/index.js';
import { IntentHandoffProcessor } from './intent-handoff-processor.service.js';
import type { IntentHandoffAnchorsService } from './intent-handoff-anchors.service.js';
import type { IntentHandoffGithubService } from './intent-handoff-github.service.js';
import type { IntentReleaseService } from './intent-release.service.js';
import type { WorkspaceMcpContextService } from '../../mcp/workspace-mcp-context.service.js';

function mockPrisma(workspace: { intentEnabled: boolean; intentReleaseTrigger: string } | null) {
  return {
    workspace: {
      findUnique: vi.fn().mockResolvedValue(workspace),
      findUniqueOrThrow: vi.fn().mockResolvedValue(workspace),
    },
    intentHandoff: { findFirst: vi.fn().mockResolvedValue(null), updateMany: vi.fn() },
    intentReleaseEvent: { findMany: vi.fn().mockResolvedValue([]) },
    workspaceRepo: { count: vi.fn().mockResolvedValue(1) },
  } as unknown as PrismaService & Record<string, Record<string, ReturnType<typeof vi.fn>>>;
}

function build(prisma: PrismaService) {
  const github = { pull: vi.fn(), source: vi.fn(), includes: vi.fn() } as unknown as IntentHandoffGithubService;
  const plans = { applyToHandoff: vi.fn() } as unknown as GithubIntentReleaseService;
  const releases = { record: vi.fn(), assertServiceTokenMayRecord: vi.fn() } as unknown as IntentReleaseService;
  const processor = new IntentHandoffProcessor(
    prisma,
    github,
    {} as WorkspaceMcpContextService,
    {} as IntentHandoffAnchorsService,
    releases,
    plans,
  );
  return { processor, github, plans, releases };
}

describe('IntentHandoffProcessor — intentEnabled gate', () => {
  it('process() touches neither GitHub nor the ledger nor the handoff row when intent is disabled', async () => {
    const prisma = mockPrisma({ intentEnabled: false, intentReleaseTrigger: 'merge' });
    const { processor, github, plans } = build(prisma);
    await processor.process('ws_1', 'h_1');
    expect(prisma.intentHandoff.findFirst).not.toHaveBeenCalled();
    // The row keeps its nextAttemptAt, so re-enabling the flag resumes it.
    expect(prisma.intentHandoff.updateMany).not.toHaveBeenCalled();
    expect(github.pull).not.toHaveBeenCalled();
    expect(plans.applyToHandoff).not.toHaveBeenCalled();
  });

  it('process() reads the handoff again once intent is enabled', async () => {
    const prisma = mockPrisma({ intentEnabled: true, intentReleaseTrigger: 'merge' });
    const { processor } = build(prisma);
    await processor.process('ws_1', 'h_1');
    expect(prisma.intentHandoff.findFirst).toHaveBeenCalled();
  });

  it('recordDeployment() refuses by name instead of answering 200', async () => {
    const prisma = mockPrisma({ intentEnabled: false, intentReleaseTrigger: 'deploy' });
    const { processor, github } = build(prisma);
    await expect(
      processor.recordDeployment('ws_1', {
        kind: 'release',
        repoKey: 'github.com/acme/api',
        deliveredRef: 'a'.repeat(40),
        deployId: 'run-1',
        deployedAt: '2026-09-14T12:00:00Z',
      }),
    ).rejects.toMatchObject({
      publicError: { code: IntentErrorCode.IntentDisabled },
      status: 409,
    });
    expect(prisma.workspaceRepo.count).not.toHaveBeenCalled();
    expect(github.source).not.toHaveBeenCalled();
  });
});

describe('IntentHandoffProcessor — a push after the save does not invalidate the handoff', () => {
  const saved = 'a'.repeat(40);
  const pushed = 'b'.repeat(40);
  const row = {
    id: 'h_1',
    workspaceId: 'ws_1',
    repoKey: 'github.com/acme/api',
    version: 1,
    headSha: saved,
    prNumber: 7,
    mappingState: 'pending',
    deliveryState: 'pending',
    payload: { bindings: [], delivers: [{ itemId: 'br-1', version: 1 }], retires: [], supersedesMappingIds: [] },
    results: [],
  };
  const pull = {
    merged: true,
    state: 'closed',
    head: { sha: pushed },
    base: { ref: 'main', repo: { default_branch: 'main' } },
    merge_commit_sha: 'c'.repeat(40),
    merged_at: '2026-09-14T12:00:00Z',
  };
  const repo = { repoKey: 'hash', productionBranch: 'main', intentReleaseTrigger: 'deploy' };

  it('merge path delivers the merged PR whose head moved past the saved commit', async () => {
    const prisma = mockPrisma({ intentEnabled: true, intentReleaseTrigger: 'merge' });
    prisma.intentHandoff.findFirst.mockResolvedValue(row);
    const { processor, github } = build(prisma);
    (github.pull as ReturnType<typeof vi.fn>).mockResolvedValue({ pull, repo });
    const deliver = vi.spyOn(processor as never, 'deliver').mockResolvedValue(undefined as never);
    await processor.process('ws_1', 'h_1');
    expect(deliver).toHaveBeenCalledWith(row, 'deploy', pull.merge_commit_sha, pull.merged_at);
    const writes = prisma.intentHandoff.updateMany.mock.calls.map(([arg]) => arg.data);
    expect(writes).not.toContainEqual(expect.objectContaining({ mappingReason: 'stale_handoff' }));
    expect(writes).toContainEqual(expect.objectContaining({ mappingState: 'applied' }));
  });

  it('deploy path records the delivery of the merged PR whose head moved past the saved commit', async () => {
    const prisma = mockPrisma({ intentEnabled: true, intentReleaseTrigger: 'deploy' });
    prisma.intentHandoff.findFirst.mockResolvedValue(row);
    const { processor, github, releases } = build(prisma);
    (github.source as ReturnType<typeof vi.fn>).mockResolvedValue({ repo });
    (github.pull as ReturnType<typeof vi.fn>).mockResolvedValue({ pull, repo });
    (github.includes as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (releases.record as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: 'recorded' });
    await expect(
      processor.recordDeployment('ws_1', {
        kind: 'release',
        repoKey: row.repoKey,
        handoffId: row.id,
        deliveredRef: pull.merge_commit_sha,
        deployId: 'run-1',
        deployedAt: '2026-09-14T13:00:00Z',
      }),
    ).resolves.toEqual({ outcome: 'recorded' });
    expect(releases.record).toHaveBeenCalledWith(
      'ws_1',
      expect.anything(),
      expect.objectContaining({ trailers: { delivers: row.payload.delivers, retires: [] } }),
      expect.anything(),
      { id: row.id, version: row.version },
    );
  });
});

describe('IntentHandoffProcessor — one deploy records every included PR', () => {
  const ref = 'd'.repeat(40);
  const repo = { repoKey: 'hash', productionBranch: 'main', intentReleaseTrigger: 'deploy' };
  const handoff = (id: string, prNumber: number, mergeCommit: string, mergedAt: string) => ({
    id,
    workspaceId: 'ws_1',
    repoKey: 'github.com/acme/api',
    version: 1,
    prNumber,
    mergeCommit,
    mergedAt: new Date(mergedAt),
    mappingState: 'applied',
    deliveryState: 'pending',
    payload: {
      bindings: [],
      delivers: [{ itemId: `br-${prNumber}`, version: 1 }],
      retires: [],
      supersedesMappingIds: [],
    },
    results: [],
  });
  const first = handoff('h_1', 1, '1'.repeat(40), '2026-09-14T10:00:00Z');
  const second = handoff('h_2', 2, '2'.repeat(40), '2026-09-14T11:00:00Z');
  const notShipped = handoff('h_3', 3, '3'.repeat(40), '2026-09-14T12:00:00Z');

  it('records each included pending merged handoff in merge order, without a handoffId', async () => {
    const prisma = mockPrisma({ intentEnabled: true, intentReleaseTrigger: 'deploy' });
    (prisma.intentHandoff as unknown as Record<string, ReturnType<typeof vi.fn>>).findMany = vi
      .fn()
      .mockResolvedValue([first, second, notShipped]);
    const { processor, github, releases } = build(prisma);
    (github.source as ReturnType<typeof vi.fn>).mockResolvedValue({ repo });
    (github.includes as ReturnType<typeof vi.fn>).mockImplementation(
      async (_s, merge: string) => merge !== notShipped.mergeCommit,
    );
    (github.pull as ReturnType<typeof vi.fn>).mockImplementation(async (_w, _r, number: number) => ({
      repo,
      pull: {
        merged: true,
        base: { ref: 'main', repo: { default_branch: 'main' } },
        merge_commit_sha: `${number}`.repeat(40),
        merged_at: '2026-09-14T10:00:00Z',
      },
    }));
    let seq = 0;
    (releases.record as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      event: { seq: ++seq },
      headSeq: seq,
    }));
    const deployment = {
      kind: 'release' as const,
      repoKey: first.repoKey,
      deliveredRef: ref,
      deployId: 'run-1',
      deployedAt: '2026-09-14T13:00:00Z',
    };
    const result = await processor.recordDeployment('ws_1', deployment);
    expect(result).toMatchObject({
      event: { seq: 2 },
      deliveries: [
        { handoffId: 'h_1', pr: 1, outcome: 'recorded', seq: 1 },
        { handoffId: 'h_2', pr: 2, outcome: 'recorded', seq: 2 },
      ],
    });
    const calls = (releases.record as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.map(([, , input]) => input.pr.number)).toEqual([1, 2]);
    expect(calls.map(([, , , , h]) => h.id)).toEqual(['h_1', 'h_2']);
    expect(calls[0][1]).toEqual({ id: 'system:intent-deployment', role: 'system' });

    // The service-token actor lane passes its own actor through.
    (releases.record as ReturnType<typeof vi.fn>).mockClear();
    await processor.recordDeployment('ws_1', deployment, { id: 'service-token:t1', role: 'service' });
    expect((releases.record as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual({
      id: 'service-token:t1',
      role: 'service',
    });
  });

  it('a retry of a deploy re-attempts only the PRs that failed in that deploy', async () => {
    const prisma = mockPrisma({ intentEnabled: true, intentReleaseTrigger: 'deploy' });
    (prisma.intentReleaseEvent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { data: { repoKey: first.repoKey, deployId: 'run-1', pr: { repoKey: first.repoKey, number: 1 } } },
    ]);
    const findMany = vi.fn().mockResolvedValue([]);
    (prisma.intentHandoff as unknown as Record<string, ReturnType<typeof vi.fn>>).findMany = findMany;
    const { processor, github } = build(prisma);
    (github.source as ReturnType<typeof vi.fn>).mockResolvedValue({ repo });
    await processor.recordDeployment('ws_1', {
      kind: 'release',
      repoKey: first.repoKey,
      deliveredRef: ref,
      deployId: 'run-1',
      deployedAt: '2026-09-14T13:00:00Z',
    });
    expect(findMany.mock.calls[0][0].where.OR).toEqual([
      { deliveryState: 'pending' },
      { prNumber: { in: [1] } },
      { deliveryState: 'needs_attention', deliveryDeployId: 'run-1' },
    ]);
  });

  it('answers no_delivery when the ref includes no pending merged handoff', async () => {
    const prisma = mockPrisma({ intentEnabled: true, intentReleaseTrigger: 'deploy' });
    (prisma.intentHandoff as unknown as Record<string, ReturnType<typeof vi.fn>>).findMany = vi
      .fn()
      .mockResolvedValue([notShipped]);
    const { processor, github, releases } = build(prisma);
    (github.source as ReturnType<typeof vi.fn>).mockResolvedValue({ repo });
    (github.includes as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    await expect(
      processor.recordDeployment('ws_1', {
        kind: 'release',
        repoKey: first.repoKey,
        deliveredRef: ref,
        deployId: 'run-1',
        deployedAt: '2026-09-14T13:00:00Z',
      }),
    ).resolves.toEqual({ outcome: 'no_delivery', reason: 'no_handoff' });
    expect(releases.record).not.toHaveBeenCalled();
  });
});

describe('IntentHandoffProcessor — per-item ordering and bounded retries (BR-6)', () => {
  const base = {
    workspaceId: 'ws_1',
    repoKey: 'github.com/acme/api',
    version: 1,
    headSha: 'a'.repeat(40),
    mappingState: 'pending',
    deliveryState: 'pending',
    mappingReason: null,
    deliveryReason: null,
    results: [],
    deliveryAttempts: 0,
    mappingAttempts: 0,
    mergedAt: null as Date | null,
    prObservedAt: null as Date | null,
  };
  const declaring = (id: string, prNumber: number, itemId: string) => ({
    ...base,
    id,
    prNumber,
    payload: { bindings: [], delivers: [{ itemId, version: 1 }], retires: [], supersedesMappingIds: [] },
  });

  it('waits only on an earlier merge that shares one of its items', async () => {
    const prisma = mockPrisma({ intentEnabled: true, intentReleaseTrigger: 'merge' });
    const merged = new Date('2026-09-20T12:00:00Z');
    const earlier = new Date('2026-09-20T11:00:00Z');
    const disjoint = { ...declaring('h_x', 1, 'item-x'), mergedAt: earlier };
    const shared = { ...declaring('h_z', 2, 'item-y'), mergedAt: earlier };
    const findMany = vi.fn().mockResolvedValue([disjoint]);
    (prisma.intentHandoff as Record<string, unknown>).findMany = findMany;
    const { processor } = build(prisma);
    const hasEarlierMerge = (
      processor as never as { hasEarlierMerge: (r: unknown, d: Date) => Promise<boolean> }
    ).hasEarlierMerge.bind(processor);
    const row = declaring('h_y', 3, 'item-y');
    await expect(hasEarlierMerge(row, merged)).resolves.toBe(false);
    findMany.mockResolvedValue([disjoint, shared]);
    await expect(hasEarlierMerge(row, merged)).resolves.toBe(true);
  });

  const pull = {
    merged: true,
    state: 'closed',
    base: { ref: 'main', repo: { default_branch: 'main' } },
    merge_commit_sha: 'c'.repeat(40),
    merged_at: '2026-09-20T12:00:00Z',
  };
  const repo = { repoKey: 'hash', productionBranch: 'main', intentReleaseTrigger: 'merge' };

  it('moves a post-merge retryable delivery to needs_attention once the bound is reached', async () => {
    const prisma = mockPrisma({ intentEnabled: true, intentReleaseTrigger: 'merge' });
    const row = { ...declaring('h_1', 7, 'item-y'), mergedAt: new Date(pull.merged_at) };
    const latest = { ...row, mappingState: 'applied', deliveryReason: 'delivery_retryable', deliveryAttempts: 11 };
    prisma.intentHandoff.findFirst.mockResolvedValueOnce(row).mockResolvedValueOnce(latest);
    const { processor, github } = build(prisma);
    (github.pull as ReturnType<typeof vi.fn>).mockResolvedValue({ pull, repo });
    vi.spyOn(processor as never, 'deliver').mockResolvedValue(undefined as never);
    await processor.process('ws_1', 'h_1');
    const calls = prisma.intentHandoff.updateMany.mock.calls.map((call: unknown[]) => call[0]);
    expect(calls.at(-2)?.data).toEqual({ deliveryAttempts: 12, mappingAttempts: 0, nextAttemptAt: null });
    // The exhausted half moves only while still pending: a concurrent CI record is never overwritten.
    expect(calls.at(-1)).toEqual({
      where: { id: 'h_1', workspaceId: 'ws_1', version: 1, deliveryState: 'pending' },
      data: { deliveryState: 'needs_attention' },
    });
  });

  it('counts a post-merge retry below the bound and keeps it pending', async () => {
    const prisma = mockPrisma({ intentEnabled: true, intentReleaseTrigger: 'merge' });
    const row = { ...declaring('h_1', 7, 'item-y'), mergedAt: new Date(pull.merged_at) };
    const latest = { ...row, mappingState: 'applied', deliveryReason: 'awaiting_earlier_merge', deliveryAttempts: 3 };
    prisma.intentHandoff.findFirst.mockResolvedValueOnce(row).mockResolvedValueOnce(latest);
    const { processor, github } = build(prisma);
    (github.pull as ReturnType<typeof vi.fn>).mockResolvedValue({ pull, repo });
    vi.spyOn(processor as never, 'deliver').mockResolvedValue(undefined as never);
    await processor.process('ws_1', 'h_1');
    const data = prisma.intentHandoff.updateMany.mock.calls.at(-1)?.[0].data;
    expect(data).toMatchObject({ deliveryAttempts: 4 });
    expect(data).not.toHaveProperty('deliveryState');
    expect(data.nextAttemptAt).toBeInstanceOf(Date);
  });

  it('never bounds a pending open PR or a merge waiting for graph publication', async () => {
    const prisma = mockPrisma({ intentEnabled: true, intentReleaseTrigger: 'merge' });
    const row = { ...declaring('h_1', 7, 'item-y'), deliveryAttempts: 99 };
    // An open PR returns before the bound is evaluated at all.
    prisma.intentHandoff.findFirst.mockResolvedValueOnce(row);
    const { processor, github } = build(prisma);
    (github.pull as ReturnType<typeof vi.fn>).mockResolvedValue({
      pull: { ...pull, merged: false, state: 'open' },
      repo,
    });
    await processor.process('ws_1', 'h_1');
    const writes = prisma.intentHandoff.updateMany.mock.calls.map(([arg]) => arg.data);
    expect(writes).not.toContainEqual(expect.objectContaining({ deliveryAttempts: expect.anything() }));
    expect(writes).not.toContainEqual(expect.objectContaining({ deliveryState: 'needs_attention' }));
    expect(writes).toContainEqual(
      expect.objectContaining({ deliveryState: 'pending', deliveryReason: 'merge_not_confirmed' }),
    );

    const merged = { ...row, mergedAt: new Date(pull.merged_at) };
    const waiting = {
      ...merged,
      deliveryState: 'recorded',
      mappingReason: 'snapshot_does_not_include_merge',
      mappingAttempts: 99,
    };
    prisma.intentHandoff.findFirst.mockResolvedValueOnce(merged).mockResolvedValueOnce(waiting);
    vi.spyOn(processor as never, 'deliver').mockResolvedValue(undefined as never);
    (github.pull as ReturnType<typeof vi.fn>).mockResolvedValue({ pull, repo });
    await processor.process('ws_1', 'h_1');
    const after = prisma.intentHandoff.updateMany.mock.calls.at(-1)?.[0].data;
    expect(after).toMatchObject({ mappingAttempts: 99 });
    expect(after).not.toHaveProperty('mappingState');
  });
});
