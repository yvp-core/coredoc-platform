import '../config/load-env.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { CI_TOKEN_PERMISSIONS } from '../auth/token-permissions.js';

const DATABASE_URL = process.env.TOKEN_TEST_DATABASE_URL;
const migration = new URL(
  '../../prisma/migrations/20260912233000_ci_token_intent_permissions/migration.sql',
  import.meta.url,
);
const OLD_CI = ['parser:read', 'parser:write', 'result:read', 'result:write', 'repo:push'];

describe.skipIf(!DATABASE_URL)('CI token intent permission migration (PostgreSQL)', () => {
  it('upgrades only the known CI purpose, preserving credentials, other scopes and retry safety', async () => {
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      await client.query('BEGIN');
      // The temporary table shadows the real table on this connection only.
      await client.query(
        'CREATE TEMP TABLE service_tokens (LIKE public.service_tokens INCLUDING DEFAULTS) ON COMMIT DROP',
      );
      const cases = [
        { name: 'ci', permissions: OLD_CI, upgrade: true },
        { name: 'ci-reordered', permissions: [...OLD_CI].reverse(), upgrade: true },
        { name: 'ci-partial-upgrade', permissions: [...OLD_CI, 'intent:release'], upgrade: true },
        { name: 'ci-current', permissions: [...CI_TOKEN_PERMISSIONS], upgrade: false },
        { name: 'wildcard', permissions: ['*'], upgrade: false },
        { name: 'custom-publisher', permissions: [...OLD_CI, 'graph:read'], upgrade: false },
        { name: 'partial-publisher', permissions: ['repo:push'], upgrade: false },
        { name: 'mcp', permissions: ['intent:read', 'intent:propose'], upgrade: false },
        { name: 'telemetry', permissions: ['telemetry:write'], upgrade: false },
        { name: 'old-release', permissions: ['intent:release', 'intent:bindings'], upgrade: false },
      ];
      for (const fixture of cases) {
        await client.query(
          `INSERT INTO service_tokens (workspace_id, name, token_hash, token_encrypted, token_prefix, permissions, created_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'fixture-owner', '2028-01-01')`,
          [
            randomUUID(),
            fixture.name,
            `hash-${fixture.name}`,
            `encrypted-${fixture.name}`,
            'cdt_fixture',
            fixture.permissions,
          ],
        );
      }
      const before = (await client.query('SELECT * FROM service_tokens ORDER BY name')).rows;
      const sql = await readFile(migration, 'utf8');
      expect((await client.query(sql)).rowCount).toBe(3);
      const after = (await client.query('SELECT * FROM service_tokens ORDER BY name')).rows;
      for (const [index, row] of after.entries()) {
        const fixture = cases.find((item) => item.name === row.name)!;
        expect({ ...row, permissions: before[index].permissions }).toEqual(before[index]);
        expect(row.permissions).toEqual(
          fixture.upgrade
            ? [
                ...fixture.permissions,
                ...['intent:release', 'intent:bindings'].filter(
                  (permission) => !fixture.permissions.includes(permission),
                ),
              ]
            : fixture.permissions,
        );
        expect(new Set(row.permissions).size).toBe(row.permissions.length);
      }
      expect((await client.query(sql)).rowCount).toBe(0);
      expect((await client.query('SELECT * FROM service_tokens ORDER BY name')).rows).toEqual(after);
      // Exercise the documented rollback on a shadow table, including independent grant edits.
      await client.query(
        'CREATE TEMP TABLE prior_ci_permissions (id uuid PRIMARY KEY, permissions text[]) ON COMMIT DROP',
      );
      for (const row of before)
        await client.query('INSERT INTO prior_ci_permissions VALUES ($1, $2)', [row.id, row.permissions]);
      await client.query(
        "UPDATE service_tokens SET permissions = permissions || ARRAY['intent:read']::text[] WHERE name = 'ci-reordered'",
      );
      const guide = await readFile(new URL('../../../../docs/ci-cd-integration.md', import.meta.url), 'utf8');
      const rollback = guide.match(/UPDATE service_tokens AS token[\s\S]*?\n\s*\);/)?.[0];
      expect(rollback).toBeDefined();
      expect((await client.query(rollback!)).rowCount).toBe(2);
      const restored = (await client.query('SELECT * FROM service_tokens ORDER BY name')).rows;
      for (const [index, row] of restored.entries()) {
        const expected =
          row.name === 'ci-reordered'
            ? { ...after[index], permissions: [...after[index].permissions, 'intent:read'] }
            : before[index];
        expect(row).toEqual(expected);
      }
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  });
});
