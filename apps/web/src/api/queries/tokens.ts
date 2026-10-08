import { queryOptions } from '@tanstack/react-query';
import { request } from '../client.js';
import type { CreateTokenResult, Token } from '../types.js';

// Same `signal`-omission / staleTime:0 rationale as membersQueryOptions
// (src/api/queries/members.ts): token list state is point-in-time and every
// mutation below invalidates the exact key it affects.
export const tokensQueryOptions = (wsId: string) =>
  queryOptions({
    queryKey: ['ws', wsId, 'tokens'] as const,
    queryFn: () => request<Token[]>(`/api/v1/workspaces/${wsId}/tokens`),
    staleTime: 0,
  });

// Mutations follow the plain-exported-async-function convention established
// in queries/members.ts — see the doc comment there for the full rationale.

/** Curated scopes the server maps to a fixed permission list (CreateTokenDto). */
export type TokenScope = 'ci' | 'intent-agent' | 'agent-runner';

export function createToken(params: {
  wsId: string;
  name: string;
  scope: TokenScope;
  /** ISO-8601; omitted means the token never expires. */
  expiresAt?: string;
}): Promise<CreateTokenResult> {
  const { wsId, name, scope, expiresAt } = params;
  return request<CreateTokenResult>(`/api/v1/workspaces/${wsId}/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(expiresAt ? { name, scope, expiresAt } : { name, scope }),
  });
}

/**
 * Reveal the plaintext value of an existing token. Only succeeds when the
 * server had encrypted storage configured (`SERVER_ENCRYPTION_KEY`) at the
 * time the token was created — a global server-side setting, not something
 * the list endpoint exposes per-token. Tokens created before/without it
 * throw an `ApiError` (404, "Token value not available (created before
 * encrypted storage was enabled)") — see tokens.controller.ts
 * `getTokenValue`. There is no capability flag to check in advance; the
 * caller renders the reveal action unconditionally and surfaces this
 * `ApiError`'s message inline on failure.
 */
export function revealToken(params: { wsId: string; tokenId: string }): Promise<{ token: string }> {
  const { wsId, tokenId } = params;
  return request<{ token: string }>(`/api/v1/workspaces/${wsId}/tokens/${tokenId}/value`);
}

export function revokeToken(params: { wsId: string; tokenId: string }): Promise<{ revoked: true }> {
  const { wsId, tokenId } = params;
  return request<{ revoked: true }>(`/api/v1/workspaces/${wsId}/tokens/${tokenId}`, {
    method: 'DELETE',
  });
}
