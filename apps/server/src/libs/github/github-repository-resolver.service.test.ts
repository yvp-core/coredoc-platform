import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../../database/prisma.service.js';
import { GithubRepositoryResolver } from './github-repository-resolver.service.js';

interface RepoRow {
  id: string;
  workspaceId: string;
  repoName: string;
  intentRepoKey: string | null;
  normalizedGitRemote: string | null;
}
interface ConnectorRow {
  id: string;
  workspaceId: string;
  provider: string;
  status: string;
  baseUrl: string | null;
  config: unknown;
  credentialsEncrypted: string | null;
}

/** A prisma stand-in that applies the equality filters the resolver sends. */
function fakePrisma(repos: RepoRow[], connectors: ConnectorRow[]) {
  const matches =
    <T extends object>(where: Partial<T>) =>
    (row: T) =>
      Object.entries(where).every(([k, v]) => (row as Record<string, unknown>)[k] === v);
  return {
    workspaceRepo: {
      findMany: async ({ where }: { where: Partial<RepoRow> }) => repos.filter(matches(where)),
      findFirst: async ({ where }: { where: Partial<RepoRow> }) => repos.find(matches(where)) ?? null,
    },
    deliveryConnector: {
      findMany: async ({ where }: { where: Partial<ConnectorRow> }) => connectors.filter(matches(where)),
    },
  } as unknown as PrismaService;
}

const WS = 'ws-1';
const repo = (id: string, intentRepoKey: string | null, normalizedGitRemote: string | null): RepoRow => ({
  id,
  workspaceId: WS,
  repoName: id,
  intentRepoKey,
  normalizedGitRemote,
});
const connector = (id: string, over: Partial<ConnectorRow> = {}): ConnectorRow => ({
  id,
  workspaceId: WS,
  provider: 'github',
  status: 'active',
  baseUrl: null,
  config: {},
  credentialsEncrypted: 'enc',
  ...over,
});

describe('GithubRepositoryResolver', () => {
  const repos = [
    repo('orders-api', 'orders-api', 'github.com/acme/orders-api'),
    repo('legacy', null, 'github.com/acme/legacy'),
    repo('billing', 'billing', 'ssh://ghe.example.invalid/platform/billing'),
    { ...repo('elsewhere', 'elsewhere', 'github.com/acme/elsewhere'), workspaceId: 'ws-2' },
  ];
  const connectors = [
    connector('dotcom'),
    connector('ghes-disabled', { baseUrl: 'https://ghe.example.invalid/api/v3', status: 'disabled' }),
    connector('jira', { provider: 'jira' }),
  ];

  it('lists every workspace repository with its eligibility', async () => {
    const resolver = new GithubRepositoryResolver(fakePrisma(repos, connectors));
    const listed = await resolver.eligibility(WS);
    expect(
      listed.map(({ repo, resolution }) => [
        repo.repoName,
        resolution.status === 'resolved' ? resolution.cloneUrl : resolution.reason,
      ]),
    ).toEqual([
      ['orders-api', 'https://github.com/acme/orders-api.git'],
      ['legacy', 'repository_key_missing'],
      ['billing', 'github_connector_unavailable'],
    ]);
  });

  it('resolves a durable key to the repository, its connector and clone URL', async () => {
    const resolver = new GithubRepositoryResolver(fakePrisma(repos, connectors));
    await expect(resolver.resolve(WS, 'orders-api')).resolves.toMatchObject({
      repo: { id: 'orders-api' },
      owner: 'acme',
      name: 'orders-api',
      connector: { id: 'dotcom' },
      cloneUrl: 'https://github.com/acme/orders-api.git',
    });
  });

  it('refuses an unknown key and an unresolvable repository with the reason', async () => {
    const resolver = new GithubRepositoryResolver(fakePrisma(repos, connectors));
    await expect(resolver.resolve(WS, 'elsewhere')).rejects.toThrow('repository_not_found');
    await expect(resolver.resolve(WS, 'billing')).rejects.toThrow('github_connector_unavailable');
  });
});
