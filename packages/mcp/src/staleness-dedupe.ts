/**
 * Session-scoped dedupe for the staleness banner (see formatStalenessHeader
 * in response-formatter.ts).
 *
 * Repeating the same banner on every MCP answer is pure token cost. This
 * records, per session, the banner texts already shown, so an exact repeat
 * renders nothing. Any change in what the banner says (another repo, a new
 * commit or parse date) changes the text, so it renders again.
 */

/** Every Nth banner emission in a session renders regardless, so a long-running session still gets periodic reminders. */
export const STALENESS_REFRESH_INTERVAL = 20;

// ponytail: simple insertion-order eviction (oldest session dropped once the
// cap is hit) — good enough for a per-process stdio server; swap for an LRU
// only if session churn ever makes eviction order matter.
export const STALENESS_SESSION_CAP = 100;

interface SessionState {
  shown: Set<string>;
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
    session = { shown: new Set(), emissions: 0 };
    sessions.set(key, session);
  }
  return session;
}

/**
 * True when `banner` was already shown in this session and may be omitted.
 * Records the emission as a side effect; call exactly once per banner.
 *
 * - No `sessionKey` → never a repeat (the stateless cloud transport has no
 *   session to dedupe against).
 * - Every `STALENESS_REFRESH_INTERVAL`-th emission in the session renders
 *   even when unchanged.
 */
export function isRepeatBanner(sessionKey: string | undefined, banner: string): boolean {
  if (!sessionKey) return false;

  const session = getOrCreateSession(sessionKey);
  session.emissions += 1;
  const repeat = session.shown.has(banner) && session.emissions % STALENESS_REFRESH_INTERVAL !== 0;
  session.shown.add(banner);
  return repeat;
}
