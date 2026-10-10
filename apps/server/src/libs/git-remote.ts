/**
 * Canonical, credential-free Git remote normalization.
 *
 * Lifted verbatim in behaviour from the archived `packages/core/src/intent/
 * checkout.ts`; it lives here rather than in `@coredoc/core` because the server
 * is its only consumer today and core's public API should not grow a export
 * nothing else calls (YAGNI). If a CLI surface needs it later, move it to core
 * then — the function is pure and has no server dependencies.
 *
 * It PAIRS with `workspace_repos_normalized_git_remote_check` (migration
 * 20260901100000): the SQL CHECK enforces the shape at the storage boundary, and
 * this function is the only sanctioned way to produce a value that satisfies it.
 * Keep both — the CHECK catches a write that bypassed this function, and this
 * function is what makes the CHECK satisfiable from an arbitrary clone URL.
 *
 * TOTALITY is the contract: for ANY input string this function either refuses,
 * or returns a value that satisfies the CHECK and fits the column. It is not
 * enough to "usually" produce a canonical form — a normalized value the CHECK
 * rejects surfaces as a constraint violation in the middle of a repo connect,
 * which is a 500 the caller cannot act on. {@link satisfiesStorageCheck} is the
 * CHECK restated here, and every accepted answer is routed through it.
 *
 * Two design rules the archive proved and this copy keeps:
 *
 * - Generic protocols stay EXPLICIT, so an SSH remote on an arbitrary
 *   self-hosted server is not silently equated with an HTTPS one. Only the three
 *   public providers with established clone spellings collapse across protocols.
 * - The raw input is NEVER returned on failure, so a caller cannot echo a
 *   credential-bearing origin into a log line or an error message.
 */

/** Also the `VARCHAR(2048)` width of `workspace_repos.normalized_git_remote`. */
const MAX_REMOTE_LENGTH = 2_048;
const HOSTED_PROVIDER_HOSTS = new Set(['bitbucket.org', 'github.com', 'gitlab.com']);
const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  'git:': '9418',
  'http:': '80',
  'https:': '443',
  'ssh:': '22',
};
const SUPPORTED_PROTOCOLS = new Set(Object.keys(DEFAULT_PORTS));

export enum GitRemoteNormalizationErrorCode {
  Invalid = 'invalid',
  UnsupportedProtocol = 'unsupported_protocol',
}

export type GitRemoteNormalizationResult =
  | { status: 'normalized'; normalizedRemote: string }
  | { status: 'invalid'; code: GitRemoteNormalizationErrorCode };

/**
 * C0 AND C1, plus DEL. C1 (0x80–0x9f) matters as much as C0: `\x9b` is 8-bit
 * CSI and `\x9d` is 8-bit OSC on any terminal that honours them, and a stored
 * remote is echoed back into logs, error messages and the UI. It also breaks
 * idempotence — the URL branch percent-encodes such a byte while the scp and
 * provider branches would carry it through verbatim — so refusing it up front
 * is what keeps the SQL CHECK a pure shape check.
 */
function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))) return true;
  }
  return false;
}

/**
 * `workspace_repos_normalized_git_remote_check` (migration 20260901100000)
 * restated in TypeScript, plus the column's own `VARCHAR(2048)` width.
 *
 * This is what makes {@link normalizeGitRemote} TOTAL against the storage
 * boundary: every "normalized" answer is routed through {@link storable}, so a
 * value this predicate rejects leaves as a refusal instead of as a row the
 * database will bounce with a 500 halfway through a connect. The JS classes are
 * deliberately at least as strict as the SQL ones (`\s` ⊇ `[[:space:]]`), so a
 * value accepted here is accepted there.
 */
