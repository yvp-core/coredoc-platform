import '../config/load-env.js';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

const DATABASE_URL = process.env.CLOUD_AGENT_RUNS_TEST_DATABASE_URL;
const migration = new URL(
  '../../prisma/migrations/20261030120000_cloud_agent_run_phase_questions_policy/migration.sql',
  import.meta.url,
);
const TABLES = ['agent_run_settings', 'cloud_agent_runs'];

describe.skipIf(!DATABASE_URL)('per-phase questions policy migration (PostgreSQL)', () => {
  it('gives each row its policy for both phases, and defaults rows a pre-migration server inserts', async () => {
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      await client.query('BEGIN');
      // Temporary tables shadow the real ones on this connection only.
      for (const table of TABLES) {
        await client.query(
          `CREATE TEMP TABLE "${table}" (id INT PRIMARY KEY, questions_policy VARCHAR(16) NOT NULL) ON COMMIT DROP`,
        );
        await client.query(`INSERT INTO "${table}" VALUES (1, 'pause'), (2, 'assume')`);
      }

      await client.query(await readFile(migration, 'utf8'));

      for (const table of TABLES) {
        await client.query(`INSERT INTO "${table}" (id, questions_policy) VALUES (3, 'assume')`);
        const { rows } = await client.query(
          `SELECT id, questions_policy, implement_questions_policy FROM "${table}" ORDER BY id`,
        );
        expect(rows).toEqual([
          { id: 1, questions_policy: 'pause', implement_questions_policy: 'pause' },
          { id: 2, questions_policy: 'assume', implement_questions_policy: 'assume' },
          { id: 3, questions_policy: 'assume', implement_questions_policy: 'pause' },
        ]);
      }
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  });
});
