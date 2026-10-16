import { normalizeGithubBaseUrl } from './github-client.js';

const DOTCOM_API_BASE = 'https://api.github.com';

export interface GithubConnectorCandidate {
  id: string;
  baseUrl: string | null;
  config: unknown;
  credentialsEncrypted: string | null;
}

export interface GithubRepositoryRow {
  intentRepoKey: string | null;
  normalizedGitRemote: string | null;
}

export type GithubRepositoryIneligibleReason =
  | 'repository_key_missing'
  | 'repository_remote_missing'
  | 'repository_remote_invalid'
  | 'github_connector_unavailable';

export type GithubRepositoryResolution<C extends GithubConnectorCandidate = GithubConnectorCandidate> =
  | {
      status: 'resolved';
      owner: string;
      name: string;
      connector: C;
      apiBaseUrl: string;
      gitOrigin: string;
      cloneUrl: string;
    }
  | { status: 'unresolved'; reason: GithubRepositoryIneligibleReason };

/** Drops the port: an SSH port says nothing about where the API or HTTPS clone lives. */
function parseRemote(remote: string) {
  const match = /^(?:(?:https|ssh):\/\/)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+)$/.exec(remote);
  if (!match) return undefined;
  return { host: match[1]!.toLowerCase(), owner: match[2]!, name: match[3]! };
}

function gitOriginOf(apiBaseUrl: string): string {
  const api = new URL(apiBaseUrl);
  return api.hostname === 'api.github.com' ? 'https://github.com' : api.origin;
}

export function resolveGithubRepository<C extends GithubConnectorCandidate>(
  repo: GithubRepositoryRow,
  connectors: readonly C[],
): GithubRepositoryResolution<C> {
  if (!repo.intentRepoKey) return { status: 'unresolved', reason: 'repository_key_missing' };
  if (!repo.normalizedGitRemote) return { status: 'unresolved', reason: 'repository_remote_missing' };
  const remote = parseRemote(repo.normalizedGitRemote);
  if (!remote) return { status: 'unresolved', reason: 'repository_remote_invalid' };
  const fullName = `${remote.owner}/${remote.name}`.toLowerCase();
  const matches = connectors.flatMap((connector) => {
    let apiBaseUrl: string;
    try {
      apiBaseUrl = normalizeGithubBaseUrl(connector.baseUrl ?? DOTCOM_API_BASE);
    } catch {
      return [];
    }
    const gitOrigin = gitOriginOf(apiBaseUrl);
    if (new URL(gitOrigin).hostname !== remote.host) return [];
    const repos = (connector.config as { repos?: unknown } | null)?.repos;
    const listed =
      !Array.isArray(repos) ||
      !repos.length ||
      repos.some((r) => typeof r === 'string' && r.toLowerCase() === fullName);
    return listed ? [{ connector, apiBaseUrl, gitOrigin }] : [];
  });
  const match = matches[0];
  if (matches.length !== 1 || !match?.connector.credentialsEncrypted) {
    return { status: 'unresolved', reason: 'github_connector_unavailable' };
  }
  return {
    status: 'resolved',
    owner: remote.owner,
    name: remote.name,
    ...match,
    cloneUrl: `${match.gitOrigin}/${remote.owner}/${remote.name}.git`,
  };
}
