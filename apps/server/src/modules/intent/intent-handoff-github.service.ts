import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service.js';
import { decrypt } from '../../database/encryption.js';
import { GithubClient } from '../../libs/github/github-client.js';
import { HandoffSha } from './intent-handoff.operations.js';

const pullSchema = z.object({
  number: z.number().int().positive(),
  state: z.enum(['open', 'closed']),
  merged: z.boolean(),
  draft: z.boolean(),
  head: z.object({ sha: HandoffSha }),
  base: z.object({ ref: z.string().min(1), repo: z.object({ full_name: z.string(), default_branch: z.string() }) }),
  merge_commit_sha: HandoffSha.nullable(),
  merged_at: z.iso.datetime({ offset: true }).nullable(),
});
export type HandoffPull = z.infer<typeof pullSchema>;

@Injectable()
export class IntentHandoffGithubService {
  constructor(private readonly prisma: PrismaService) {}

  async source(workspaceId: string, repoKey: string) {
    const repo = await this.prisma.workspaceRepo.findFirst({ where: { workspaceId, intentRepoKey: repoKey } });
    if (!repo) throw new Error('repository_not_found');
    // The registered remote fixes both host and owner/repository. Neither comes from MCP arguments.
    const remote = repo.normalizedGitRemote;
    if (!remote) throw new Error('repository_remote_missing');
    const match = /^(?:https:\/\/)?([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
    if (!match) throw new Error('repository_remote_invalid');
    const host = match[1]!;
    const owner = match[2]!;
    const name = match[3]!;
    const connectors = await this.prisma.deliveryConnector.findMany({
      where: { workspaceId, provider: 'github', status: 'active' },
    });
    const eligible = connectors.filter((c) => {
      const api = new URL(c.baseUrl ?? 'https://api.github.com');
      const sameHost =
        host.toLowerCase() === (api.hostname === 'api.github.com' ? 'github.com' : api.hostname).toLowerCase();
      const repos = (c.config as { repos?: unknown }).repos;
      return (
        sameHost &&
        (!Array.isArray(repos) ||
          !repos.length ||
          repos.some((r) => typeof r === 'string' && r.toLowerCase() === `${owner}/${name}`.toLowerCase()))
      );
    });
    if (eligible.length !== 1 || !eligible[0]!.credentialsEncrypted) throw new Error('github_connector_unavailable');
    const connector = eligible[0]!;
    const client = new GithubClient({
      token: decrypt(connector.credentialsEncrypted!),
      baseUrl: connector.baseUrl ?? undefined,
    });
    return { repo, owner, name, client };
  }

  async pull(workspaceId: string, repoKey: string, number: number) {
    const source = await this.source(workspaceId, repoKey);
    const pull = pullSchema.parse(await source.client.getPullMetadata(source.owner, source.name, number));
    if (
      pull.number !== number ||
      pull.base.repo.full_name.toLowerCase() !== `${source.owner}/${source.name}`.toLowerCase()
    )
      throw new Error('github_repository_mismatch');
    return { ...source, pull };
  }

  async includes(source: Awaited<ReturnType<IntentHandoffGithubService['source']>>, merge: string, snapshot: string) {
    if (merge === snapshot) return true;
    const result = await source.client.compareCommits(source.owner, source.name, merge, snapshot);
    return result.status === 'identical' || result.status === 'ahead';
  }
}
