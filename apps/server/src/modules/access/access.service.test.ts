import { describe, expect, it, vi } from 'vitest';
import { AccessService } from './access.service.js';

/**
 * Every id in these bodies is caller-supplied. Each refusal must stop BEFORE
 * anything is written, or one workspace's admin could bind another's people.
 */
function makeService(state: {
  repo?: { id: string } | null;
  members?: number;
  groups?: number;
  group?: object | null;
}) {
  const writes = {
    bindingDeleteMany: vi.fn(),
    bindingCreateMany: vi.fn(),
    repoUpdate: vi.fn(),
    groupCreate: vi.fn().mockResolvedValue({ id: 'g-new' }),
    groupUpdate: vi.fn().mockResolvedValue({ id: 'g1' }),
    groupMemberDeleteMany: vi.fn(),
    groupMemberCreateMany: vi.fn(),
  };
  const transaction = {
    workspaceRepo: { count: vi.fn().mockResolvedValue(state.repo ? 1 : 0), updateMany: writes.repoUpdate },
    workspaceMember: { count: vi.fn().mockResolvedValue(state.members ?? 0) },
    accessGroup: {
      count: vi.fn().mockResolvedValue(state.groups ?? 0),
      findFirst: vi.fn(async ({ where }: { where: { id?: string } }) => (where.id ? (state.group ?? null) : null)),
      create: writes.groupCreate,
      update: writes.groupUpdate,
    },
    accessGroupMember: { deleteMany: writes.groupMemberDeleteMany, createMany: writes.groupMemberCreateMany },
    accessBinding: { deleteMany: writes.bindingDeleteMany, createMany: writes.bindingCreateMany },
  };
  const prisma = { $transaction: (run: (tx: typeof transaction) => unknown) => run(transaction) };
  return { service: new AccessService(prisma as never), writes };
}

const noWrites = (writes: Record<string, ReturnType<typeof vi.fn>>) => {
  for (const write of Object.values(writes)) expect(write).not.toHaveBeenCalled();
};
const GROUP_ID = '0b0e7f0e-58a5-4a65-9d0c-0f8f6b2f2c11';

describe('AccessService', () => {
  it('refuses repo access for a repo that is not connected to the workspace', async () => {
    const { service, writes } = makeService({ repo: null });
    await expect(
      service.saveResourceAccess('ws-1', 'repo', 'foreign', { restricted: true, bindings: [] }),
    ).rejects.toMatchObject({
      status: 404,
    });
    noWrites(writes);
  });

  it('refuses to bind a user who is not a member of the workspace', async () => {
    const { service, writes } = makeService({ repo: { id: 'r1' }, members: 0 });
    await expect(
      service.saveResourceAccess('ws-1', 'repo', 'calc', {
        restricted: true,
        bindings: [{ userId: 'outsider', role: 'member' }],
      }),
    ).rejects.toMatchObject({ status: 400 });
    noWrites(writes);
  });

  it('refuses to bind a group of another workspace', async () => {
    const { service, writes } = makeService({ repo: { id: 'r1' }, groups: 0 });
    await expect(
      service.saveResourceAccess('ws-1', 'repo', 'calc', {
        restricted: true,
        bindings: [{ groupId: GROUP_ID, role: 'member' }],
      }),
    ).rejects.toMatchObject({ status: 400 });
    noWrites(writes);
  });

  it('replaces the repo bindings whole and stores one role per principal', async () => {
    const { service, writes } = makeService({ repo: { id: 'r1' }, members: 1, groups: 1 });
    await service.saveResourceAccess('ws-1', 'repo', 'calc', {
      restricted: true,
      bindings: [
        { userId: 'u1', role: 'member' },
        { userId: 'u1', role: 'member' },
        { groupId: GROUP_ID, role: 'member' },
      ],
    });
    expect(writes.bindingDeleteMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1', resourceType: 'repo', resourceId: 'calc' },
    });
    expect(writes.bindingCreateMany.mock.calls[0]?.[0].data).toHaveLength(2);
    expect(writes.repoUpdate).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1', repoKey: 'calc' },
      data: { restricted: true },
    });
  });

  it('refuses a group member who does not belong to the workspace, and a group of another workspace', async () => {
    const outsider = makeService({ members: 1 });
    await expect(
      outsider.service.saveGroup('ws-1', null, { name: 'Calc', memberUserIds: ['u1', 'outsider'] }),
    ).rejects.toMatchObject({ status: 400 });
    noWrites(outsider.writes);

    const foreign = makeService({ group: null });
    await expect(
      foreign.service.saveGroup('ws-1', GROUP_ID, { name: 'Calc', memberUserIds: [] }),
    ).rejects.toMatchObject({ status: 404 });
    noWrites(foreign.writes);
  });
});
