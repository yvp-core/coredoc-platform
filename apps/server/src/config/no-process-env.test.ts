import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The structural gate for configuration: production code under `src/` does not
 * touch `process.env`. Every variable is declared once in `src/config/`, gets
 * its default there, and reaches its reader as a typed value — injected for a
 * provider, a default argument for the module-definition-time and per-request
 * readers that exist before or outside DI.
 *
 * Fix a failure by adding the variable to the schema in `config/app-config.ts`
 * and taking the group at the call site — never by widening this list.
 *
 * Tests are exempt: 60-odd of them set env inline, `loadAppConfig` runs only at
 * bootstrap, and that is exactly why the migration needed no change to how they
 * do it. `src/generated/` is Prisma's output and is not ours to edit.
 */
const SRC = fileURLToPath(new URL('..', import.meta.url));
const ALLOWED_DIRECTORIES = ['config', 'generated'];

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.name.endsWith('.ts') || entry.name.endsWith('.mts') ? [full] : [];
  });
}

function isProductionFile(relativePath: string): boolean {
  const segments = relativePath.split(sep);
  if (ALLOWED_DIRECTORIES.includes(segments[0])) return false;
  const name = segments.at(-1) ?? '';
  return !name.includes('.test.') && !name.includes('.test-support.');
}

describe('configuration is read in exactly one place', () => {
  it('finds no process.env outside src/config/', () => {
    const offenders = tsFiles(SRC)
      .map((file) => relative(SRC, file))
      .filter(isProductionFile)
      .filter((file) => readFileSync(join(SRC, file), 'utf8').includes('process.env'));

    expect(offenders).toEqual([]);
  });

  it('checks a meaningful number of files (the walk itself is not silently empty)', () => {
    const production = tsFiles(SRC)
      .map((file) => relative(SRC, file))
      .filter(isProductionFile);
    expect(production.length).toBeGreaterThan(100);
  });
});
