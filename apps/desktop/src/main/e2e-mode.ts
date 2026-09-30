/**
 * End-to-end harness boundary — pure functions only.
 *
 * This module is imported by production spawn sites (chat-service, command-runner,
 * agent-run/claude-adapter, cloud-docs-manager) for `isE2EMode`, so it must stay
 * side-effect-free. The application of the boundary lives in `e2e-mode-boot.ts`.
 *
 * The variables are prefixed COREDOC_DESKTOP_* (like COREDOC_DESKTOP_QA_PORT):
 * they configure this app only and must not collide with CLI/package env names.
 */

import { isAbsolute } from 'node:path';

export interface E2EMode {
  userDataDir: string;
  serverUrl: string;
  workspaceDir: string;
}

interface E2EModeHost {
  mkdirRecursive(path: string): void;
  setPath(name: 'userData', path: string): void;
  setServerUrl(url: string): void;
  /** The env child processes (sdk-worker, CLI spawns) inherit. */
  env: NodeJS.ProcessEnv;
}

const FLAG = 'COREDOC_DESKTOP_E2E';

/**
 * Strict tri-state read of the opt-in flag: exactly `'1'` enables e2e mode,
 * unset/empty/`'0'` disables it, and anything else throws. A lenient parse here
 * fails open — `COREDOC_DESKTOP_E2E=true` would silently run the suite against
 * the developer's real profile, cloud API, and LLM credentials.
 */
export function isE2EMode(env: NodeJS.ProcessEnv): boolean {
  const value = env[FLAG]?.trim() ?? '';
  if (value === '1') return true;
  if (value === '' || value === '0') return false;
  throw new Error(`${FLAG} must be '1' or unset (got ${JSON.stringify(env[FLAG])})`);
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required when ${FLAG} is enabled`);
  }
  return value;
}

/**
 * The fixture server must be a loopback HTTP origin: the boundary exists to keep
 * a run off the network, and a routable or TLS origin means the harness is
 * pointing the app at something it does not own.
 */
function requireLoopbackHttpUrl(env: NodeJS.ProcessEnv, name: string): string {
  const value = requireEnv(env, name);

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL: ${value}`);
  }
  if (parsed.protocol !== 'http:' || (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost')) {
    throw new Error(`${name} must be an http:// loopback origin (127.0.0.1 or localhost), got ${value}`);
  }
  return value;
}

function requireAbsoluteExisting(value: string, name: string, kind: 'directory' | 'file', probe: () => boolean): void {
  if (!isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path (got ${value})`);
  }
  if (!probe()) {
    throw new Error(`${name} is not an existing ${kind}: ${value}`);
  }
}

/**
 * Resolve the end-to-end harness boundary from the environment.
 * E2E mode is all-or-nothing: with the flag on, a missing profile dir, fixture
 * server URL, or seeded workspace throws instead of degrading into a run against
 * the developer's real profile, the real cloud API, or the real monorepo.
 */
export function resolveE2EMode(
  env: NodeJS.ProcessEnv,
  isPackaged: boolean,
  dirExists: (candidate: string) => boolean,
): E2EMode | null {
  if (!isE2EMode(env)) return null;
  if (isPackaged) {
    throw new Error(`${FLAG} is supported only by development builds`);
  }

  return {
    userDataDir: requireEnv(env, `${FLAG}_USER_DATA_DIR`),
    serverUrl: requireLoopbackHttpUrl(env, `${FLAG}_SERVER_URL`),
    workspaceDir: requireWorkspaceDir(env, dirExists),
  };
}

/**
 * Absolute path of a plaintext credentials file the harness seeds, or null.
 *
 * Why a seam at all: `auth-manager` persists credentials through `safeStorage`,
 * which binds them to the login Keychain — a seeded plaintext credentials store
 * cannot decrypt, so a cloud fixture would always boot logged out. Reading the
 * tokens from an explicit file is the smallest way to launch authenticated.
 *
 * Optional: without the var the app boots logged out, which is what the `empty`
 * and `local-project` profiles want. Set-but-invalid throws. Gated on e2e mode,
 * so the var is inert in a real dev/prod run, and e2e mode itself is rejected in
 * packaged builds.
 */
export function resolveE2EAuthFile(env: NodeJS.ProcessEnv, fileExists: (candidate: string) => boolean): string | null {
  if (!isE2EMode(env)) return null;

  const name = `${FLAG}_AUTH_FILE`;
  const value = env[name]?.trim();
  if (!value) return null;

  requireAbsoluteExisting(value, name, 'file', () => fileExists(value));
  return value;
}

/**
 * Absolute workspace root (the dir holding `coredoc.config.json`) the harness
 * seeds. Null outside e2e mode; required (and validated) inside it.
 *
 * Why: `runtime-paths` derives the unpackaged workspace root from the main
 * bundle's own location, so without this override a hermetic launch would read
 * the developer's monorepo. Required rather than optional precisely because that
 * fallback is the failure it exists to prevent.
 */
export function resolveE2EWorkspaceDir(
  env: NodeJS.ProcessEnv,
  dirExists: (candidate: string) => boolean,
): string | null {
  if (!isE2EMode(env)) return null;
  return requireWorkspaceDir(env, dirExists);
}

function requireWorkspaceDir(env: NodeJS.ProcessEnv, dirExists: (candidate: string) => boolean): string {
  const name = `${FLAG}_WORKSPACE_DIR`;
  const value = requireEnv(env, name);
  requireAbsoluteExisting(value, name, 'directory', () => dirExists(value));
  return value;
}

export function applyE2EMode(host: E2EModeHost, mode: E2EMode | null): void {
  if (mode === null) return;

  // Electron's setPath('userData', …) requires the target to exist.
  host.mkdirRecursive(mode.userDataDir);
  host.setPath('userData', mode.userDataDir);

  host.setServerUrl(mode.serverUrl);
  // setServerUrl is in-memory only; the CLI running inside sdk-worker children
  // reads the env, and would otherwise default to http://localhost:3000.
  host.env.COREDOC_SERVER_URL = mode.serverUrl;
  // Hermeticity is owned by this boundary, not by the harness: no analytics
  // egress from the app or any process it spawns.
  host.env.COREDOC_TELEMETRY_DISABLED = '1';
}
