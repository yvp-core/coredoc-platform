import { describe, expect, it } from 'vitest';
import { normalizeGitRemote } from '../git-remote.js';
import { type GithubConnectorCandidate, resolveGithubRepository } from './github-repository.js';

const DOTCOM: GithubConnectorCandidate = { id: 'dotcom', baseUrl: null, config: {}, credentialsEncrypted: 'enc' };

/** Resolve an origin as the CLI or desktop registers it: normalized first, as on push. */
function resolveOrigin(origin: string, connectors: GithubConnectorCandidate[]) {
  const normalized = normalizeGitRemote(origin);
  if (normalized.status !== 'normalized') throw new Error(`fixture origin did not normalize: ${origin}`);
  return resolveGithubRepository({ intentRepoKey: 'orders-api', normalizedGitRemote: normalized.normalizedRemote }, [
    ...connectors,
  ]);
}

describe('resolveGithubRepository', () => {
  it('resolves a github.com origin to the api.github.com connector and a github.com clone URL', () => {
    expect(resolveOrigin('https://github.com/acme/orders-api.git', [DOTCOM])).toEqual({
      status: 'resolved',
      owner: 'acme',
      name: 'orders-api',
      connector: DOTCOM,
      apiBaseUrl: 'https://api.github.com',
      gitOrigin: 'https://github.com',
      cloneUrl: 'https://github.com/acme/orders-api.git',
    });
  });

  it.each([
    'git@github.com:acme/orders-api.git',
    'ssh://git@github.com/acme/orders-api',
    'https://github.com/acme/orders-api',
  ])('clones github.com origin %s from github.com, never from api.github.com', (origin) => {
    const resolved = resolveOrigin(origin, [DOTCOM]);
    expect(resolved).toMatchObject({ owner: 'acme', name: 'orders-api' });
    expect(resolved.status === 'resolved' && resolved.cloneUrl).toBe('https://github.com/acme/orders-api.git');
  });

  const GHES: GithubConnectorCandidate = {
    id: 'ghes',
    baseUrl: 'https://ghe.example.invalid:8443/api/v3',
    config: {},
    credentialsEncrypted: 'enc',
  };

  it.each([
    ['scp', 'git@ghe.example.invalid:platform/billing.git'],
    ['ssh:// with an SSH port', 'ssh://git@ghe.example.invalid:2222/platform/billing.git'],
    ['HTTPS with a port', 'https://ghe.example.invalid:8443/platform/billing'],
  ])('resolves a GitHub Enterprise Server %s origin to the connector and a clone URL without /api/v3', (_, origin) => {
    expect(resolveOrigin(origin, [DOTCOM, GHES])).toEqual({
      status: 'resolved',
      owner: 'platform',
      name: 'billing',
      connector: GHES,
      apiBaseUrl: 'https://ghe.example.invalid:8443/api/v3',
      gitOrigin: 'https://ghe.example.invalid:8443',
      cloneUrl: 'https://ghe.example.invalid:8443/platform/billing.git',
    });
  });

  it('picks the connector whose repository list includes the repository, case-insensitively', () => {
    const other = { ...DOTCOM, id: 'other', config: { repos: ['acme/payments'] } };
    const listed = { ...DOTCOM, id: 'listed', config: { repos: ['Acme/Orders-API'] } };
    const resolved = resolveOrigin('git@github.com:acme/orders-api.git', [other, listed]);
    expect(resolved.status === 'resolved' && resolved.connector.id).toBe('listed');
  });

  const REMOTE = 'github.com/acme/orders-api';
  it.each([
    ['a repository without a durable key', { intentRepoKey: null, normalizedGitRemote: REMOTE }, [DOTCOM]],
    ['a missing remote', { intentRepoKey: 'orders-api', normalizedGitRemote: null }, [DOTCOM]],
    [
      'a remote that is not a GitHub owner/name path',
      { intentRepoKey: 'orders-api', normalizedGitRemote: 'http://git.example.invalid/acme/orders-api' },
      [DOTCOM],
    ],
    ['no connector on the remote host', { intentRepoKey: 'orders-api', normalizedGitRemote: REMOTE }, [GHES]],
    [
      'a connector repository list without the repository',
      { intentRepoKey: 'orders-api', normalizedGitRemote: REMOTE },
      [{ ...DOTCOM, config: { repos: ['acme/payments'] } }],
    ],
    [
      'a connector without credentials',
      { intentRepoKey: 'orders-api', normalizedGitRemote: REMOTE },
      [{ ...DOTCOM, credentialsEncrypted: null }],
    ],
    [
      'two matching connectors',
      { intentRepoKey: 'orders-api', normalizedGitRemote: REMOTE },
      [DOTCOM, { ...DOTCOM, id: 'second' }],
    ],
  ] as const)('refuses %s', (_, repo, connectors) => {
    expect(resolveGithubRepository(repo, connectors)).toMatchObject({ status: 'unresolved' });
  });

  it('names why a repository is not eligible', () => {
    const reasonFor = (repo: { intentRepoKey: string | null; normalizedGitRemote: string | null }) =>
      resolveGithubRepository(repo, [DOTCOM]);
    expect(reasonFor({ intentRepoKey: null, normalizedGitRemote: REMOTE })).toEqual({
      status: 'unresolved',
      reason: 'repository_key_missing',
    });
    expect(reasonFor({ intentRepoKey: 'orders-api', normalizedGitRemote: null })).toEqual({
      status: 'unresolved',
      reason: 'repository_remote_missing',
    });
    expect(reasonFor({ intentRepoKey: 'orders-api', normalizedGitRemote: 'ssh://git.example.invalid/a/b/c' })).toEqual({
      status: 'unresolved',
      reason: 'repository_remote_invalid',
    });
  });
});
