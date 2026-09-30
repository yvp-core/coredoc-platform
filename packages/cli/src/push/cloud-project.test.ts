/**
 * `coredoc push --cloud` preconditions (v1.1-03).
 *
 * The publish itself is `runSync`, which has its own suite; what is new here is
 * the resolution that removes the hand-typed ids and the refusals that keep a
 * mistyped invocation from becoming a wrong-workspace push or a silent no-op.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RuntimeConfig } from '@coredoc/core/types';
import { parsedRepoFile } from '@coredoc/core/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertCloudPushFlags, assertProjectHasParsedOutput, resolveLinkedCloudProject } from './cloud-project.js';

const WORKSPACE = 'ws_cloud_push_1';

describe('resolveLinkedCloudProject', () => {
  function config(projects: Array<Record<string, unknown>>): RuntimeConfig {
    return { projects, resolvedOutputDir: '/out' } as unknown as RuntimeConfig;
  }

  it('takes the single project and its stored workspace with no flags at all', () => {
    const resolved = resolveLinkedCloudProject(
      config([{ id: 'p1', name: 'P1', repos: [], cloud: { enabled: true, workspaceId: WORKSPACE } }]),
      undefined,
    );
    expect(resolved.project.id).toBe('p1');
    expect(resolved.workspaceId).toBe(WORKSPACE);
  });

  it('requires --project when the config holds more than one, naming the choices', () => {
    expect(() =>
      resolveLinkedCloudProject(
        config([
          { id: 'p1', name: 'P1', repos: [], cloud: { enabled: true, workspaceId: WORKSPACE } },
          { id: 'p2', name: 'P2', repos: [] },
        ]),
        undefined,
      ),
    ).toThrow(/pass --project <id>.*p1, p2/s);
  });

  it('refuses an unlinked project by naming the one command that links it', () => {
    expect(() => resolveLinkedCloudProject(config([{ id: 'p1', name: 'P1', repos: [] }]), 'p1')).toThrow(
      /not linked to a cloud workspace.*coredoc sync -p p1/s,
    );
  });

  it('refuses an unknown project id', () => {
    expect(() => resolveLinkedCloudProject(config([{ id: 'p1', name: 'P1', repos: [] }]), 'nope')).toThrow(
      /Project "nope" not found/,
    );
  });
});

describe('assertCloudPushFlags', () => {
  it('accepts the flags that do carry over', () => {
    expect(() => assertCloudPushFlags({ crossRepo: true })).not.toThrow();
    expect(() => assertCloudPushFlags({})).not.toThrow();
  });

  it.each([
    ['--remote', { remote: true }],
    ['--workspace-id', { workspaceId: 'ws_other' }],
    ['--rebuild', { rebuild: true }],
    ['--backend', { backend: 'neo4j' }],
    ['--create-vector-indexes', { createVectorIndexes: true }],
    ['--no-cross-repo', { crossRepo: false }],
  ])('refuses %s by name rather than ignoring it', (flag, flags) => {
    // The flag itself must be in the message: "unsupported option" without the
    // name is the failure mode this table exists to prevent.
    expect(() => assertCloudPushFlags(flags)).toThrow(flag);
  });
});

describe('assertProjectHasParsedOutput', () => {
  let dir: string;
  let config: RuntimeConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cloud-push-'));
    config = { resolvedOutputDir: join(dir, 'out'), projects: [] } as unknown as RuntimeConfig;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a project with no repos', () => {
    expect(() => assertProjectHasParsedOutput(config, { id: 'p1', name: 'P1', repos: [] })).toThrow(/no repos/);
  });

  it('refuses a project whose repos were never parsed, naming `coredoc parse`', () => {
    expect(() =>
      assertProjectHasParsedOutput(config, { id: 'p1', name: 'P1', repos: [{ name: 'r1', path: '/tmp/r1' }] }),
    ).toThrow(/coredoc parse -p p1/);
  });

  it('accepts as soon as one repo has a parsed artifact', () => {
    const parsed = parsedRepoFile(config.resolvedOutputDir, 'p1', 'r1');
    mkdirSync(dirname(parsed), { recursive: true });
    writeFileSync(parsed, '{}');
    expect(() =>
      assertProjectHasParsedOutput(config, {
        id: 'p1',
        name: 'P1',
        repos: [
          { name: 'r1', path: '/tmp/r1' },
          { name: 'r2', path: '/tmp/r2' },
        ],
      }),
    ).not.toThrow();
  });
});
