import { Prisma } from '../../generated/prisma/client.js';

/**
 * Excludes hook-created skeleton rows with no telemetry signal ("ghost
 * sessions") — shared by the summary, the by-user breakdown, the metrics
 * timeseries SQL (metrics.service.ts getFlowSeries) and the analytics usage
 * read so every surface counts the same sessions.
 */
export const GHOST_SESSION_EXCLUSION: Prisma.AgentSessionWhereInput[] = [
  { lastEventNanos: { gt: 0 } },
  { activeTimeSec: { gt: 0 } },
  { tokensInput: { gt: 0 } },
  { tokensOutput: { gt: 0 } },
  { commitCount: { gt: 0 } },
];
