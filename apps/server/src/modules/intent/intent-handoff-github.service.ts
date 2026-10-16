import { Injectable } from '@nestjs/common';
import { decrypt } from '../../database/encryption.js';
import { GithubClient } from '../../libs/github/github-client.js';
import { strictPullSchema } from '../../libs/github/github-pull.js';
import { GithubRepositoryResolver } from '../../libs/github/github-repository-resolver.service.js';

@Injectable()
export class IntentHandoffGithubService {
  constructor(private readonly resolver: GithubRepositoryResolver) {}

  async source(workspaceId: string, repoKey: string) {
    const { repo, owner, name, connector } = await this.resolver.resolve(workspaceId, repoKey);
    const client = new GithubClient({
      token: decrypt(connector.credentialsEncrypted!),
      baseUrl: connector.baseUrl ?? undefined,
    });
    return { repo, owner, name, client };
  }

  async pull(workspaceId: string, repoKey: string, number: number) {
    const source = await this.source(workspaceId, repoKey);
    const pull = strictPullSchema.parse(await source.client.getPullMetadata(source.owner, source.name, number));
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
