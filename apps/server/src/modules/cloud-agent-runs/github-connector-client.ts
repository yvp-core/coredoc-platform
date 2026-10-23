import { decrypt } from '../../database/encryption.js';
import { GithubApiError, GithubClient, GithubRateLimitError } from '../../libs/github/github-client.js';
import type { GithubClientFactory } from '../delivery/github-importer.service.js';

export const defaultGithubFactory: GithubClientFactory = (token, baseUrl) => new GithubClient({ token, baseUrl });

/** The client for a repository's resolved GitHub connector. */
export function connectorClient(
  factory: GithubClientFactory,
  connector: { credentialsEncrypted: string | null; baseUrl: string | null },
): GithubClient {
  return factory(decrypt(connector.credentialsEncrypted!), connector.baseUrl ?? undefined);
}

export function transientGithub(error: unknown): { retryAfterMs: number | null } | false {
  if (error instanceof GithubRateLimitError) return { retryAfterMs: null };
  if (error instanceof GithubApiError)
    return error.status >= 500 || error.status === 408 ? { retryAfterMs: null } : false;
  // fetch rejects with a TypeError on network failures and a TimeoutError on its timeout.
  if (error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError')) {
    return { retryAfterMs: null };
  }
  return false;
}
