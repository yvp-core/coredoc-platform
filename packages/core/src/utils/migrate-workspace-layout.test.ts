import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { migrateWorkspaceLayout, LAYOUT_VERSION_FILE, CURRENT_LAYOUT_VERSION } from './migrate-workspace-layout.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'coredoc-migrate-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(config: unknown): string {
  const configPath = join(tmp, 'coredoc.config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  return configPath;
}

function touch(path: string, content = '{}'): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

describe('migrateWorkspaceLayout', () => {
  it('backfills missing project ids', () => {
    const configPath = writeConfig({
      version: '2.0',
      projects: [
        { name: 'My Project', repos: [] },
        { name: 'Other', repos: [] },
      ],
      output: { dir: './coredoc-output', format: 'json' },
      parserStorage: './coredoc-parsers',
      agentMode: 'interactive',
    });

    const result = migrateWorkspaceLayout(configPath);

    expect(result.idsAssigned).toBe(2);
    const updated = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(updated.projects[0].id).toBe('my-project');
    expect(updated.projects[1].id).toBe('other');
  });

  it('deduplicates colliding ids during backfill', () => {
    const configPath = writeConfig({
      version: '2.0',
      projects: [
        { name: 'Test', repos: [] },
        { name: 'test', repos: [] },
      ],
      output: { dir: './out', format: 'json' },
      parserStorage: './parsers',
      agentMode: 'interactive',
    });

    migrateWorkspaceLayout(configPath);

    const updated = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(updated.projects[0].id).toBe('test');
    expect(updated.projects[1].id).toBe('test-2');
  });

  it('moves a flat parser folder into the project subfolder', () => {
    const configPath = writeConfig({
      version: '2.0',
      projects: [{ id: 'alpha', name: 'Alpha', repos: [{ name: 'svc-a', path: './svc-a' }] }],
      output: { dir: './out', format: 'json' },
      parserStorage: './parsers',
      agentMode: 'interactive',
    });
    touch(join(tmp, 'parsers', 'svc-a', 'parser.ts'), '// parser');
    touch(join(tmp, 'parsers', 'svc-a', 'metadata.json'), '{}');

    const result = migrateWorkspaceLayout(configPath);

    expect(existsSync(join(tmp, 'parsers', 'alpha', 'svc-a', 'parser.ts'))).toBe(true);
    expect(existsSync(join(tmp, 'parsers', 'svc-a'))).toBe(false);
    expect(result.parserDirsMoved).toBe(1);
  });

  it('moves output artifacts into the project subfolder', () => {
    const configPath = writeConfig({
      version: '2.0',
      projects: [{ id: 'alpha', name: 'Alpha', repos: [{ name: 'svc-a', path: './svc-a' }] }],
      output: { dir: './out', format: 'json' },
      parserStorage: './parsers',
      agentMode: 'interactive',
    });
    touch(join(tmp, 'out', 'svc-a.json'), '{}');
    touch(join(tmp, 'out', 'svc-a-summaries.json'), '{}');
    touch(join(tmp, 'out', 'svc-a-embeddings.json'), '[]');
    mkdirSync(join(tmp, 'out', 'svc-a-docs'), { recursive: true });
    writeFileSync(join(tmp, 'out', 'svc-a-docs', 'README.md'), '# docs', 'utf-8');

    const result = migrateWorkspaceLayout(configPath);

    expect(existsSync(join(tmp, 'out', 'alpha', 'svc-a.json'))).toBe(true);
    expect(existsSync(join(tmp, 'out', 'alpha', 'svc-a-summaries.json'))).toBe(true);
    expect(existsSync(join(tmp, 'out', 'alpha', 'svc-a-embeddings.json'))).toBe(true);
    expect(existsSync(join(tmp, 'out', 'alpha', 'svc-a-docs', 'README.md'))).toBe(true);
    expect(existsSync(join(tmp, 'out', 'svc-a.json'))).toBe(false);
    expect(result.outputArtifactsMoved).toBe(4);
  });

  it('deletes orphaned parser folders not referenced by any project', () => {
    const configPath = writeConfig({
      version: '2.0',
      projects: [{ id: 'alpha', name: 'Alpha', repos: [] }],
      output: { dir: './out', format: 'json' },
      parserStorage: './parsers',
      agentMode: 'interactive',
    });
    touch(join(tmp, 'parsers', 'orphan-repo', 'parser.ts'), '// orphan');

    const result = migrateWorkspaceLayout(configPath);

    expect(existsSync(join(tmp, 'parsers', 'orphan-repo'))).toBe(false);
    expect(result.orphansDeleted).toBe(1);
  });

  it('writes the layout-version sentinel after success', () => {
    const configPath = writeConfig({
      version: '2.0',
      projects: [],
      output: { dir: './out', format: 'json' },
      parserStorage: './parsers',
      agentMode: 'interactive',
    });

    migrateWorkspaceLayout(configPath);

    expect(existsSync(join(tmp, 'parsers', LAYOUT_VERSION_FILE))).toBe(true);
    expect(readFileSync(join(tmp, 'parsers', LAYOUT_VERSION_FILE), 'utf-8')).toBe(CURRENT_LAYOUT_VERSION);
  });

  it('is idempotent — second run is a no-op when sentinel present', () => {
    const configPath = writeConfig({
      version: '2.0',
      projects: [{ id: 'alpha', name: 'Alpha', repos: [{ name: 'svc-a', path: './svc-a' }] }],
      output: { dir: './out', format: 'json' },
      parserStorage: './parsers',
      agentMode: 'interactive',
    });
    mkdirSync(join(tmp, 'parsers'), { recursive: true });
    writeFileSync(join(tmp, 'parsers', LAYOUT_VERSION_FILE), CURRENT_LAYOUT_VERSION, 'utf-8');
    touch(join(tmp, 'parsers', 'svc-a', 'parser.ts'), '// stale flat layout');

    const result = migrateWorkspaceLayout(configPath);

    expect(result.skipped).toBe(true);
    expect(result.parserDirsMoved).toBe(0);
    // Sentinel should still be present; old files left untouched.
    expect(existsSync(join(tmp, 'parsers', 'svc-a', 'parser.ts'))).toBe(true);
  });

  it('skips when sentinel is at a newer version than current', () => {
    const configPath = writeConfig({
      version: '2.0',
      projects: [{ id: 'alpha', name: 'Alpha', repos: [{ name: 'svc-a', path: './svc-a' }] }],
      output: { dir: './out', format: 'json' },
      parserStorage: './parsers',
      agentMode: 'interactive',
    });
    mkdirSync(join(tmp, 'parsers'), { recursive: true });
    writeFileSync(join(tmp, 'parsers', LAYOUT_VERSION_FILE), '99', 'utf-8');
    touch(join(tmp, 'parsers', 'svc-a', 'parser.ts'), '// stale flat layout');

    const result = migrateWorkspaceLayout(configPath);

    expect(result.skipped).toBe(true);
    expect(result.parserDirsMoved).toBe(0);
    // Sentinel untouched
    expect(readFileSync(join(tmp, 'parsers', LAYOUT_VERSION_FILE), 'utf-8')).toBe('99');
    // Flat layout untouched
    expect(existsSync(join(tmp, 'parsers', 'svc-a', 'parser.ts'))).toBe(true);
  });

  it('does not treat already-nested directories as old layout', () => {
    const configPath = writeConfig({
      version: '2.0',
      projects: [{ id: 'alpha', name: 'Alpha', repos: [{ name: 'svc-a', path: './svc-a' }] }],
      output: { dir: './out', format: 'json' },
      parserStorage: './parsers',
      agentMode: 'interactive',
    });
    touch(join(tmp, 'parsers', 'alpha', 'svc-a', 'parser.ts'), '// already migrated');

    const result = migrateWorkspaceLayout(configPath);

    expect(result.parserDirsMoved).toBe(0);
    expect(existsSync(join(tmp, 'parsers', 'alpha', 'svc-a', 'parser.ts'))).toBe(true);
  });

  it('withholds the sentinel on partial failure and retries successfully', () => {
    const configPath = writeConfig({
      version: '2.0',
      projects: [{ id: 'alpha', name: 'Alpha', repos: [{ name: 'svc-a', path: './svc-a' }] }],
      output: { dir: './out', format: 'json' },
      parserStorage: './parsers',
      agentMode: 'interactive',
    });
    // Create a regular file at the path where the project subfolder should go.
    // This makes `mkdirSync(parsers/alpha, { recursive: true })` fail because
    // `parsers/alpha` already exists as a file, not a directory.
    mkdirSync(join(tmp, 'parsers'), { recursive: true });
    writeFileSync(join(tmp, 'parsers', 'alpha'), 'not a directory', 'utf-8');
    touch(join(tmp, 'parsers', 'svc-a', 'parser.ts'), '// parser');

    const firstRun = migrateWorkspaceLayout(configPath);
    expect(firstRun.errors.length).toBeGreaterThan(0);
    expect(existsSync(join(tmp, 'parsers', LAYOUT_VERSION_FILE))).toBe(false);

    // Fix the blocker and rerun
    rmSync(join(tmp, 'parsers', 'alpha'));
    const secondRun = migrateWorkspaceLayout(configPath);
    expect(secondRun.errors).toEqual([]);
    expect(existsSync(join(tmp, 'parsers', LAYOUT_VERSION_FILE))).toBe(true);
    expect(existsSync(join(tmp, 'parsers', 'alpha', 'svc-a', 'parser.ts'))).toBe(true);
  });

  it('converts standalone repos into a synthesized Legacy project', () => {
    const configPath = writeConfig({
      version: '2.0',
      projects: [{ id: 'alpha', name: 'Alpha', repos: [] }],
      repos: [
        { name: 'svc-x', path: './svc-x' },
        { name: 'svc-y', path: './svc-y' },
      ],
      output: { dir: './out', format: 'json' },
      parserStorage: './parsers',
      agentMode: 'interactive',
    });

    const result = migrateWorkspaceLayout(configPath);

    expect(result.standaloneReposConverted).toBe(2);

    const updated = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(updated.repos).toBeUndefined();
    expect(updated.projects).toHaveLength(2);
    const legacy = updated.projects.find((p: { id: string }) => p.id === 'legacy');
    expect(legacy).toBeDefined();
    expect(legacy.name).toBe('Legacy');
    expect(legacy.repos).toEqual([
      { name: 'svc-x', path: './svc-x' },
      { name: 'svc-y', path: './svc-y' },
    ]);
  });

  it('drops an empty root-level repos array', () => {
    const configPath = writeConfig({
      version: '2.0',
      projects: [{ id: 'alpha', name: 'Alpha', repos: [{ name: 'svc-a', path: './svc-a' }] }],
      repos: [],
      output: { dir: './out', format: 'json' },
      parserStorage: './parsers',
      agentMode: 'interactive',
    });

    const result = migrateWorkspaceLayout(configPath);

    expect(result.standaloneReposConverted).toBe(0);
    const updated = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(updated.repos).toBeUndefined();
    expect(updated.projects).toHaveLength(1);
  });

  it('moves parser/output files for standalone repos into the legacy project', () => {
    const configPath = writeConfig({
      version: '2.0',
      projects: [],
      repos: [{ name: 'lonely', path: './lonely' }],
      output: { dir: './out', format: 'json' },
      parserStorage: './parsers',
      agentMode: 'interactive',
    });
    touch(join(tmp, 'parsers', 'lonely', 'parser.ts'), '// parser');
    touch(join(tmp, 'out', 'lonely.json'), '{}');

    const result = migrateWorkspaceLayout(configPath);

    expect(result.standaloneReposConverted).toBe(1);
    expect(result.parserDirsMoved).toBe(1);
    expect(result.outputArtifactsMoved).toBe(1);
    expect(existsSync(join(tmp, 'parsers', 'legacy', 'lonely', 'parser.ts'))).toBe(true);
    expect(existsSync(join(tmp, 'out', 'legacy', 'lonely.json'))).toBe(true);
    expect(existsSync(join(tmp, 'parsers', 'lonely'))).toBe(false);
    expect(existsSync(join(tmp, 'out', 'lonely.json'))).toBe(false);
  });

  it('disambiguates the legacy id when "legacy" is already taken', () => {
    const configPath = writeConfig({
      version: '2.0',
      projects: [{ id: 'legacy', name: 'My Legacy Project', repos: [] }],
      repos: [{ name: 'svc-z', path: './svc-z' }],
      output: { dir: './out', format: 'json' },
      parserStorage: './parsers',
      agentMode: 'interactive',
    });

    migrateWorkspaceLayout(configPath);

    const updated = JSON.parse(readFileSync(configPath, 'utf-8'));
    const legacy2 = updated.projects.find((p: { id: string }) => p.id === 'legacy-2');
    expect(legacy2).toBeDefined();
    expect(legacy2.repos).toEqual([{ name: 'svc-z', path: './svc-z' }]);
  });

  it('reruns when an install is at sentinel v2 (the pre-Phase-A version)', () => {
    const configPath = writeConfig({
      version: '2.0',
      projects: [{ id: 'alpha', name: 'Alpha', repos: [] }],
      repos: [{ name: 'svc-x', path: './svc-x' }],
      output: { dir: './out', format: 'json' },
      parserStorage: './parsers',
      agentMode: 'interactive',
    });
    mkdirSync(join(tmp, 'parsers'), { recursive: true });
    writeFileSync(join(tmp, 'parsers', LAYOUT_VERSION_FILE), '2', 'utf-8');

    const result = migrateWorkspaceLayout(configPath);

    expect(result.skipped).toBe(false);
    expect(result.standaloneReposConverted).toBe(1);
    expect(readFileSync(join(tmp, 'parsers', LAYOUT_VERSION_FILE), 'utf-8')).toBe('4');
  });

  it('renames legacy session folders from display name to projectId', () => {
    const configPath = writeConfig({
      version: '2.0',
      projects: [{ id: 'alpha', name: 'Alpha', repos: [] }],
      output: { dir: './out', format: 'json' },
      parserStorage: './parsers',
      agentMode: 'interactive',
    });

    mkdirSync(join(tmp, 'coredoc-sessions', 'Alpha'), { recursive: true });
    writeFileSync(
      join(tmp, 'coredoc-sessions', 'Alpha', 'session-1.json'),
      JSON.stringify({ id: 'session-1', projectId: 'Alpha', messages: [] }),
      'utf-8',
    );

    const result = migrateWorkspaceLayout(configPath);

    expect(result.sessionDirsMigrated).toBe(1);
    expect(existsSync(join(tmp, 'coredoc-sessions', 'alpha', 'session-1.json'))).toBe(true);
    // Check actual on-disk name (existsSync is case-insensitive on macOS).
    const sessionEntries = readdirSync(join(tmp, 'coredoc-sessions'));
    expect(sessionEntries).toContain('alpha');
    expect(sessionEntries).not.toContain('Alpha');

    const migrated = JSON.parse(readFileSync(join(tmp, 'coredoc-sessions', 'alpha', 'session-1.json'), 'utf-8'));
    expect(migrated.projectId).toBe('alpha');
  });

  it('merges session files when the target projectId dir already exists', () => {
    // User renamed "Old Name" → project id "alpha" (via assignProjectId); some
    // sessions were written under the old display name dir, later ones under
    // the new projectId dir. The migration should merge both sources.
    const configPath = writeConfig({
      version: '2.0',
      projects: [{ id: 'alpha', name: 'Old Name', repos: [] }],
      output: { dir: './out', format: 'json' },
      parserStorage: './parsers',
      agentMode: 'interactive',
    });

    mkdirSync(join(tmp, 'coredoc-sessions', 'Old Name'), { recursive: true });
    writeFileSync(
      join(tmp, 'coredoc-sessions', 'Old Name', 'old.json'),
      JSON.stringify({ id: 'old', projectId: 'Old Name' }),
      'utf-8',
    );
    mkdirSync(join(tmp, 'coredoc-sessions', 'alpha'), { recursive: true });
    writeFileSync(
      join(tmp, 'coredoc-sessions', 'alpha', 'new.json'),
      JSON.stringify({ id: 'new', projectId: 'alpha' }),
      'utf-8',
    );

    const result = migrateWorkspaceLayout(configPath);

    expect(result.sessionDirsMigrated).toBe(1);
    expect(existsSync(join(tmp, 'coredoc-sessions', 'Old Name'))).toBe(false);
    expect(existsSync(join(tmp, 'coredoc-sessions', 'alpha', 'old.json'))).toBe(true);
    expect(existsSync(join(tmp, 'coredoc-sessions', 'alpha', 'new.json'))).toBe(true);
  });

  it('leaves orphan session folders alone', () => {
    const configPath = writeConfig({
      version: '2.0',
      projects: [{ id: 'alpha', name: 'Alpha', repos: [] }],
      output: { dir: './out', format: 'json' },
      parserStorage: './parsers',
      agentMode: 'interactive',
    });

    mkdirSync(join(tmp, 'coredoc-sessions', 'NotAProject'), { recursive: true });
    writeFileSync(
      join(tmp, 'coredoc-sessions', 'NotAProject', 'session.json'),
      JSON.stringify({ id: 'x', projectId: 'NotAProject' }),
      'utf-8',
    );

    const result = migrateWorkspaceLayout(configPath);

    expect(result.sessionDirsMigrated).toBe(0);
    expect(existsSync(join(tmp, 'coredoc-sessions', 'NotAProject', 'session.json'))).toBe(true);
  });

  it('reruns at sentinel v3 to pick up the session migration', () => {
    const configPath = writeConfig({
      version: '2.0',
      projects: [{ id: 'alpha', name: 'Alpha', repos: [] }],
      output: { dir: './out', format: 'json' },
      parserStorage: './parsers',
      agentMode: 'interactive',
    });
    mkdirSync(join(tmp, 'parsers'), { recursive: true });
    writeFileSync(join(tmp, 'parsers', LAYOUT_VERSION_FILE), '3', 'utf-8');

    mkdirSync(join(tmp, 'coredoc-sessions', 'Alpha'), { recursive: true });
    writeFileSync(
      join(tmp, 'coredoc-sessions', 'Alpha', 'session.json'),
      JSON.stringify({ id: 'x', projectId: 'Alpha' }),
      'utf-8',
    );

    const result = migrateWorkspaceLayout(configPath);

    expect(result.skipped).toBe(false);
    expect(result.sessionDirsMigrated).toBe(1);
    expect(readFileSync(join(tmp, 'parsers', LAYOUT_VERSION_FILE), 'utf-8')).toBe('4');
  });
});