function satisfiesStorageCheck(value: string): boolean {
  if (value.length > MAX_REMOTE_LENGTH) return false;
  if (/[\s@?#]/u.test(value) || containsControlCharacter(value)) return false;
  if (/\.git$/i.test(value)) return false;
  return (
    /^(?:https?|ssh|git):\/\/[^/]+\/.+$/.test(value) || /^(?:github\.com|gitlab\.com|bitbucket\.org)\/.+$/.test(value)
  );
}

/** The one exit for a candidate normal form: storable, or the refusal path. */
function storable(normalizedRemote: string): GitRemoteNormalizationResult {
  return satisfiesStorageCheck(normalizedRemote)
    ? { status: 'normalized', normalizedRemote }
    : { status: 'invalid', code: GitRemoteNormalizationErrorCode.Invalid };
}

function normalizePath(path: string): string | undefined {
  let value = path.replace(/^\/+|\/+$/g, '');
  // `.git` is stripped to a FIXPOINT, not once: `acme/orders.git.git` would
  // otherwise normalize to `…orders.git`, which the storage CHECK rejects for
  // ending in `.git` — a refusal the caller could do nothing about.
  let previous = '';
  while (value !== previous) {
    previous = value;
    value = value.replace(/\.git$/i, '').replace(/\/+$/g, '');
  }
  if (!value || containsControlCharacter(value) || /[\s@?#]/u.test(value)) return undefined;
  return value;
}

/**
 * The host half of an scp-form remote (`git@host:org/repo`), validated by the
 * SAME parser the URL form goes through.
 *
 * The scp pattern captures "everything before the colon", which is not a proof
 * of hostness: `git@bad#host:o/r` used to become `ssh://bad#host/o/r`, and the
 * storage CHECK rejects `#`. Anything the URL parser reads as userinfo, a port,
 * a path, a query or a fragment therefore means the captured text was not a
 * bare host, and the remote is refused rather than canonicalized into a value
 * the database will not take.
 */
function normalizeScpHost(host: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(`ssh://${host}`);
  } catch {
    // intentional: unparseable means the scp capture was not a bare host, which
    // is exactly the refusal this function exists to make.
    return undefined;
  }
  if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return undefined;
  if (parsed.pathname !== '' && parsed.pathname !== '/') return undefined;
  // Lowercased for the same reason the URL branch lowercases: a non-ASCII host
  // is percent-encoded by the parser with UPPERCASE hex, and re-normalizing the
  // result would otherwise lowercase it and break idempotence — which is the
  // property the SQL CHECK relies on to stay a pure shape check.
  return parsed.hostname.toLowerCase() || undefined;
}

function normalizedProviderRemote(host: string, port: string, path: string): string | undefined {
  if (port || !HOSTED_PROVIDER_HOSTS.has(host)) return undefined;
  return `${host}/${path}`;
}

/** Normalize a Git origin for exact workspace-local identity matching. */
export function normalizeGitRemote(input: string): GitRemoteNormalizationResult {
  if (
    !input ||
    input.length > MAX_REMOTE_LENGTH ||
    input !== input.trim() ||
    containsControlCharacter(input) ||
    /\s/u.test(input)
  ) {
    return { status: 'invalid', code: GitRemoteNormalizationErrorCode.Invalid };
  }

  const providerForm = input.match(/^(bitbucket\.org|github\.com|gitlab\.com)\/(.+)$/i);
  if (providerForm) {
    const host = (providerForm[1] as string).toLowerCase();
    const path = normalizePath(providerForm[2] as string);
    return path ? storable(`${host}/${path}`) : { status: 'invalid', code: GitRemoteNormalizationErrorCode.Invalid };
  }

  const scp = input.match(/^(?:[^@/:]+@)?(\[[^\]]+\]|[^/:]+):(.+)$/);
  if (scp && !input.includes('://')) {
    const host = normalizeScpHost((scp[1] as string).toLowerCase());
    const path = normalizePath(scp[2] as string);
    if (!host || !path) return { status: 'invalid', code: GitRemoteNormalizationErrorCode.Invalid };
    const provider = normalizedProviderRemote(host, '', path);
    return storable(provider ?? `ssh://${host}/${path}`);
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { status: 'invalid', code: GitRemoteNormalizationErrorCode.Invalid };
  }
  if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) {
    return { status: 'invalid', code: GitRemoteNormalizationErrorCode.UnsupportedProtocol };
  }

  const host = parsed.hostname.toLowerCase();
  const path = normalizePath(parsed.pathname);
  if (!host || !path) return { status: 'invalid', code: GitRemoteNormalizationErrorCode.Invalid };

  const port = parsed.port === DEFAULT_PORTS[parsed.protocol] ? '' : parsed.port;
  const provider = normalizedProviderRemote(host, port, path);
  if (provider) return storable(provider);

  const authority = port ? `${host}:${port}` : host;
  return storable(`${parsed.protocol}//${authority}/${path}`);
}
