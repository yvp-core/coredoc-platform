import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ IpcMain: class {} }));

import {
  getCurrentConfig,
  getCurrentConfigPath,
  listReservedProjectIds,
  loadConfig,
  removeRepository,
} from './config-manager';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('listReservedProjectIds', () => {
  it('reserves only ids with retained project database files', () => {
    const root = mkdtempSync(join(tmpdir(), 'coredoc-config-db-'));
    roots.push(root);
    const dbDir = join(root, 'coredoc.db.d');
    mkdirSync(dbDir);
    writeFileSync(join(dbDir, 'alpha.db'), '');
    writeFileSync(join(dbDir, 'alpha.db-wal'), '');
    writeFileSync(join(dbDir, 'notes.txt'), '');

    expect(listReservedProjectIds(join(root, 'coredoc.config.json'))).toEqual(['alpha']);
  });

  it('returns no reservations before the first project push', () => {
    const root = mkdtempSync(join(tmpdir(), 'coredoc-config-db-'));
    roots.push(root);

    expect(listReservedProjectIds(join(root, 'coredoc.config.json'))).toEqual([]);
  });
});

describe('loadConfig project database ownership', () => {
  it('rejects duplicate project ids before desktop code can open their shared file', () => {
    const root = mkdtempSync(join(tmpdir(), 'coredoc-config-db-'));
    roots.push(root);
    const configPath = join(root, 'coredoc.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        version: '2.0',
        projects: [
          { id: 'duplicate', name: 'First', repos: [] },
          { id: 'duplicate', name: 'Second', repos: [] },
        ],
        parserStorage: 'parsers',
        output: { dir: 'coredoc-output', format: 'json' },
      }),
    );

    expect(loadConfig(configPath)).toEqual({
      success: false,
      error: 'Project id "duplicate" is duplicated in the config; each project must own a unique database.',
    });
  });

  it('keeps the previous config when reservation discovery fails for a second workspace', () => {
    const rootA = mkdtempSync(join(tmpdir(), 'coredoc-config-a-'));
    const rootB = mkdtempSync(join(tmpdir(), 'coredoc-config-b-'));
    roots.push(rootA, rootB);

    const configAPath = join(rootA, 'coredoc.config.json');
    const configA = {
      version: '2.0',
      projects: [{ id: 'project-a', name: 'Project A', repos: [] }],
      parserStorage: 'parsers',
      output: { dir: 'coredoc-output', format: 'json' },
    };
    writeFileSync(configAPath, JSON.stringify(configA));
    expect(loadConfig(configAPath).success).toBe(true);

    const configBPath = join(rootB, 'coredoc.config.json');
    writeFileSync(
      configBPath,
      JSON.stringify({
        ...configA,
        projects: [{ id: 'project-b', name: 'Project B', repos: [] }],
      }),
    );
    // An invalid retained-database path makes reservation discovery fail after
    // the JSON itself has loaded successfully.
    writeFileSync(join(rootB, 'coredoc.db.d'), 'not a directory');

    expect(loadConfig(configBPath).success).toBe(false);
    expect(getCurrentConfigPath()).toBe(configAPath);
    expect(getCurrentConfig()).toEqual(configA);
  });
});

describe('removeRepository parser cleanup', () => {
  it('removes the compiled parser cache together with the canonical source artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'coredoc-config-remove-'));
    roots.push(root);
    const configPath = join(root, 'coredoc.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        version: '2.0',
        projects: [
          {
            id: 'project-a',
            name: 'Project A',
            repos: [{ name: 'repo-a', path: './repo-a', type: 'backend' }],
          },
        ],
        parserStorage: 'coredoc-parsers',
        output: { dir: 'coredoc-output', format: 'json' },
      }),
    );
    expect(loadConfig(configPath).success).toBe(true);

    const sourceDir = join(root, 'coredoc-parsers', 'project-a', 'repo-a');
    const compiledDir = join(root, 'dist', 'coredoc-parsers', 'project-a', 'repo-a');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(compiledDir, { recursive: true });
    writeFileSync(join(sourceDir, 'profile.ts'), 'export default {};');
    writeFileSync(join(compiledDir, 'profile.mjs'), 'export default {};');

    expect(removeRepository('project-a', 'repo-a')).toEqual({ success: true });
    expect(existsSync(sourceDir)).toBe(false);
    expect(existsSync(compiledDir)).toBe(false);
  });
});
