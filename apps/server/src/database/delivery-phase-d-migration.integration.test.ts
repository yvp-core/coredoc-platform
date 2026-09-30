import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const DATABASE_URL = process.env.PHASE_D_MIGRATION_TEST_DATABASE_URL;
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe.skipIf(!DATABASE_URL)('Phase-D delivery cleanup migration (PostgreSQL)', () => {
  it('drops the retired model while preserving canonical delivery and capture rows', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [resolve(SERVER_ROOT, 'scripts/test-delivery-phase-d-migration.mjs')],
      {
        cwd: SERVER_ROOT,
        env: { ...process.env, PHASE_D_MIGRATION_TEST_DATABASE_URL: DATABASE_URL },
      },
    );

    expect(JSON.parse(stdout)).toEqual({
      retained: {
        connectors: 2,
        raw_payloads: 1,
        status_maps: 1,
        code_changes: 1,
        actors: 1,
        actor_identities: 1,
        tasks: 1,
        external_refs: 2,
        capture_events: 1,
        agent_sessions: 1,
        workflow_runs: 1,
        push_jobs: 1,
      },
      externalRefs: [
        { provider: 'coredoc', detached: true },
        { provider: 'jira', detached: false },
      ],
      workflow: { run_id: 'cdr-20260818-a1b2c3', session_id: 'session-1' },
      remainingTables: [],
      remainingTypes: [],
      remainingAgentColumns: [],
      statusStagePresent: false,
    });
  });
});
