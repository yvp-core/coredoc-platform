/**
 * Redacts the values of sensitive query-string parameters in a URL before it is
 * written to logs or telemetry.
 *
 * The OAuth callback (`GET /auth/callback?code=...`) carries the authorization
 * `code` (and CSRF `state`) in the query string. Logging the raw URL would
 * persist replayable auth artifacts wherever logs are stored. This keeps the
 * path and parameter names — useful for debugging — but masks secret values.
 *
 * Operates on the path-relative form (`/path?a=b`) produced by Express
 * `req.originalUrl` / `req.url`; it does not require an absolute base.
 */

import { miscConfigFromEnv } from '../config/app-config.js';

const SENSITIVE_QUERY_KEYS: ReadonlySet<string> = new Set([
  'code',
  'state',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'apikey',
  'secret',
  'client_secret',
  'password',
]);

const REDACTED = '[REDACTED]';

export function redactSensitiveQueryParams(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart === -1 || miscConfigFromEnv().environment === 'development') return url;

  const path = url.slice(0, queryStart);
  const query = url.slice(queryStart + 1);

  const redacted = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const key = eq === -1 ? pair : pair.slice(0, eq);
      if (!SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) return pair;
      return `${key}=${REDACTED}`;
    })
    .join('&');

  return `${path}?${redacted}`;
}
