/**
 * Fleet-managed desktop configuration — the IT-admin's pin for an on-prem
 * install, deployable by MDM to a fixed, root-owned OS path.
 *
 * Pure resolution + a process-wide cache. The cache is filled exactly once, at
 * startup, by `managed-config-boot.ts` (which owns the only `electron` import,
 * mirroring the `e2e-mode` / `e2e-mode-boot` split so this module stays unit
 * testable). Everything else reads `getManagedConfig()`.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeServerUrl } from '../shared/server-url-format.js';

export interface ManagedDesktopConfig {
  /** Pinned Coredoc server; wins over every other source in `server-url.ts`. */
  serverUrl: string | null;
  /** Pinned electron-updater generic feed; never read from env or renderer. */
  updateFeedUrl: string | null;
}

/** No managed config deployed — the hosted/default case. */
export const MANAGED_CONFIG_NONE: ManagedDesktopConfig = Object.freeze({ serverUrl: null, updateFeedUrl: null });

const CONFIG_FILE = 'managed-config.json';

/**
 * Test-only path override. Honored solely in unpackaged builds: a packaged app
 * that took this path from the environment would let any local process redirect
 * the whole fleet's server and update feed.
 */
const PATH_ENV = 'COREDOC_MANAGED_CONFIG_PATH';

/** Windows location, fixed literal — see the note in defaultManagedConfigPath. */
const WINDOWS_PROGRAM_DATA = 'C:\\ProgramData';

/**
 * Fixed per-OS location an MDM profile can write.
 *
 * On Windows the packaged app uses the literal `C:\ProgramData` rather than
 * `%ProgramData%`: environment variables are attacker-controllable per process,
 * so honoring one here would let anything that can launch Coredoc with a
 * doctored environment point the fleet's server and update feed wherever it
 * likes. `%ProgramData%` is only consulted in unpackaged (dev) builds, where
 * the env escape hatch below already exists anyway.
 */
export function defaultManagedConfigPath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  isPackaged: boolean,
): string {
  if (platform === 'darwin') return join('/Library/Application Support/Coredoc', CONFIG_FILE);
  if (platform === 'win32') {
    const base = isPackaged ? WINDOWS_PROGRAM_DATA : env.ProgramData?.trim() || WINDOWS_PROGRAM_DATA;
    return join(base, 'Coredoc', CONFIG_FILE);
  }
  return join('/etc/coredoc', CONFIG_FILE);
}

export function resolveManagedConfigPath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  isPackaged: boolean,
): string {
  const override = env[PATH_ENV]?.trim();
  if (override && !isPackaged) return override;
  return defaultManagedConfigPath(platform, env, isPackaged);
}

function warn(path: string, reason: string): ManagedDesktopConfig {
  console.warn(`[ManagedConfig] Ignoring ${path}: ${reason}`);
  return MANAGED_CONFIG_NONE;
}

export interface ReadManagedConfigOptions {
  /**
   * Require the file to be root-owned and not group/other-writable before
   * trusting it. On by default for the fixed OS paths on macOS/Linux; off for
   * the dev-only `COREDOC_MANAGED_CONFIG_PATH` fixture and on Windows (see
   * `isTrustedOwnership`).
   */
  requireRootOwnership?: boolean;
}

/**
 * The managed config outranks every other server-URL source and also pins the
 * update feed, so a file any local user can rewrite is a fleet-wide redirect
 * primitive. The fixed OS paths are admin-only directories, but the file inside
 * one still has to be root-owned and not group/other-writable — a
 * world-writable drop from a sloppy MDM payload is refused exactly like
 * malformed JSON: warn and fall back to the unmanaged chain.
 *
 * Windows has no comparable uid/mode check here (ACLs, not POSIX bits). The
 * residual risk is that Coredoc trusts `C:\ProgramData\Coredoc\` to be
 * admin-writable only, which is its default ACL — documented in
 * `docs/onprem/INSTALL.md` §12 so a fleet admin who loosened it knows.
 */
function checkOwnership(path: string): 'trusted' | 'missing' | string {
  let stats: { uid: number; mode: number };
  try {
    stats = statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return `unreadable (${(error as Error).message})`;
  }
  if (stats.uid !== 0) return `not owned by root (uid ${stats.uid}) — an MDM profile must install it as root`;
  // 0o022 = group-write | other-write.
  if ((stats.mode & 0o022) !== 0) {
    return `group- or other-writable (mode ${(stats.mode & 0o777).toString(8)}) — chmod it to 0644 or stricter`;
  }
  return 'trusted';
}

/**
 * Read and validate the managed config. An absent file is the normal case. A
 * malformed one is ignored with a loud warning rather than thrown: a bad MDM
 * payload must not brick the app, it must fall back to the unmanaged chain.
 */
export function readManagedConfig(path: string, options: ReadManagedConfigOptions = {}): ManagedDesktopConfig {
  if (options.requireRootOwnership) {
    const ownership = checkOwnership(path);
    // A missing file is the normal unmanaged case, not a warning.
    if (ownership === 'missing') return MANAGED_CONFIG_NONE;
    if (ownership !== 'trusted') return warn(path, ownership);
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return MANAGED_CONFIG_NONE;
    return warn(path, `unreadable (${(error as Error).message})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return warn(path, 'not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return warn(path, 'top level must be a JSON object');
  }

  const { serverUrl, updateFeedUrl } = parsed as { serverUrl?: unknown; updateFeedUrl?: unknown };
  const resolved: ManagedDesktopConfig = { serverUrl: null, updateFeedUrl: null };

  for (const [key, value] of [
    ['serverUrl', serverUrl],
    ['updateFeedUrl', updateFeedUrl],
  ] as const) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') return warn(path, `${key} must be a string`);
    const normalized = normalizeServerUrl(value);
    if (!normalized) return warn(path, `${key} is not an http(s) URL: ${value}`);
    resolved[key] = normalized;
  }

  return resolved;
}

let cached: ManagedDesktopConfig | null = null;

/** Read the managed config once and cache it for the rest of the process life. */
export function initManagedConfig(input: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
}): ManagedDesktopConfig {
  const path = resolveManagedConfigPath(input.platform, input.env, input.isPackaged);
  const isDevOverride = path !== defaultManagedConfigPath(input.platform, input.env, input.isPackaged);
  cached = readManagedConfig(path, {
    // Windows is excluded (POSIX uid/mode do not describe its ACLs) and so is
    // the dev-only env override, whose fixture legitimately belongs to the
    // developer running the app.
    requireRootOwnership: input.platform !== 'win32' && !isDevOverride,
  });
  return cached;
}

/**
 * The managed config for this run. `MANAGED_CONFIG_NONE` before
 * `initManagedConfig` has run, which is also the shape of "no file deployed" —
 * the app boots unmanaged either way, and boot ordering is owned by the single
 * `managed-config-boot.js` import at the top of `main/index.ts`.
 */
export function getManagedConfig(): ManagedDesktopConfig {
  return cached ?? MANAGED_CONFIG_NONE;
}

/** Test seam: drop the cache so a suite can re-init with a different fixture. */
export function resetManagedConfigForTests(): void {
  cached = null;
}
