/**
 * CLI-surface tests for `coredoc intent` that exercise the Commander wiring in
 * `src/index.ts` itself — the stdout/stderr stream discipline, the option
 * validation, and the help text — which the in-process `runIntent*` unit tests
 * in `intent.test.ts` cannot reach.
 *
 * These spawn the BUILT CLI (`dist/index.js`), so `pnpm --filter @coredoc/cli
 * build` must have run against the current source first (the same contract the
 * telemetry / local-ladybug integration tests in this package rely on).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI_ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

function runCli(args: string[], cwd?: string): { code: number | null; stdout: string; stderr: string } {
  // COREDOC_HOME is deliberately dropped: a set value perturbs unrelated
  // telemetry-config resolution, exactly as the suite runner unsets it.
  const env = { ...process.env };
  delete env.COREDOC_HOME;
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd, env, encoding: 'utf-8' });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('intent validate --help (accurate write claim)', () => {
  it('scopes the "never writes" claim to the overlay, since the shared loader still migrates on disk', () => {
    const { stdout, code } = runCli(['intent', 'validate', '--help']);
    expect(code).toBe(0);
    // Commander hard-wraps the description at the terminal width, so collapse
    // whitespace before matching the sentence.
    const flat = stdout.replace(/\s+/g, ' ');
    // The broad, inaccurate "Never writes." is gone; the overlay-scoped claim stands.
    expect(flat).toContain('Never writes the overlay.');
    expect(flat).not.toMatch(/Never writes\.(?! the overlay)/);
  });
});

describe('intent context --limit (strict integer validation)', () => {
  it('rejects a fractional limit with exit 1 and names the allowed range', () => {
    const { code, stderr } = runCli(['intent', 'context', '-p', 'sample', '--limit', '3.9']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/--limit must be an integer in 1\.\.20/);
  });

  it('rejects a numeric-prefixed limit instead of silently truncating it', () => {
    const { code, stderr } = runCli(['intent', 'context', '-p', 'sample', '--limit', '20abc']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/--limit must be an integer/);
  });
});

describe('intent list --ids (clean machine-readable stdout)', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'coredoc-cli-intent-cli-'));
  });
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('keeps the migration banner off stdout so a piped id consumer never reads it as an id', () => {
    // A project with no `id` forces the one-shot layout migration to backfill
    // one (idsAssigned > 0), which is what makes loadConfig emit its banner.
    // The backfilled id is the slug of the name, i.e. "sample".
    const configPath = path.join(workspace, 'coredoc.config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: '1.0',
        projects: [{ name: 'sample', repos: [{ name: 'sample-repo', path: './sample-repo' }] }],
        output: { dir: './coredoc-output' },
        parserStorage: './coredoc-parsers',
      }),
    );
    const intentDir = path.join(workspace, 'sample-repo', '.coredoc');
    fs.mkdirSync(intentDir, { recursive: true });
    fs.writeFileSync(
      path.join(intentDir, 'intent.json'),
      JSON.stringify({
        schemaVersion: 2,
        projectId: 'sample',
        domains: [{ id: 'ordering', title: 'Ordering' }],
        items: [
          {
            id: 'cap-widget-ordering',
            domain: 'ordering',
            kind: 'capability',
            title: 'Widget ordering',
            statement: 'A store operator can order widgets for one warehouse.',
            authority: 'accepted',
            payload: { outcome: 'An operator places an order', beneficiary: 'Operator', boundary: 'One warehouse' },
            sources: [{ kind: 'spec', ref: 'spec/widget-ordering', localId: 'CAP-1' }],
          },
        ],
        relations: [],
      }),
    );

    const { code, stdout, stderr } = runCli(['intent', 'list', '--ids', '-p', 'sample'], workspace);

    expect(code).toBe(0);
    // stdout is the id list and nothing else — the diagnostic banner is on stderr.
    expect(stdout).not.toContain('Migrated layout');
    expect(stdout.split('\n').filter(Boolean)).toEqual(['cap-widget-ordering']);
    expect(stderr).toContain('Migrated layout');
  });
});
