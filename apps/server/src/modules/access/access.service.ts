import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { SaveGroupInput, SaveRepoAccessInput } from './access.contract.js';

/**
 * Administration of groups and of per-repo access. The rules these rows feed are
 * in auth/iam.ts; the read side is `readableRepos` (database/control-plane.service.ts).
 * A member's workspace role is a binding too, administered by the members API.
 */
@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string) {
    const [groups, repos, bindings] = await Promise.all([
      this.prisma.accessGroup.findMany({
        where: { workspaceId },
        orderBy: { name: 'asc' },
        include: { members: { select: { userId: true } } },
      }),
      this.prisma.workspaceRepo.findMany({
        where: { workspaceId },
        orderBy: { repoName: 'asc' },
        select: { repoKey: true, repoName: true, restricted: true },
      }),
      this.prisma.accessBinding.findMany({
        where: { workspaceId, resourceType: 'repo' },
        select: { resourceId: true, userId: true, groupId: true, role: true },
      }),
    ]);
    return {
      groups: groups.map((group) => ({
        id: group.id,
        name: group.name,
        memberUserIds: group.members.map((member) => member.userId),
      })),
      repos: repos.map((repo) => ({
        ...repo,
        bindings: bindings
          .filter((binding) => binding.resourceId === repo.repoKey)
          .map(({ userId, groupId, role }) => (userId ? { userId, role } : { groupId, role })),
      })),
    };
  }

  /** Creates the group (`groupId` null) or replaces its name and members. */
  async saveGroup(workspaceId: string, groupId: string | null, input: SaveGroupInput) {
    const memberUserIds = [...new Set(input.memberUserIds)];
    const id = await this.prisma.$transaction(async (transaction) => {
      if (groupId && !(await transaction.accessGroup.findFirst({ where: { id: groupId, workspaceId } }))) {
        throw new NotFoundException('Group not found');
      }
      const sameName = await transaction.accessGroup.findFirst({ where: { workspaceId, name: input.name } });
      if (sameName && sameName.id !== groupId) {
        throw new ConflictException(`A group named "${input.name}" already exists`);
      }
      await this.assertMembers(transaction, workspaceId, memberUserIds);

      const group = groupId
        ? await transaction.accessGroup.update({ where: { id: groupId }, data: { name: input.name } })
        : await transaction.accessGroup.create({ data: { workspaceId, name: input.name } });
      await transaction.accessGroupMember.deleteMany({ where: { groupId: group.id } });
      await transaction.accessGroupMember.createMany({
        data: memberUserIds.map((userId) => ({ groupId: group.id, workspaceId, userId })),
      });
      return group.id;
    });
    return { id, name: input.name, memberUserIds };
  }

  /** Deleting a group drops its bindings with it, which only ever removes access. */
  async removeGroup(workspaceId: string, groupId: string) {
    const { count } = await this.prisma.accessGroup.deleteMany({ where: { id: groupId, workspaceId } });
    if (count === 0) throw new NotFoundException('Group not found');
  }

  /** Replaces whether the repo is restricted and who is bound to it. */
  async saveRepoAccess(workspaceId: string, repoKey: string, input: SaveRepoAccessInput) {
    // One role per principal per resource: a later entry for the same principal wins.
    const bindings = [
      ...new Map(input.bindings.map((binding) => [binding.userId ?? binding.groupId, binding])).values(),
    ];
    const userIds = bindings.flatMap((binding) => binding.userId ?? []);
    const groupIds = bindings.flatMap((binding) => binding.groupId ?? []);

    await this.prisma.$transaction(async (transaction) => {
      // Every id is caller-supplied, so each is checked against THIS workspace.
      const repo = await transaction.workspaceRepo.findFirst({ where: { workspaceId, repoKey } });
      if (!repo) throw new NotFoundException('Repo not found');
      await this.assertMembers(transaction, workspaceId, userIds);
      const groups = await transaction.accessGroup.count({ where: { workspaceId, id: { in: groupIds } } });
      if (groups !== groupIds.length) {
        throw new BadRequestException('bindings names a group that does not belong to this workspace');
      }

      await transaction.accessBinding.deleteMany({ where: { workspaceId, resourceType: 'repo', resourceId: repoKey } });
      await transaction.accessBinding.createMany({
        data: bindings.map((binding) => ({
          workspaceId,
          userId: binding.userId ?? null,
          groupId: binding.groupId ?? null,
          role: binding.role,
          resourceType: 'repo',
          resourceId: repoKey,
        })),
      });
      await transaction.workspaceRepo.update({ where: { id: repo.id }, data: { restricted: input.restricted } });
    });
    return { repoKey, restricted: input.restricted, bindings };
  }

  private async assertMembers(
    transaction: Pick<PrismaService, 'workspaceMember'>,
    workspaceId: string,
    userIds: string[],
  ) {
    const members = await transaction.workspaceMember.count({ where: { workspaceId, userId: { in: userIds } } });
    if (members !== userIds.length) {
      throw new BadRequestException('A listed user is not a member of this workspace');
    }
  }
}
