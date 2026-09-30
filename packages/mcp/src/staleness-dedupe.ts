/**
 * Session-scoped dedupe for the staleness banner (see formatStalenessHeader
 * in response-formatter.ts).
 *
 * Every MCP answer repeats the full freshness banner, which over a long
 * session is pure token repetition and trains agents to skip `>`-prefixed
 * lines. This tracks, per session and per repo, the parse state
 * (`parsedAt` + `parsedCommit`) last shown, so a repeat mention with
 * unchanged state can render a one-line compact form instead.
 */

/** Every Nth banner emission in a session renders full regardless, so a long-running session still gets periodic reminders. */
export const STALENESS_REFRESH_INTERVAL = 20;

// ponytail: simple insertion-order eviction (oldest session dropped once the
// cap is hit) — good enough for a per-process stdio server; swap for an LRU
// only if session churn ever makes eviction order matter.
export const STALENESS_SESSION_CAP = 100;

interface RepoStamp {
  parsedAt: string;
  parsedCommit?: string;
}

interface SessionState {
  perRepo: Map<string, RepoStamp>;
  emissions: number;
}

const sessions = new Map<string, SessionState>();

function getOrCreateSession(key: string): SessionState {
  let session = sessions.get(key);
  if (!session) {
    if (sessions.size >= STALENESS_SESSION_CAP) {
      const oldestKey = sessions.keys().next().value;
      if (oldestKey !== undefined) sessions.delete(oldestKey);
    }
    session = { perRepo: new Map(), emissions: 0 };
    sessions.set(key, session);
  }
  return session;
}

function stampsEqual(a: RepoStamp | undefined, b: RepoStamp): boolean {
  return a !== undefined && a.parsedAt === b.parsedAt && a.parsedCommit === b.parsedCommit;
}

export interface RepoStalenessState {
  name: string;
  parsedAt: string;
  parsedCommit?: string;
}

/**
 * Decide whether a staleness banner mentioning `repos` should render FULL
 * (true) or may render compact (false), and record the emission as a side
 * effect. Call exactly once per banner emission.
 *
 * - No `sessionKey` → always full (safe fallback; never silently compact
 *   without a key to dedupe against).
 * - Any repo whose state is new or changed since last shown in this session
 *   → full (for every repo in the banner, not just the changed one).
 * - Otherwise every `STALENESS_REFRESH_INTERVAL`-th emission in the session
 *   forces a refresh even when nothing changed.
 */
export function shouldRenderFullBanner(sessionKey: string | undefined, repos: RepoStalenessState[]): boolean {
  if (!sessionKey) return true;

  const session = getOrCreateSession(sessionKey);
  session.emissions += 1;
  const forceRefresh = session.emissions % STALENESS_REFRESH_INTERVAL === 0;

  let anyChanged = false;
  for (const repo of repos) {
    const stamp: RepoStamp = { parsedAt: repo.parsedAt, parsedCommit: repo.parsedCommit };
    if (!stampsEqual(session.perRepo.get(repo.name), stamp)) anyChanged = true;
    session.perRepo.set(repo.name, stamp);
  }

  return anyChanged || forceRefresh;
}
