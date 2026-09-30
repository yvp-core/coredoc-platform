/**
 * Desktop ↔ server version handshake.
 *
 * On-prem servers permanently lag the hosted fleet, so a too-new app against a
 * too-old server is the standing condition, not an edge case. The server
 * publishes its version at `GET /api/v1/meta`; this module owns the desktop's
 * verdict about it. Advisory only — nothing here blocks a request.
 *
 * Pure logic + a process-lifetime cache, no electron imports, so it is covered
 * by the node-environment vitest suite.
 */

import { type ServerCompatInfo, ServerCompatState } from '../shared/ipc-types.js';

/**
 * Oldest Coredoc server this app supports. Hand-bumped when the app starts
 * depending on a server capability that older servers lack. 1.1.0 is the
 * current release line — the first servers that ship `/api/v1/meta`.
 */
export const MIN_SERVER_VERSION = '1.1.0';

export interface ServerMeta {
  version: string;
  minClientVersion: string;
}

/**
 * Numeric compare of `major.minor.patch`. Build/prerelease suffixes are cut
 * rather than ordered: this only has to answer "is one release line older than
 * another", and full semver precedence would be machinery with no caller.
 * Throws on anything that is not three numeric parts — an unparseable version
 * is not silently treated as equal.
 */
export function compareSemver(a: string, b: string): number {
  const parts = (value: string): number[] => {
    const core = value.trim().split(/[-+]/)[0];
    const nums = core.split('.');
    if (nums.length !== 3 || nums.some((part) => !/^\d+$/.test(part))) {
      throw new TypeError(`Not a semver version: ${value}`);
    }
    return nums.map(Number);
  };
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/**
 * `meta === null` means the server answered 404 for `/api/v1/meta`: it predates
 * the handshake entirely, which is itself the "server too old" signal.
 */
export function deriveCompatState(clientVersion: string, meta: ServerMeta | null): ServerCompatInfo {
  if (meta === null) {
    return { state: ServerCompatState.ServerTooOld, serverVersion: null, clientVersion };
  }
  if (compareSemver(meta.version, MIN_SERVER_VERSION) < 0) {
    return { state: ServerCompatState.ServerTooOld, serverVersion: meta.version, clientVersion };
  }
  if (compareSemver(clientVersion, meta.minClientVersion) < 0) {
    return { state: ServerCompatState.ClientTooOld, serverVersion: meta.version, clientVersion };
  }
  return { state: ServerCompatState.Compatible, serverVersion: meta.version, clientVersion };
}

function isNotFound(error: unknown): boolean {
  // Structural check rather than `instanceof ApiError`: importing server-api
  // would pull electron into this module and out of the unit-test suite.
  return (error as { status?: unknown } | null)?.status === 404;
}

function parseMeta(payload: unknown): ServerMeta {
  const version = (payload as { version?: unknown } | null)?.version;
  const minClientVersion = (payload as { minClientVersion?: unknown } | null)?.minClientVersion;
  if (typeof version !== 'string' || typeof minClientVersion !== 'string') {
    throw new TypeError('Malformed /api/v1/meta response');
  }
  return { version, minClientVersion };
}

/**
 * Runs the handshake. Returns `null` for "unknown" — the server is unreachable,
 * answered something unparseable, or reported a non-semver version. Unknown is
 * not a verdict, so the renderer shows nothing; only a 404 is evidence of an
 * old server.
 */
export async function resolveServerCompat(
  clientVersion: string,
  fetchMeta: () => Promise<unknown>,
): Promise<ServerCompatInfo | null> {
  let meta: ServerMeta | null;
  try {
    meta = parseMeta(await fetchMeta());
  } catch (error) {
    if (!isNotFound(error)) return null;
    meta = null;
  }
  try {
    return deriveCompatState(clientVersion, meta);
  } catch {
    return null;
  }
}

let cached: ServerCompatInfo | null = null;
/**
 * Bumped by every reset. A handshake that started before the app was pointed at
 * a different server describes the previous server, so it must not land in the
 * cache — captured at entry, compared after the await.
 *
 * A counter rather than keying the cache by server URL: this module deliberately
 * knows nothing about URL resolution (no electron import, so it stays in the
 * node-environment unit suite), and keying would mean threading the resolved URL
 * through `refreshServerCompat` / `getServerCompat` and every caller.
 */
let generation = 0;

/**
 * Re-runs the handshake (after connect / token restore) and caches the verdict.
 * Returns `null` — "unknown", the renderer's render-nothing state — when the
 * server changed mid-flight, rather than a verdict about a server the app has
 * already left.
 */
export async function refreshServerCompat(
  clientVersion: string,
  fetchMeta: () => Promise<unknown>,
): Promise<ServerCompatInfo | null> {
  const startedAt = generation;
  const result = await resolveServerCompat(clientVersion, fetchMeta);
  if (startedAt !== generation) return null;
  cached = result;
  return cached;
}

/**
 * Drop the cached verdict. The cache is keyed on nothing but process lifetime,
 * so it MUST be cleared whenever the app is pointed at a different server —
 * otherwise the banner keeps reporting the previous server's version.
 */
export function resetServerCompat(): void {
  cached = null;
  generation++;
}

/** Cached verdict, or a fresh handshake when nothing has been resolved yet. */
export async function getServerCompat(
  clientVersion: string,
  fetchMeta: () => Promise<unknown>,
): Promise<ServerCompatInfo | null> {
  return cached ?? refreshServerCompat(clientVersion, fetchMeta);
}
