/**
 * Tiny pure helpers shared by the OAuth upstream providers
 * (github-allowlist.provider.ts, workos.provider.ts).
 */

/** Parse a comma-separated env value into trimmed, lowercased, non-empty entries. */
export function parseCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Join a base server URL and a callback path without doubling slashes. */
export function joinUrl(serverUrl: string, callbackPath: string): string {
  const base = serverUrl.replace(/\/$/, '');
  const path = callbackPath.startsWith('/') ? callbackPath : `/${callbackPath}`;
  return `${base}${path}`;
}

/** Extract the domain part of an email address ('' when there is no '@'). */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1) : '';
}
