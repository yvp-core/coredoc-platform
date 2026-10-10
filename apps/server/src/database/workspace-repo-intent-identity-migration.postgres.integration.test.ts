import '../config/load-env.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

const DATABASE_URL = process.env.INTENT_MIGRATION_TEST_DATABASE_URL;
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION_PATH = resolve(
  SERVER_ROOT,
  'prisma/migrations/20260901100000_add_workspace_repo_intent_identity/migration.sql',
);

function graphHash(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

describe.skipIf(!DATABASE_URL)('workspace repo intent identity migration (PostgreSQL)', () => {
  it('backfills only provable keys and enforces distinct bounded identity fields', async () => {
    const client = new pg.Client({ connectionString: DATABASE_URL });
    const schema = `repo_identity_${randomUUID().replaceAll('-', '')}`;
    const workspaceId = randomUUID();
    const migrationSql = await readFile(MIGRATION_PATH, 'utf8');
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await client.query(`
        CREATE TABLE workspace_repos (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          workspace_id UUID NOT NULL,
          repo_key TEXT NOT NULL,
          repo_name TEXT NOT NULL,
          git_url TEXT
        )
      `);
      await client.query(
        `INSERT INTO workspace_repos (workspace_id, repo_key, repo_name, git_url)
         VALUES ($1, $2, 'orders', 'https://user:secret@example.com/orders.git'),
                ($1, 'explicit-hash', 'display-only', 'https://example.com/display-only.git')`,
        [workspaceId, graphHash('orders')],
      );

      await client.query(migrationSql);
      await client.query('SAVEPOINT wrong_graph_hash');
      await expect(
        client.query(
          'SELECT repo_name, intent_repo_key, normalized_git_remote FROM workspace_repos ORDER BY repo_name',
        ),
      ).resolves.toMatchObject({
        rows: [
          { repo_name: 'display-only', intent_repo_key: null, normalized_git_remote: null },
          { repo_name: 'orders', intent_repo_key: 'orders', normalized_git_remote: null },
        ],
      });

      await expect(
        client.query(
          `INSERT INTO workspace_repos
             (workspace_id, repo_key, repo_name, intent_repo_key, normalized_git_remote)
           VALUES ($1, 'wrong-hash', 'bad', 'bad', 'github.com/Acme/Bad')`,
          [workspaceId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT wrong_graph_hash');
      await client.query('RELEASE SAVEPOINT wrong_graph_hash');

      await client.query('SAVEPOINT raw_remote');
      await expect(
        client.query(
          `INSERT INTO workspace_repos
             (workspace_id, repo_key, repo_name, intent_repo_key, normalized_git_remote)
           VALUES ($1, $2, 'raw', 'raw', 'https://user:secret@github.com/Acme/Raw.git')`,
          [workspaceId, graphHash('raw')],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT raw_remote');
      await client.query('RELEASE SAVEPOINT raw_remote');

      await client.query(
        `INSERT INTO workspace_repos
           (workspace_id, repo_key, repo_name, intent_repo_key, normalized_git_remote)
         VALUES ($1, $2, 'one', 'one', 'github.com/Acme/Shared'),
                ($1, $3, 'two', 'two', 'github.com/Acme/Shared')`,
        [workspaceId, graphHash('one'), graphHash('two')],
      );
      await client.query('SAVEPOINT duplicate_durable_key');
      await expect(
        client.query(
          `INSERT INTO workspace_repos
             (workspace_id, repo_key, repo_name, intent_repo_key)
           VALUES ($1, $2, 'duplicate', 'one')`,
          [workspaceId, graphHash('one')],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await client.query('ROLLBACK TO SAVEPOINT duplicate_durable_key');
      await client.query('RELEASE SAVEPOINT duplicate_durable_key');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  });
});
