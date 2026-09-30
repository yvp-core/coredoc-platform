import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionProfile } from '../types.js';
import { UNRESOLVED_PREFIX } from '../unresolved-sentinel.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/**
 * TS raw-SQL-over-a-pool db-ops (posthog G9): `postgres.query(PostgresUse.X, sql, params)` /
 * `this.deps.postgres.query(...)`. The SQL sits in an arg that is a plain literal, a template
 * literal, or an identifier bound elsewhere — the last of which used to drop the whole op
 * silently. With `emitUnresolved` the site is emitted with an unresolved-sentinel entityName,
 * so a raw-SQL surface is visible even where its target is not statically knowable.
 */
const PROFILE: ExtractionProfile = {
  parserId: 'test-raw-sql-pool',
  substrate: { language: 'ts', include: ['**/*.ts'], exclude: ['**/node_modules/**'] },
  dbOperations: {
    rawQueries: [
      {
        dialect: 'sql',
        methods: ['query'],
        receivers: ['(^|\\.)postgres$'],
        queryArg: 1,
        emitUnresolved: true,
      },
    ],
  },
};

const SOURCE = [
  'export enum PostgresUse {',
  '  COMMON_READ = 0,',
  '}',
  'type Pool = { query: (use: PostgresUse, sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };',
  '',
  'export class Consumer {',
  '  constructor(private deps: { postgres: Pool }) {}',
  '',
  '  async loadConfigs(teamIds: number[]): Promise<unknown[]> {',
  '    const { rows } = await this.deps.postgres.query(',
  '      PostgresUse.COMMON_READ,',
  '      `SELECT id, team_id',
  '       FROM posthog_pluginconfig',
  '       WHERE team_id = ANY($1)`,',
  '      [teamIds],',
  '    );',
  '    return rows;',
  '  }',
  '',
  '  async purge(id: number): Promise<void> {',
  "    await this.deps.postgres.query(PostgresUse.COMMON_READ, 'DELETE FROM auth.sessions WHERE id = $1', [id]);",
  '  }',
  '',
  '  async run(sql: string): Promise<void> {',
  '    await this.deps.postgres.query(PostgresUse.COMMON_READ, sql, []);',
  '  }',
  '}',
  '',
].join('\n');

describe('runProfile — raw SQL over a pool receiver', () => {
  it('reads literal, template and unresolvable SQL args from a receiver-based query call', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-rawsql-'));
    writeFileSync(join(dir, 'consumer.ts'), SOURCE);

    const { repo } = await runProfile(PROFILE, dir, 'svc', 'svc');
    const ops = repo.dbOperations.filter((o) => o.location.filePath === 'consumer.ts');

    // Template literal: verb + table are statically visible despite the `$1` placeholders.
    const read = ops.find((o) => o.operation === 'read');
    expect(read?.entityName).toBe('posthog_pluginconfig');

    // Plain literal with a schema-qualified target — the schema must not swallow the table.
    const del = ops.find((o) => o.operation === 'delete');
    expect(del?.entityName).toBe('auth.sessions');

    // Identifier arg: no readable SQL, but the site is a real db-op surface → emitted marked.
    const unresolved = ops.filter((o) => o.entityName.startsWith(UNRESOLVED_PREFIX));
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].operation).toBe('query');
    expect(unresolved[0].entityId).toBeUndefined();

    expect(ops).toHaveLength(3);
  });

  it('keeps dropping unreadable SQL when the matcher does not opt into unresolved emission', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-rawsql-'));
    writeFileSync(join(dir, 'consumer.ts'), SOURCE);

    const quiet: ExtractionProfile = {
      ...PROFILE,
      dbOperations: {
        rawQueries: [{ dialect: 'sql', methods: ['query'], receivers: ['(^|\\.)postgres$'], queryArg: 1 }],
      },
    };
    const { repo } = await runProfile(quiet, dir, 'svc', 'svc');
    const ops = repo.dbOperations.filter((o) => o.location.filePath === 'consumer.ts');
    expect(ops.map((o) => o.entityName).sort()).toEqual(['auth.sessions', 'posthog_pluginconfig']);
  });

  /**
   * The second dialect of the same primitive: a tagged-template SQL builder (supabase's
   * `safeSql`). Both parseSqlOp upgrades reach it through the existing rule shape — the
   * schema-qualified target no longer collapses to the schema, and the DDL builders that
   * were dropped wholesale now land as `ddl`.
   */
  it('reads schema-qualified and DDL statements from a tagged-template SQL builder', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-rawsql-'));
    writeFileSync(
      join(dir, 'sql.ts'),
      [
        'declare function safeSql(s: TemplateStringsArray, ...v: unknown[]): string;',
        'export function listUsers(id: string): string {',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: this fixture line IS source code carrying a template placeholder.
        '  return safeSql`SELECT * FROM auth.users WHERE id = ${id}`;',
        '}',
        'export function dropListings(): string {',
        '  return safeSql`DROP TABLE IF EXISTS listings`;',
        '}',
        '',
      ].join('\n'),
    );

    const tagged: ExtractionProfile = {
      ...PROFILE,
      dbOperations: { rawQueries: [{ dialect: 'sql', methods: ['safeSql'] }] },
    };
    const { repo } = await runProfile(tagged, dir, 'svc', 'svc');
    expect(repo.dbOperations.map((o) => [o.operation, o.entityName])).toEqual([
      ['read', 'auth.users'],
      ['ddl', 'listings'],
    ]);
  });
});
