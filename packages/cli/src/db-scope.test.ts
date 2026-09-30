import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RuntimeConfig } from '@coredoc/core/types';

const config = {
  configDir: '/ws',
  projects: [
    { id: 'acme', name: 'Acme', repos: [] },
    { id: 'demo', name: 'Demo', repos: [] },
  ],
} as RuntimeConfig;

const closeAllDrivers = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@coredoc/db', () => ({ closeAllDrivers }));

beforeEach(() => {
  vi.resetModules();
  closeAllDrivers.mockClear();
  delete process.env.COREDOC_SQLITE_URL;
  delete process.env.COREDOC_LADYBUG_PATH;
});

afterEach(() => {
  delete process.env.COREDOC_SQLITE_URL;
  delete process.env.COREDOC_LADYBUG_PATH;
});

describe('bindProjectDatabase', () => {
  it('derives the database from configDir and project id', async () => {
    const { bindProjectDatabase } = await import('./db-scope.js');
    await bindProjectDatabase(config, 'acme');
    expect(process.env.COREDOC_SQLITE_URL).toBe('file:/ws/coredoc.db.d/acme.db');
    expect(process.env.COREDOC_LADYBUG_PATH).toBe('/ws/coredoc.db.d/acme.lbdb');
  });

  it('overrides an ambient URL instead of collapsing projects into one file', async () => {
    process.env.COREDOC_SQLITE_URL = 'file:/tmp/shared.db';
    process.env.COREDOC_LADYBUG_PATH = '/tmp/shared.lbdb';
    const { bindProjectDatabase } = await import('./db-scope.js');
    await bindProjectDatabase(config, 'acme');
    expect(process.env.COREDOC_SQLITE_URL).toBe('file:/ws/coredoc.db.d/acme.db');
    expect(process.env.COREDOC_LADYBUG_PATH).toBe('/ws/coredoc.db.d/acme.lbdb');
    expect(closeAllDrivers).toHaveBeenCalledOnce();
  });

  it('closes the prior singleton before changing projects', async () => {
    const { bindProjectDatabase } = await import('./db-scope.js');
    await bindProjectDatabase(config, 'acme');
    await bindProjectDatabase(config, 'demo');
    expect(process.env.COREDOC_SQLITE_URL).toBe('file:/ws/coredoc.db.d/demo.db');
    expect(process.env.COREDOC_LADYBUG_PATH).toBe('/ws/coredoc.db.d/demo.lbdb');
    expect(closeAllDrivers).toHaveBeenCalledOnce();
  });

  it('is a no-op for the same intact binding', async () => {
    const { bindProjectDatabase } = await import('./db-scope.js');
    await bindProjectDatabase(config, 'acme');
    await bindProjectDatabase(config, 'acme');
    expect(closeAllDrivers).not.toHaveBeenCalled();
  });

  it('repairs a changed Ladybug path even when the SQLite binding is intact', async () => {
    const { bindProjectDatabase } = await import('./db-scope.js');
    await bindProjectDatabase(config, 'acme');
    process.env.COREDOC_LADYBUG_PATH = '/tmp/wrong.lbdb';

    await bindProjectDatabase(config, 'acme');

    expect(closeAllDrivers).toHaveBeenCalledOnce();
    expect(process.env.COREDOC_LADYBUG_PATH).toBe('/ws/coredoc.db.d/acme.lbdb');
  });

  it('rejects unknown and duplicated project ids', async () => {
    const { bindProjectDatabase } = await import('./db-scope.js');
    await expect(bindProjectDatabase(config, 'missing')).rejects.toThrow(/not found/);

    const duplicated = {
      ...config,
      projects: [...config.projects, { id: 'acme', name: 'Duplicate', repos: [] }],
    } as RuntimeConfig;
    await expect(bindProjectDatabase(duplicated, 'acme')).rejects.toThrow(/duplicated/);
  });
});

describe('CI boundary', () => {
  function reachableFromCiRun(): string[] {
    const seen = new Set<string>();
    const queue = [join(__dirname, 'ci', 'run.ts')];

    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);

      const source = readFileSync(file, 'utf-8');
      const importPattern = /(?:from\s+|import\s*\(\s*)['"](\.[^'"]*)['"]/g;
      for (const match of source.matchAll(importPattern)) {
        const resolved = join(dirname(file), match[1]!.replace(/\.js$/, '.ts'));
        if (existsSync(resolved)) queue.push(resolved);
      }
    }
    return [...seen];
  }

  it('ci run cannot reach a local graph database', () => {
    const openers = /\b(getDriver|getRepository|getOperationsRepository|bindProjectDatabase)\s*\(/;
    const offenders = reachableFromCiRun().filter((file) => openers.test(readFileSync(file, 'utf-8')));
    expect(offenders).toEqual([]);
  });
});
