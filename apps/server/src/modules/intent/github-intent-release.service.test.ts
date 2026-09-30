import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service.js';
import { GithubIntentReleaseService } from './github-intent-release.service.js';
import type { IntentReleaseService } from './intent-release.service.js';
import { IntentErrorCode } from './contract/index.js';
import { intentConflict } from './intent-state-errors.js';

function mockPrisma(workspace: { intentEnabled: boolean; intentReleaseTrigger: string } | null) {
  return {
    workspace: { findUnique: vi.fn().mockResolvedValue(workspace) },
    codeChange: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    workspaceRepo: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    intentHandoff: { findFirst: vi.fn().mockResolvedValue(null), updateMany: vi.fn() },
    intentReleaseEvent: { count: vi.fn().mockResolvedValue(0) },
  } as unknown as PrismaService & Record<string, { findFirst: ReturnType<typeof vi.fn> }>;
}

const releases = {} as IntentReleaseService;

describe('GithubIntentReleaseService — intentEnabled gate', () => {
  it('does nothing at all when the workspace has intent disabled', async () => {
    const prisma = mockPrisma({ intentEnabled: false, intentReleaseTrigger: 'merge' });
    await new GithubIntentReleaseService(prisma, releases).applyToCodeChange('ws_1', 'cc_1');
    expect(prisma.workspace.findUnique).toHaveBeenCalledWith({
      where: { id: 'ws_1' },
      select: { intentEnabled: true, intentReleaseTrigger: true },
    });
    // The gate is BEFORE any plan/withdraw/release read: no code change, no handoff, no ledger.
    expect(prisma.codeChange.findFirst).not.toHaveBeenCalled();
    expect(prisma.intentHandoff.findFirst).not.toHaveBeenCalled();
    expect(prisma.intentReleaseEvent.count).not.toHaveBeenCalled();
  });

  it('does nothing when the workspace row is missing', async () => {
    const prisma = mockPrisma(null);
    await new GithubIntentReleaseService(prisma, releases).applyToCodeChange('ws_1', 'cc_1');
    expect(prisma.codeChange.findFirst).not.toHaveBeenCalled();
  });

  it('proceeds past the gate when intent is enabled', async () => {
    const prisma = mockPrisma({ intentEnabled: true, intentReleaseTrigger: 'merge' });
    await new GithubIntentReleaseService(prisma, releases).applyToCodeChange('ws_1', 'cc_1');
    expect(prisma.codeChange.findFirst).toHaveBeenCalled();
  });

  it('gates the handoff entry point on the same flag', async () => {
    const prisma = mockPrisma({ intentEnabled: false, intentReleaseTrigger: 'merge' });
    (prisma.workspaceRepo.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'repo_1' });
    (prisma.codeChange.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'cc_1' });
    await new GithubIntentReleaseService(prisma, releases).applyToHandoff('ws_1', 'github.com/acme/api', 7);
    expect(prisma.intentHandoff.findFirst).not.toHaveBeenCalled();
    expect(prisma.intentReleaseEvent.count).not.toHaveBeenCalled();
  });
});

describe('GithubIntentReleaseService — plan head CAS loss', () => {
  function planPrisma() {
    return {
      intentReleaseEvent: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
      workspaceRepo: { findMany: vi.fn().mockResolvedValue([]) },
      intentHandoff: { findMany: vi.fn().mockResolvedValue([]) },
      codeChange: { findMany: vi.fn().mockResolvedValue([]) },
      intentItem: { findMany: vi.fn().mockResolvedValue([{ id: 'br-1', authority: 'accepted' }]) },
    } as unknown as PrismaService;
  }
  const casLoss = () =>
    intentConflict(IntentErrorCode.ReleaseOutOfOrder, 'Expected head does not match', ['expectedHeadSeq']);
  const run = (service: GithubIntentReleaseService) =>
    (service as never as { applyPlanMachine: (...args: unknown[]) => Promise<void> }).applyPlanMachine(
      'ws_1',
      { id: 'cc_1', state: 'open', isDraft: false },
      { delivers: [{ itemId: 'br-1', version: 1 }], retires: [] },
      { repoKey: 'github.com/acme/api', number: 7 },
      'PR',
      'acme/api#7',
      'merge',
    );

  it('re-reads the ledger and recomputes the plan instead of dropping it', async () => {
    const prisma = planPrisma();
    const record = vi.fn().mockRejectedValueOnce(casLoss()).mockResolvedValueOnce({ headSeq: 1 });
    await run(new GithubIntentReleaseService(prisma, { record } as unknown as IntentReleaseService));
    expect(record).toHaveBeenCalledTimes(2);
    expect(prisma.intentReleaseEvent.findFirst).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[1][2]).toMatchObject({ kind: 'plan', itemId: 'br-1' });
  });

  it('gives up after a bounded number of passes', async () => {
    const prisma = planPrisma();
    const record = vi.fn().mockRejectedValue(casLoss());
    await run(new GithubIntentReleaseService(prisma, { record } as unknown as IntentReleaseService));
    expect(record).toHaveBeenCalledTimes(3);
  });

  it('does not retry any other refusal', async () => {
    const prisma = planPrisma();
    const record = vi.fn().mockRejectedValue(new Error('boom'));
    await run(new GithubIntentReleaseService(prisma, { record } as unknown as IntentReleaseService));
    expect(record).toHaveBeenCalledTimes(1);
  });
});
