/**
 * The run sweep's retention job: machine-derived data (events, turns and
 * state archives) is deleted 30 days after a run ends, in bounded batches.
 * Human records — runs, spec versions, questions and answers, acceptances and
 * change requests — are never deleted here.
 */
import type { SweepDeps } from './run-limits.sweep.js';

export const RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
/** Rows per batch, and batches per table per tick; the next tick takes the rest. */
const BATCH = 500;
const MAX_BATCHES = 10;

export async function pruneEndedRuns(deps: SweepDeps): Promise<void> {
  const cutoff = new Date(deps.now().getTime() - RETENTION_DAYS * DAY_MS);
  try {
    const turns = await batched(() => pruneTurns(deps, cutoff));
    const archives = await batched(() => pruneRunArchives(deps, cutoff));
    const events = await batched(() => pruneEvents(deps, cutoff));
    if (turns + archives + events > 0) {
      deps.logger.log(
        `agent run retention: deleted ${turns} turns, ${archives} run archives and ${events} events of runs ended before ${cutoff.toISOString()}`,
      );
    }
  } catch (error) {
    deps.logger.error(`Agent run retention failed: ${(error as Error).message}`);
  }
}

async function batched(purge: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const deleted = await purge();
    total += deleted;
    if (deleted < BATCH) break;
  }
  return total;
}

/** Turns go with the archives they uploaded; a turn whose archive could not be deleted waits for the next tick. */
async function pruneTurns(deps: SweepDeps, cutoff: Date): Promise<number> {
  const rows = await deps.prisma.$queryRaw<Array<{ id: string; state_archive_key: string | null }>>`
    SELECT t.id, t.state_archive_key
    FROM cloud_agent_run_turns t
    JOIN cloud_agent_runs r ON r.id = t.run_id
    WHERE r.finished_at < ${cutoff}
    ORDER BY t.id
    LIMIT ${BATCH}`;
  const deletable = await withArchivesDeleted(deps, rows);
  if (deletable.length === 0) return 0;
  // MCP tokens a turn still owned cascade with it.
  const { count } = await deps.prisma.cloudAgentRunTurn.deleteMany({ where: { id: { in: deletable } } });
  return count;
}

async function pruneRunArchives(deps: SweepDeps, cutoff: Date): Promise<number> {
  const rows = await deps.prisma.$queryRaw<Array<{ id: string; state_archive_key: string | null }>>`
    SELECT id, state_archive_key
    FROM cloud_agent_runs
    WHERE finished_at < ${cutoff} AND state_archive_key IS NOT NULL
    ORDER BY id
    LIMIT ${BATCH}`;
  const cleared = await withArchivesDeleted(deps, rows);
  if (cleared.length === 0) return 0;
  const { count } = await deps.prisma.cloudAgentRun.updateMany({
    where: { id: { in: cleared } },
    data: { stateArchiveKey: null },
  });
  return count;
}

async function pruneEvents(deps: SweepDeps, cutoff: Date): Promise<number> {
  return deps.prisma.$executeRaw`
    WITH selected AS MATERIALIZED (
      SELECT e.id
      FROM cloud_agent_run_events e
      JOIN cloud_agent_runs r ON r.id = e.run_id
      WHERE r.finished_at < ${cutoff}
      ORDER BY e.id
      LIMIT ${BATCH}
    )
    DELETE FROM cloud_agent_run_events e USING selected WHERE e.id = selected.id`;
}

/** The ids whose archive (if any) is gone from the store. */
async function withArchivesDeleted(
  deps: SweepDeps,
  rows: Array<{ id: string; state_archive_key: string | null }>,
): Promise<string[]> {
  const deleted: string[] = [];
  for (const row of rows) {
    try {
      if (row.state_archive_key) await deps.archives.delete(row.state_archive_key);
      deleted.push(row.id);
    } catch (error) {
      deps.logger.warn(`Could not delete state archive ${row.state_archive_key}: ${(error as Error).message}`);
    }
  }
  return deleted;
}
