import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectIntentMode } from '@coredoc/core';
import { writeProjectCloud, writeProjectIntent } from './config-writer.js';

describe('writeProjectCloud', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sync-config-'));
    configPath = join(dir, 'coredoc.config.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the cloud field for the matching project, leaves others untouched', () => {
    const config = {
      version: '2.0',
      projects: [
        { id: 'a', name: 'A', repos: [] },
        { id: 'b', name: 'B', repos: [], cloud: { enabled: true, workspaceId: 'ws_b' } },
      ],
      output: { dir: './out' },
      parserStorage: './parsers',
      agentMode: 'auto',
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

    writeProjectCloud(configPath, 'a', { enabled: true, workspaceId: 'ws_a_new' });

    const after = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(after.projects[0].cloud).toEqual({ enabled: true, workspaceId: 'ws_a_new' });
    expect(after.projects[1].cloud).toEqual({ enabled: true, workspaceId: 'ws_b' });
  });

  it('throws when the project id is not found', () => {
    const config = {
      version: '2.0',
      projects: [{ id: 'a', name: 'A', repos: [] }],
      output: { dir: './out' },
      parserStorage: './parsers',
      agentMode: 'auto',
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    expect(() => writeProjectCloud(configPath, 'missing', { enabled: true })).toThrow(/not found/);
  });

  it('merges into existing cloud object (preserves lastSyncedAt)', () => {
    const config = {
      version: '2.0',
      projects: [
        {
          id: 'a',
          name: 'A',
          repos: [],
          cloud: { enabled: true, workspaceId: 'ws_a', lastSyncedAt: '2026-01-01T00:00:00Z' },
        },
      ],
      output: { dir: './out' },
      parserStorage: './parsers',
      agentMode: 'auto',
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    writeProjectCloud(configPath, 'a', { lastSyncedAt: '2026-05-23T10:00:00Z' });
    const after = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(after.projects[0].cloud).toEqual({
      enabled: true,
      workspaceId: 'ws_a',
      lastSyncedAt: '2026-05-23T10:00:00Z',
    });
  });
});

describe('writeProjectIntent', () => {
  let dir: string;
  let configPath: string;

  function seed(projects: unknown[]): void {
    writeFileSync(
      configPath,
      `${JSON.stringify(
        { version: '2.0', projects, output: { dir: './out' }, parserStorage: './parsers', agentMode: 'auto' },
        null,
        2,
      )}\n`,
    );
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sync-config-intent-'));
    configPath = join(dir, 'coredoc.config.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the cutover marker for the named project only', () => {
    seed([
      { id: 'a', name: 'A', repos: [] },
      { id: 'b', name: 'B', repos: [] },
    ]);
    writeProjectIntent(configPath, 'a', { mode: ProjectIntentMode.Cloud, workspaceId: 'ws_a' });
    const after = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(after.projects[0].intent).toEqual({ mode: 'cloud', workspaceId: 'ws_a' });
    expect(after.projects[1].intent).toBeUndefined();
  });

  it('REPLACES an existing marker rather than merging two workspaces into one', () => {
    seed([{ id: 'a', name: 'A', repos: [], intent: { mode: 'cloud', workspaceId: 'ws_old', stray: 'field' } }]);
    writeProjectIntent(configPath, 'a', { mode: ProjectIntentMode.Cloud, workspaceId: 'ws_new' });
    const after = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(after.projects[0].intent).toEqual({ mode: 'cloud', workspaceId: 'ws_new' });
  });

  it('leaves the rest of the config, including project.cloud, untouched', () => {
    seed([{ id: 'a', name: 'A', repos: [{ name: 'r', path: './r' }], cloud: { enabled: true, workspaceId: 'ws_a' } }]);
    writeProjectIntent(configPath, 'a', { mode: ProjectIntentMode.Cloud, workspaceId: 'ws_a' });
    const after = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(after.projects[0].cloud).toEqual({ enabled: true, workspaceId: 'ws_a' });
    expect(after.projects[0].repos).toEqual([{ name: 'r', path: './r' }]);
    expect(after.parserStorage).toBe('./parsers');
  });

  it('throws on an unknown project rather than silently adding one', () => {
    seed([{ id: 'a', name: 'A', repos: [] }]);
    expect(() =>
      writeProjectIntent(configPath, 'missing', { mode: ProjectIntentMode.Cloud, workspaceId: 'ws_a' }),
    ).toThrow(/not found/);
  });
});

// =============================================================================
// Atomic replacement
// =============================================================================
//
// `coredoc.config.json` names every project, every repo, and who owns product
// intent. A truncate-then-write leaves it half-written if the process dies mid
// write; `rename(2)` inside one directory does not.

describe('atomic config replacement', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sync-config-atomic-'));
    configPath = join(dir, 'coredoc.config.json');
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: '2.0',
          projects: [{ id: 'a', name: 'A', repos: [] }],
          output: { dir: './out' },
          parserStorage: './parsers',
          agentMode: 'auto',
        },
        null,
        2,
      )}\n`,
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves no temp file behind on success', () => {
    writeProjectIntent(configPath, 'a', { mode: ProjectIntentMode.Cloud, workspaceId: 'ws_a' });
    writeProjectCloud(configPath, 'a', { enabled: true, workspaceId: 'ws_a' });
    expect(readdirSync(dir)).toEqual(['coredoc.config.json']);
  });

  it('preserves the file mode of the config it replaces', () => {
    chmodSync(configPath, 0o600);
    writeProjectIntent(configPath, 'a', { mode: ProjectIntentMode.Cloud, workspaceId: 'ws_a' });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('replaces the file by rename, so a reader never sees a truncated config', () => {
    // The inode changes: proof the original was never opened for truncation.
    const before = statSync(configPath).ino;
    writeProjectIntent(configPath, 'a', { mode: ProjectIntentMode.Cloud, workspaceId: 'ws_a' });
    expect(statSync(configPath).ino).not.toBe(before);
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).projects[0].intent).toEqual({
      mode: 'cloud',
      workspaceId: 'ws_a',
    });
  });

  it('leaves the original config intact when the replacement cannot be written', () => {
    // A read-only directory is the realistic version of "the write failed":
    // the temp file never lands, so neither does a truncated config.
    chmodSync(dir, 0o500);
    try {
      expect(() =>
        writeProjectIntent(configPath, 'a', { mode: ProjectIntentMode.Cloud, workspaceId: 'ws_a' }),
      ).toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readdirSync(dir)).toEqual(['coredoc.config.json']);
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).projects[0].intent).toBeUndefined();
  });
});
