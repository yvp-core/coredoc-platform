/**
 * ID + session model for telemetry — repo scoping, session stitching, and
 * per-invocation ids. Emit logic (P0.5) is out of scope here (SRP).
 */

import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { resolveCoredocHome } from '../utils/coredoc-home.js';
import type { Surface } from './events.js';

/** Sliding-window TTL for a file-backed CLI session (30 minutes). */
const SESSION_TTL_MS = 30 * 60_000;

function getDefaultSessionFile(): string {
  return join(resolveCoredocHome(), 'session.json');
}

interface SessionFileShape {
  sessionId: string;
  lastActivityAt: number;
}

/**
 * Deterministic, non-joinable repo identifier: HMAC-SHA256 keyed on the
 * install id, over the resolved repo path, hex-encoded and truncated to 16
 * chars. Synchronous and must never throw — `repoRoot` may not exist yet
 * (e.g. during onboarding), so `realpath` resolution is best-effort with a
 * `path.resolve` fallback.
 */
export function repoId(installId: string, repoRoot: string): string {
  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(repoRoot);
  } catch {
    resolvedPath = resolve(repoRoot);
  }
  return createHmac('sha256', installId).update(resolvedPath).digest('hex').slice(0, 16);
}

/** Generates a fresh per-invocation id (uuid v4). */
export function newInvocationId(): string {
  return randomUUID();
}

export interface ResolveSessionOptions {
  surface: Surface;
  /** Env-passed session id (e.g. desktop passthrough) — wins over the file when present. */
  envSessionId?: string;
  /** Session file path override, used by tests; defaults to `~/.coredoc/session.json`. */
  sessionFile?: string;
  /** Clock override for deterministic tests; defaults to `Date.now()`. */
  now?: number;
}

/**
 * Resolves the session id to stamp on telemetry events: an explicit env id
 * (desktop passthrough) always wins; otherwise a sliding-window file session
 * is reused if still fresh (< 30 min since last activity) or minted fresh
 * otherwise, and `lastActivityAt` is touched either way so the file
 * effectively slides forward on continued use.
 */
export async function resolveSession(opts: ResolveSessionOptions): Promise<string> {
  if (opts.envSessionId) {
    return opts.envSessionId;
  }

  const now = opts.now ?? Date.now();
  const file = opts.sessionFile ?? getDefaultSessionFile();

  let sessionId: string | undefined;
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as SessionFileShape;
    if (now - parsed.lastActivityAt < SESSION_TTL_MS) {
      sessionId = parsed.sessionId;
    }
  } catch {
    // Missing or corrupt session file — treat as no session, mint fresh below.
  }

  sessionId ??= randomUUID();

  // Best-effort write: a session-file write failure is a non-critical
  // heuristic and must never break the calling command.
  try {
    await mkdir(dirname(file), { recursive: true });
    const body: SessionFileShape = { sessionId, lastActivityAt: now };
    await writeFile(file, JSON.stringify(body), { mode: 0o600 });
  } catch {
    // Swallow — session stitching degrades gracefully to a fresh id next call.
  }

  return sessionId;
}
