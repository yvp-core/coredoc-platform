import { describe, expect, it, vi } from 'vitest';
import { AccessAreasService } from './access-areas.service.js';

/**
 * The refusals that keep an area inside its own workspace and keep a repo from
 * silently changing hands. Each must stop BEFORE anything is written.
 */
function makeService(state: {
  area?: { id: string } | null;
  members?: { userId: string }[];
  repos?: { repoKey: string; accessAreaId: string | null }[];
  repoCount?: number;
}) {
  const writes = {
    create: vi.fn().mockResolvedValue({ id: 'area-new' }),
    update: vi.fn().mockResolvedValue({ id: 'area-1' }),
    delete: vi.fn(),
    memberDeleteMany: vi.fn(),
    memberCreateMany: vi.fn(),
    repoUpdateMany: vi.fn(),
  };
  const transaction = {
    accessArea: {
      // Called for the "does the area exist" probe (by id) and the name probe.
      findFirst: vi.fn(async ({ where }: { where: { id?: string } }) => (where.id ? (state.area ?? null) : null)),
      create: writes.create,
      update: writes.update,
    },
    workspaceMember: { findMany: vi.fn().mockResolvedValue(state.members ?? []) },
    workspaceRepo: { findMany: vi.fn().mockResolvedValue(state.repos ?? []), updateMany: writes.repoUpdateMany },
    accessAreaMember: { deleteMany: writes.memberDeleteMany, createMany: writes.memberCreateMany },
  };
  const prisma = {
    $transaction: (run: (tx: typeof transaction) => unknown) => run(transaction),
    accessArea: {
      findFirst: vi
        .fn()
        .mockResolvedValue(state.area ? { ...state.area, _count: { repos: state.repoCount ?? 0 } } : null),
      delete: writes.delete,
    },
  };
  return { service: new AccessAreasService(prisma as never), writes };
}

const noWrites = (writes: Record<string, ReturnType<typeof vi.fn>>) => {
  for (const write of Object.values(writes)) expect(write).not.toHaveBeenCalled();
};

describe('AccessAreasService', () => {
  it('refuses a member who does not belong to the workspace', async () => {
    const { service, writes } = makeService({ members: [{ userId: 'u1' }] });
    await expect(
      service.save('ws-1', null, { name: 'Calc', memberUserIds: ['u1', 'outsider'], repoKeys: [] }),
    ).rejects.toMatchObject({ status: 400 });
    noWrites(writes);
  });

  it('refuses a repo that is not connected to the workspace', async () => {
    const { service, writes } = makeService({ repos: [] });
    await expect(
      service.save('ws-1', null, { name: 'Calc', memberUserIds: [], repoKeys: ['foreign'] }),
    ).rejects.toMatchObject({ status: 400 });
    noWrites(writes);
  });

  it('refuses to take a repo that another area already protects', async () => {
    const { service, writes } = makeService({
      area: { id: 'area-1' },
      repos: [{ repoKey: 'calc', accessAreaId: 'area-other' }],
    });
    await expect(
      service.save('ws-1', 'area-1', { name: 'Calc', memberUserIds: [], repoKeys: ['calc'] }),
    ).rejects.toMatchObject({ status: 409 });
    noWrites(writes);
  });

  it('fails the save when a concurrent save claimed the repo after the check', async () => {
    const { service, writes } = makeService({ repos: [{ repoKey: 'calc', accessAreaId: null }] });
    writes.repoUpdateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.save('ws-1', null, { name: 'Calc', memberUserIds: [], repoKeys: ['calc'] }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses to replace an area of another workspace', async () => {
    const { service, writes } = makeService({ area: null });
    await expect(
      service.save('ws-1', 'area-elsewhere', { name: 'Calc', memberUserIds: [], repoKeys: [] }),
    ).rejects.toMatchObject({ status: 404 });
    noWrites(writes);
  });

  it('refuses to delete an area that still protects repos, and deletes an empty one', async () => {
    const holding = makeService({ area: { id: 'area-1' }, repoCount: 1 });
    await expect(holding.service.remove('ws-1', 'area-1')).rejects.toMatchObject({ status: 409 });
    expect(holding.writes.delete).not.toHaveBeenCalled();

    const empty = makeService({ area: { id: 'area-1' }, repoCount: 0 });
    await empty.service.remove('ws-1', 'area-1');
    expect(empty.writes.delete).toHaveBeenCalledWith({ where: { id: 'area-1' } });
  });
});
