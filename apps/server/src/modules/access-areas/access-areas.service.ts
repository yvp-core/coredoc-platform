import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { SaveAccessAreaInput } from './access-areas.contract.js';

/**
 * Administration of access areas — who may read which restricted repos. The
 * read side is `readableRepos` (database/control-plane.service.ts).
 */
@Injectable()
export class AccessAreasService {
  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string) {
    const areas = await this.prisma.accessArea.findMany({
      where: { workspaceId },
      orderBy: { name: 'asc' },
      include: { members: { select: { userId: true } }, repos: { select: { repoKey: true } } },
    });
    return areas.map((area) => ({
      id: area.id,
      name: area.name,
      memberUserIds: area.members.map((member) => member.userId),
      repoKeys: area.repos.map((repo) => repo.repoKey),
    }));
  }

  /**
   * Creates the area (`areaId` null) or replaces its name, members and repos.
   * A repo dropped from the list becomes readable by every member again — that
   * is the caller's explicit choice, so it is not guarded.
   */
  async save(workspaceId: string, areaId: string | null, input: SaveAccessAreaInput) {
    const memberUserIds = [...new Set(input.memberUserIds)];
    const repoKeys = [...new Set(input.repoKeys)];

    const id = await this.prisma.$transaction(async (transaction) => {
      if (areaId && !(await transaction.accessArea.findFirst({ where: { id: areaId, workspaceId } }))) {
        throw new NotFoundException('Access area not found');
      }
      const sameName = await transaction.accessArea.findFirst({ where: { workspaceId, name: input.name } });
      if (sameName && sameName.id !== areaId) {
        throw new ConflictException(`An access area named "${input.name}" already exists`);
      }

      // Both lists are checked against THIS workspace: ids are caller-supplied.
      const members = await transaction.workspaceMember.findMany({
        where: { workspaceId, userId: { in: memberUserIds } },
        select: { userId: true },
      });
      if (members.length !== memberUserIds.length) {
        throw new BadRequestException('memberUserIds contains a user who is not a member of this workspace');
      }
      const repos = await transaction.workspaceRepo.findMany({
        where: { workspaceId, repoKey: { in: repoKeys } },
        select: { repoKey: true, accessAreaId: true },
      });
      if (repos.length !== repoKeys.length) {
        throw new BadRequestException('repoKeys contains a repo that is not connected to this workspace');
      }
      const taken = repos.find((repo) => repo.accessAreaId && repo.accessAreaId !== areaId);
      if (taken) throw new ConflictException(`Repo "${taken.repoKey}" already belongs to another access area`);

      const area = areaId
        ? await transaction.accessArea.update({ where: { id: areaId }, data: { name: input.name } })
        : await transaction.accessArea.create({ data: { workspaceId, name: input.name } });

      await transaction.accessAreaMember.deleteMany({ where: { areaId: area.id } });
      await transaction.accessAreaMember.createMany({
        data: memberUserIds.map((userId) => ({ areaId: area.id, workspaceId, userId })),
      });
      await transaction.workspaceRepo.updateMany({
        where: { workspaceId, accessAreaId: area.id, repoKey: { notIn: repoKeys } },
        data: { accessAreaId: null },
      });
      // Conditional on purpose: a concurrent save may have claimed a repo after
      // the check above. The row lock makes the later writer see it and fail.
      const assigned = await transaction.workspaceRepo.updateMany({
        where: { workspaceId, repoKey: { in: repoKeys }, OR: [{ accessAreaId: null }, { accessAreaId: area.id }] },
        data: { accessAreaId: area.id },
      });
      if (assigned.count !== repoKeys.length) {
        throw new ConflictException('A repo was assigned to another access area meanwhile; retry');
      }
      return area.id;
    });
    return { id, name: input.name, memberUserIds, repoKeys };
  }

  /** Refused while the area still holds repos: deleting it would open them to everyone. */
  async remove(workspaceId: string, areaId: string) {
    const area = await this.prisma.accessArea.findFirst({
      where: { id: areaId, workspaceId },
      include: { _count: { select: { repos: true } } },
    });
    if (!area) throw new NotFoundException('Access area not found');
    if (area._count.repos > 0) {
      throw new ConflictException('Remove the repos from this access area before deleting it');
    }
    await this.prisma.accessArea.delete({ where: { id: areaId } });
  }
}
