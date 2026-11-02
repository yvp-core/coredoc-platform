/**
 * Log line for a refused request to the OAuth endpoints the SDK serves at the
 * root. The SDK logs no reason for its 4xx answers, so this is the only
 * server-side record of why a sign-in or refresh was refused.
 *
 * Only identifying fields are logged — never a token, code or verifier. For a
 * refresh, the token's claims (decoded, not verified: anyone can send one)
 * show which check it would fail (expired, issued to another client) and whose
 * session it claims to be. `sub` and the sign-in refusal message can carry an
 * email; kept for now so a report can be matched without a DB lookup.
 */

import { decodeJwt } from 'jose';
import { redactForLog } from '../../libs/redact-url.js';

const OAUTH_ENDPOINTS = new Set(['/authorize', '/callback', '/token', '/register']);

export function describeOAuthFailure(
  req: { url?: string; body?: unknown },
  status: number,
  message: string,
): string | undefined {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (!OAUTH_ENDPOINTS.has(path)) return undefined;
  const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
  const fields: string[] = [];
  if (typeof body.grant_type === 'string') fields.push(`grant_type=${redactForLog(body.grant_type)}`);
  if (typeof body.client_id === 'string') fields.push(`client_id=${redactForLog(body.client_id)}`);
  if (body.grant_type === 'refresh_token' && typeof body.refresh_token === 'string') {
    fields.push(refreshTokenClaims(body.refresh_token));
  }
  return `OAuth ${path} ${status}: ${redactForLog(message)}${fields.length > 0 ? ` [${fields.join(' ')}]` : ''}`;
}

function refreshTokenClaims(token: string): string {
  try {
    const { client_id, sub, exp } = decodeJwt(token);
    const expiry = typeof exp === 'number' ? new Date(exp * 1000).toISOString() : 'none';
    return `unverified token: sub=${redactForLog(sub)} client_id=${redactForLog(client_id)} exp=${expiry}`;
  } catch {
    return 'unverified token: undecodable';
  }
}
