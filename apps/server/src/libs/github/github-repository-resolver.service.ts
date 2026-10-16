import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { resolveGithubRepository } from './github-repository.js';

export function activeGithubConnectors(workspaceId: string): Prisma.DeliveryConnectorWhereInput {
  return { workspaceId, provider: 'github', status: 'active' };
}

/**
 * Durable repository key → registered remote → the workspace's GitHub connector. The registered
 * remote fixes host, owner and name; callers never supply them.
 */
@Injectable()
export class GithubRepositoryResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(workspaceId: string, repoKey: string) {
    const repo = await this.prisma.workspaceRepo.findFirst({ where: { workspaceId, intentRepoKey: repoKey } });
    if (!repo) throw new Error('repository_not_found');
    const resolution = resolveGithubRepository(repo, await this.connectors(workspaceId));
    if (resolution.status !== 'resolved') throw new Error(resolution.reason);
    return { repo, ...resolution };
  }

  async eligibility(workspaceId: string) {
    const [repos, connectors] = await Promise.all([
      this.prisma.workspaceRepo.findMany({ where: { workspaceId } }),
      this.connectors(workspaceId),
    ]);
    return repos.map((repo) => ({ repo, resolution: resolveGithubRepository(repo, connectors) }));
  }

  private connectors(workspaceId: string) {
    return this.prisma.deliveryConnector.findMany({ where: activeGithubConnectors(workspaceId) });
  }
}
