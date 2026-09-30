import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const DATABASE_URL = process.env.PHASE_C_MIGRATION_TEST_DATABASE_URL;
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe.skipIf(!DATABASE_URL)('Phase-C delivery migration backfill (PostgreSQL)', () => {
  it('backfills only one exact provider ref and leaves zero/multiple matches unresolved', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [resolve(SERVER_ROOT, 'scripts/test-delivery-phase-c-migration.mjs')],
      {
        cwd: SERVER_ROOT,
        env: { ...process.env, PHASE_C_MIGRATION_TEST_DATABASE_URL: DATABASE_URL },
      },
    );
    const result = JSON.parse(stdout) as Record<string, unknown>;
    expect(result).toEqual({
      coredoc: null,
      exact: result.expectedExact,
      expectedExact: result.expectedExact,
      zero: null,
      multiple: null,
      unresolved: 2,
    });
    expect(result.expectedExact).toMatch(/^[0-9]+$/);
  });
});
