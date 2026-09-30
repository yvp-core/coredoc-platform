import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { loadConfig } from './load-config.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'load-config-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(dir: string): string {
  const configPath = join(dir, 'coredoc.config.json');
  mkdirSync(join(dir, 'svc-a'), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      version: '2.0',
      projects: [{ id: 'alpha', name: 'Alpha', repos: [{ name: 'svc-a', path: './svc-a', type: 'backend' }] }],
      output: { dir: './out', format: 'json' },
      parserStorage: './parsers',
      agentMode: 'interactive',
    }),
    'utf-8',
  );
  return configPath;
}

describe('loadConfig', () => {
  it('throws when the config file is missing', () => {
    expect(() => loadConfig(join(tmp, 'nope.json'))).toThrow(/Config file not found/);
  });

  it('resolves a relative config path against cwd', () => {
    writeConfig(tmp);
    // process.chdir() is unavailable under vitest workers.
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(tmp);
    try {
      expect(loadConfig('coredoc.config.json').configPath).toBe(resolve(tmp, 'coredoc.config.json'));
    } finally {
      cwd.mockRestore();
    }
  });

  it('fires onMigrated once when the migration runs, and never with skipMigration', () => {
    const configPath = writeConfig(tmp);
    // Old flat layout the migration moves into parsers/alpha/svc-a.
    mkdirSync(join(tmp, 'parsers', 'svc-a'), { recursive: true });

    const skipped: unknown[] = [];
    loadConfig(configPath, { skipMigration: true, onMigrated: (r) => skipped.push(r) });
    expect(skipped).toHaveLength(0);

    const migrated: Array<{ parserDirsMoved: number }> = [];
    loadConfig(configPath, { onMigrated: (r) => migrated.push(r) });
    expect(migrated).toHaveLength(1);
    expect(migrated[0]!.parserDirsMoved).toBe(1);
  });

  it('reports migration errors through onMigrationWarning', () => {
    const configPath = writeConfig(tmp);
    mkdirSync(join(tmp, 'parsers', 'svc-a'), { recursive: true });
    // A FILE where the project directory must be created → the move fails and
    // the migration records a non-fatal error instead of throwing.
    writeFileSync(join(tmp, 'parsers', 'alpha'), 'not a directory', 'utf-8');

    const warnings: string[] = [];
    loadConfig(configPath, { onMigrationWarning: (m) => warnings.push(m) });

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('svc-a');
  });
});
