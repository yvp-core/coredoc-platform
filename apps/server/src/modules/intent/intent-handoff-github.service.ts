import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { decrypt } from '../../database/encryption.js';
import { GithubClient } from '../../libs/github/github-client.js';
import { GithubRepositoryResolver } from '../../libs/github/github-repository-resolver.service.js';
import { HandoffSha } from './intent-handoff.operations.js';

/**
 * The strict pull read's schema. Agent-run delivery verifies pull requests
 * with it too, so it carries the head's repository (null when a fork was
 * deleted) and branch; the handoff reads neither.
 */
export const strictPullSchema = z.object({
  number: z.number().int().positive(),
  state: z.enum(['open', 'closed']),
  merged: z.boolean(),
  draft: z.boolean(),
  head: z.object({
    sha: HandoffSha,
    ref: z.string().min(1),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
  base: z.object({ ref: z.string().min(1), repo: z.object({ full_name: z.string(), default_branch: z.string() }) }),
  merge_commit_sha: HandoffSha.nullable(),
  merged_at: z.iso.datetime({ offset: true }).nullable(),
});
export type HandoffPull = z.infer<typeof strictPullSchema>;

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
