import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildIndexerArgs,
  DEFAULT_SCIP_CONCURRENCY,
  discoverSoloTsconfigProjects,
  enumerateIndexProjects,
  enumeratePnpmWorkspaceProjects,
  isPnpmWorkspaceRoot,
  PER_PROJECT_HEAP_MB,
  planOomSplit,
  planTypescriptProjects,
  projectIndexPath,
  resolveScipTypescriptInvocations,
  runScipTypescriptPerProject,
  SCIP_COMBINED_ENV,
  SCIP_CONCURRENCY_ENV,
  type ScipAsyncSpawn,
  scipChildEnv,
  scipProjectConcurrency,
  summarizeIndexerFailure,
  usePerProjectIndexing,
} from './run-indexer.js';

describe('buildIndexerArgs', () => {
  it('uses base args for a single project', () => {
    expect(buildIndexerArgs('typescript', {})).toEqual(['index']);
  });
  it('passes self-enumerated workspace members positionally instead of --pnpm-workspaces', () => {
    // Positional projects are what --pnpm-workspaces would expand to, without the `pnpm ls` spawn
    // that dies in the desktop sandbox.
    const projects = ['/repo', '/repo/packages/a'];
    expect(buildIndexerArgs('typescript', { pnpmWorkspaces: true, projects })).toEqual([
      'index',
      '/repo',
      '/repo/packages/a',
    ]);
  });

  it('falls back to --pnpm-workspaces when self-enumeration found no members', () => {
    expect(buildIndexerArgs('typescript', { pnpmWorkspaces: true })).toEqual(['index', '--pnpm-workspaces']);
    expect(buildIndexerArgs('typescript', { pnpmWorkspaces: true, projects: [] })).toEqual([
      'index',
      '--pnpm-workspaces',
    ]);
  });
});

describe('resolveScipTypescriptInvocations', () => {
  let dir: string;
  const NO_RESOLVE = (): string => {
    throw new Error('MODULE_NOT_FOUND');
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scip-ts-resolve-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Fake bundled runtime `node_modules` holding @sourcegraph/scip-typescript with the given manifest. */
  const runtimeModules = (manifest: string): string => {
    const pkgDir = join(dir, 'node_modules', '@sourcegraph', 'scip-typescript');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), manifest);
    return join(dir, 'node_modules');
  };

  it('uses the pinned package instead of a potentially incompatible PATH binary', () => {
    const modules = runtimeModules('{"bin":{"scip-typescript":"dist/src/main.js"}}');
    expect(resolveScipTypescriptInvocations({ runtimeModules: modules, execPath: '/node' })).toEqual([
      ['/node', join(modules, '@sourcegraph', 'scip-typescript', 'dist', 'src', 'main.js')],
    ]);
  });

  it('adds a runtime-node candidate for the bundled package (object bin form)', () => {
    const modules = runtimeModules('{"bin":{"scip-typescript":"dist/src/main.js"}}');
    expect(
      resolveScipTypescriptInvocations({ runtimeModules: modules, resolvePackageJson: NO_RESOLVE, execPath: '/node' }),
    ).toEqual([['/node', join(modules, '@sourcegraph', 'scip-typescript', 'dist', 'src', 'main.js')]]);
  });

  it('reads the string bin form too', () => {
    const modules = runtimeModules('{"bin":"lib/cli.js"}');
    expect(
      resolveScipTypescriptInvocations({
        runtimeModules: modules,
        resolvePackageJson: NO_RESOLVE,
        execPath: '/node',
      })[0],
    ).toEqual(['/node', join(modules, '@sourcegraph', 'scip-typescript', 'lib', 'cli.js')]);
  });

  it('falls back to dist/src/main.js when the manifest is unreadable or has no bin', () => {
    const broken = runtimeModules('{ not json');
    const entry = join(broken, '@sourcegraph', 'scip-typescript', 'dist', 'src', 'main.js');
    expect(
      resolveScipTypescriptInvocations({
        runtimeModules: broken,
        resolvePackageJson: NO_RESOLVE,
        execPath: '/node',
      })[0],
    ).toEqual(['/node', entry]);
    const noBin = runtimeModules('{"name":"@sourcegraph/scip-typescript"}');
    expect(
      resolveScipTypescriptInvocations({ runtimeModules: noBin, resolvePackageJson: NO_RESOLVE, execPath: '/node' })[0],
    ).toEqual(['/node', join(noBin, '@sourcegraph', 'scip-typescript', 'dist', 'src', 'main.js')]);
  });

  it('falls back to require.resolve when the runtime-modules dir has no such package', () => {
    const pkgDir = join(dir, 'installed', '@sourcegraph', 'scip-typescript');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), '{"bin":{"scip-typescript":"dist/src/main.js"}}');
    expect(
      resolveScipTypescriptInvocations({
        runtimeModules: join(dir, 'missing-modules'),
        resolvePackageJson: () => join(pkgDir, 'package.json'),
        execPath: '/node',
      })[0],
    ).toEqual(['/node', join(pkgDir, 'dist', 'src', 'main.js')]);
  });

  it('offers only the PATH binary when nothing resolves', () => {
    expect(
      resolveScipTypescriptInvocations({
        runtimeModules: join(dir, 'missing-modules'),
        resolvePackageJson: NO_RESOLVE,
        execPath: '/node',
      }),
    ).toEqual([['scip-typescript']]);
    expect(resolveScipTypescriptInvocations({ resolvePackageJson: NO_RESOLVE, execPath: '/node' })).toEqual([
      ['scip-typescript'],
    ]);
  });
});

describe('enumeratePnpmWorkspaceProjects', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scip-ws-enum-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const manifest = (...segments: string[]): string => {
    const target = join(dir, ...segments);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'package.json'), '{"name":"m"}');
    return target;
  };

  it('resolves glob + literal patterns, skips manifest-less dirs, node_modules and negations', () => {
    writeFileSync(
      join(dir, 'pnpm-workspace.yaml'),
      "packages:\n  - 'packages/**'\n  - 'tools/build-helper'\n  - '!packages/mod-legacy'\n",
    );
    writeFileSync(join(dir, 'package.json'), '{"name":"root"}');
    const modA = manifest('packages', 'mod-a');
    const modB = manifest('packages', 'mod-b');
    const helper = manifest('tools', 'build-helper');
    manifest('packages', 'mod-legacy'); // negated out
    manifest('packages', 'mod-a', 'node_modules', 'dep'); // installed dep, never a member
    mkdirSync(join(dir, 'packages', 'no-manifest'), { recursive: true }); // no package.json → not a project

    const projects = enumeratePnpmWorkspaceProjects(dir);
    expect(projects).toEqual([dir, modA, modB, helper].sort());
    expect(projects.every((p) => isAbsolute(p))).toBe(true);
  });

  it('returns nothing when there is no pnpm-workspace.yaml', () => {
    writeFileSync(join(dir, 'package.json'), '{"name":"solo"}');
    expect(enumeratePnpmWorkspaceProjects(dir)).toEqual([]);
  });

  it('returns nothing (never throws) for malformed yaml or a missing packages field', () => {
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - [unclosed\n   : :\n');
    expect(enumeratePnpmWorkspaceProjects(dir)).toEqual([]);
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'onlyBuiltDependencies:\n  - esbuild\n');
    expect(enumeratePnpmWorkspaceProjects(dir)).toEqual([]);
  });
});

describe('discoverSoloTsconfigProjects / enumerateIndexProjects', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scip-solo-enum-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Create `segments` as a directory, optionally with a tsconfig.json and/or a package.json. */
  const make = (segments: string, opts: { tsconfig?: boolean; manifest?: boolean } = {}): string => {
    const target = join(dir, segments);
    mkdirSync(target, { recursive: true });
    if (opts.tsconfig) writeFileSync(join(target, 'tsconfig.json'), '{}');
    if (opts.manifest) writeFileSync(join(target, 'package.json'), '{"name":"m"}');
    return target;
  };

  it('registers tsconfig roots the workspace globs do not reach, and never one nested under a member', () => {
    // The measured shape: a plugin tree and a scripts dir with their own tsconfig, outside
    // `packages/*` — nothing indexed them before, so every call site in them resolved to nothing.
    const member = make('packages/ui', { tsconfig: true, manifest: true });
    make('packages/ui/tools', { tsconfig: true }); // nested inside a member → that member's business
    const plugin = make('plugins/workflows', { tsconfig: true });
    make('plugins/workflows/scripts', { tsconfig: true }); // nested inside a discovered project
    const scripts = make('scripts', { tsconfig: true });
    make('docs'); // no tsconfig → stays an honestly-warned orphan, never auto-synthesized

    expect(discoverSoloTsconfigProjects(dir, [dir, member])).toEqual([plugin, scripts].sort());
  });

  it('never re-registers the repo root, even though its tsconfig is a prefix of everything', () => {
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    const member = make('packages/ui', { tsconfig: true, manifest: true });
    expect(discoverSoloTsconfigProjects(dir, [dir, member])).toEqual([]);
  });

  it('never descends into installed deps, build output or dotdirs', () => {
    make('node_modules/some-dep', { tsconfig: true });
    make('dist/generated', { tsconfig: true });
    make('.worktrees/feature/plugins/workflows', { tsconfig: true }); // git worktree = the tree twice
    const real = make('plugins/workflows', { tsconfig: true });
    expect(discoverSoloTsconfigProjects(dir, [dir])).toEqual([real]);
  });

  it('merges discovered projects into the workspace member list', () => {
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    writeFileSync(join(dir, 'package.json'), '{"name":"root"}');
    const member = make('packages/ui', { tsconfig: true, manifest: true });
    const plugin = make('plugins/workflows', { tsconfig: true });
    expect(enumerateIndexProjects(dir)).toEqual([dir, member, plugin].sort());
  });

  it('discovers nothing when workspace enumeration itself found nothing (combined fallback owns it)', () => {
    // Without a member list there is no covered-roots list either, so a scan would register
    // subtrees of members as independent projects. Fall back to --pnpm-workspaces instead.
    make('plugins/workflows', { tsconfig: true });
    expect(enumerateIndexProjects(dir)).toEqual([]);
  });
});

describe('planTypescriptProjects', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scip-project-plan-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const source = (path: string): string => {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '');
    return target;
  };

  it('bounds the root to residue outside other project roots and gives no-tsconfig MJS members explicit files', () => {
    const configured = join(dir, 'packages/configured');
    const buildIcons = join(dir, 'packages/build-icons');
    mkdirSync(configured, { recursive: true });
    mkdirSync(buildIcons, { recursive: true });
    writeFileSync(join(dir, 'tsconfig.json'), '{"include":["**/*"]}');
    writeFileSync(join(configured, 'tsconfig.json'), '{}');

    const rootTs = source('release.ts');
    const rootMjs = source('scripts/publish.mjs');
    source('node_modules/ignored/index.ts');
    source('dist/ignored.js');
    source('packages/configured/src/index.ts');
    const iconsMjs = source('packages/build-icons/index.mjs');
    const iconsCjs = source('packages/build-icons/legacy.cjs');

    const plans = planTypescriptProjects(dir, [dir, configured, buildIcons]);
    expect(plans).toEqual([
      { projectDir: dir, sourceFiles: [rootTs, rootMjs].sort(), extendsConfig: join(dir, 'tsconfig.json') },
      { projectDir: configured },
      { projectDir: buildIcons, sourceFiles: [iconsMjs, iconsCjs].sort() },
    ]);
  });

  it('is deterministic regardless of directory enumeration order', () => {
    const member = join(dir, 'packages/scripts');
    mkdirSync(member, { recursive: true });
    const z = source('packages/scripts/z.mjs');
    const a = source('packages/scripts/a.ts');
    expect(planTypescriptProjects(dir, [member])).toEqual([{ projectDir: member, sourceFiles: [a, z].sort() }]);
  });
});

describe('isPnpmWorkspaceRoot', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scip-pnpm-ws-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('detects a pnpm workspace root by pnpm-workspace.yaml', () => {
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n  - 'apps/*'\n");
    expect(isPnpmWorkspaceRoot(dir)).toBe(true);
  });
  it('is false for a plain single-package repo (no regression)', () => {
    writeFileSync(join(dir, 'package.json'), '{"name":"solo"}');
    expect(isPnpmWorkspaceRoot(dir)).toBe(false);
  });
});

describe('scipChildEnv', () => {
  it('leaves the child heap at Node\u2019s default when no override is set', () => {
    expect(scipChildEnv({ PATH: '/usr/bin' }).NODE_OPTIONS).toBeUndefined();
  });

  it('applies COREDOC_SCIP_MAX_OLD_SPACE_MB when an operator opts in', () => {
    expect(scipChildEnv({ COREDOC_SCIP_MAX_OLD_SPACE_MB: '12288' }).NODE_OPTIONS).toBe('--max-old-space-size=12288');
  });

  it('appends to an existing NODE_OPTIONS without clobbering it', () => {
    expect(
      scipChildEnv({ NODE_OPTIONS: '--enable-source-maps', COREDOC_SCIP_MAX_OLD_SPACE_MB: '4096' }).NODE_OPTIONS,
    ).toBe('--enable-source-maps --max-old-space-size=4096');
  });

  it('never overrides a memory cap the caller already set', () => {
    const env = { NODE_OPTIONS: '--max-old-space-size=1024', COREDOC_SCIP_MAX_OLD_SPACE_MB: '8192' };
    expect(scipChildEnv(env).NODE_OPTIONS).toBe('--max-old-space-size=1024');
  });

  it('ignores a non-numeric override rather than emitting a broken flag', () => {
    expect(scipChildEnv({ COREDOC_SCIP_MAX_OLD_SPACE_MB: 'lots' }).NODE_OPTIONS).toBeUndefined();
  });
});

describe('scipProjectConcurrency', () => {
  it('defaults to the documented pool size', () => {
    expect(scipProjectConcurrency({})).toBe(DEFAULT_SCIP_CONCURRENCY);
  });
  it('honours an operator override', () => {
    expect(scipProjectConcurrency({ [SCIP_CONCURRENCY_ENV]: '2' })).toBe(2);
  });
  it('ignores junk and non-positive values rather than stalling the pool', () => {
    for (const v of ['0', '-3', 'many', '']) {
      expect(scipProjectConcurrency({ [SCIP_CONCURRENCY_ENV]: v })).toBe(DEFAULT_SCIP_CONCURRENCY);
    }
  });
});

describe('usePerProjectIndexing', () => {
  it('is on by default once members are enumerable', () => {
    expect(usePerProjectIndexing(['/repo', '/repo/packages/a'], {})).toBe(true);
  });
  it('falls back to the combined invocation when enumeration found nothing', () => {
    // Only scip-typescript’s own --pnpm-workspaces expansion can reach the members then.
    expect(usePerProjectIndexing([], {})).toBe(false);
  });
  it('is off under the COREDOC_SCIP_COMBINED=1 rollback flag', () => {
    expect(usePerProjectIndexing(['/repo'], { [SCIP_COMBINED_ENV]: '1' })).toBe(false);
    expect(usePerProjectIndexing(['/repo'], { [SCIP_COMBINED_ENV]: '0' })).toBe(true);
  });
});

describe('runScipTypescriptPerProject', () => {
  let dir: string;
  let scipDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scip-per-project-'));
    scipDir = join(dir, 'out');
    mkdirSync(scipDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The `--output <path>` the runner told this child to write. */
  const outputOf = (args: string[]): string => args[args.indexOf('--output') + 1];

  /**
   * Fake indexer. `behaviour(project)` decides what the child does: write an index (ok),
   * crash after streaming a truncated one (fail), or report "no files got indexed" (empty).
   */
  const fakeSpawn =
    (behaviour: (project: string) => 'ok' | 'fail' | 'empty'): ScipAsyncSpawn =>
    async (args) => {
      const project = args[args.length - 1];
      const out = outputOf(args);
      switch (behaviour(project)) {
        case 'ok':
          writeFileSync(out, 'INDEX');
          return { spawned: true, error: '', stdout: `done ${out}` };
        case 'fail':
          writeFileSync(out, 'TRUNCATED'); // a crashed child leaves a half-written index behind
          return { spawned: true, error: 'Command failed: heap out of memory', stdout: '' };
        case 'empty':
          return { spawned: true, error: 'Command failed', stdout: 'error: no files got indexed.' };
      }
    };

  it('runs one child per project, each writing its own index under the scip dir', async () => {
    writeFileSync(join(dir, 'root.ts'), 'export const root = true;');
    const projects = [dir, join(dir, 'apps/www'), join(dir, 'packages/ui')];
    const seen: string[][] = [];
    const res = await runScipTypescriptPerProject(dir, scipDir, projects, {
      concurrency: 2,
      spawn: async (args, cwd) => {
        seen.push([args[args.length - 1], cwd]);
        return fakeSpawn(() => 'ok')(args, cwd);
      },
    });
    expect(res.ok).toBe(true);
    expect(res.scipPaths).toHaveLength(3);
    expect(new Set(res.scipPaths).size).toBe(3); // distinct file per project, no clobbering
    expect(res.scipPath).toBeUndefined();
    expect(res.partialReason).toBeUndefined();
    // cwd is always the repo root: that is what keeps document paths repo-relative and mergeable.
    expect(seen.map(([, cwd]) => cwd)).toEqual([dir, dir, dir]);
    expect(
      seen
        .map(([p]) => p)
        .filter((p) => p === projects[1] || p === projects[2])
        .sort(),
    ).toEqual(projects.slice(1).sort());
    const rootConfig = seen.map(([p]) => p).find((p) => p.endsWith('.tsconfig.json'));
    expect(rootConfig?.startsWith(scipDir)).toBe(true);
    expect(rootConfig ? existsSync(rootConfig) : true).toBe(false); // temporary config was cleaned
    for (const p of res.scipPaths ?? []) expect(existsSync(p)).toBe(true);
  });

  it('indexes root residue and a no-tsconfig MJS member through output-dir configs', async () => {
    const buildIcons = join(dir, 'packages/build-icons');
    const configured = join(dir, 'packages/configured');
    mkdirSync(buildIcons, { recursive: true });
    mkdirSync(configured, { recursive: true });
    const umbrellaConfig = '{"include":["**/*"]}';
    writeFileSync(join(dir, 'tsconfig.json'), umbrellaConfig);
    writeFileSync(join(dir, 'release.ts'), 'configured();');
    writeFileSync(join(buildIcons, 'index.mjs'), 'export function icons() {}');
    writeFileSync(join(configured, 'index.ts'), 'export function configured() {}');
    writeFileSync(join(configured, 'tsconfig.json'), '{"include":["index.ts"]}');

    const configs = new Map<
      string,
      {
        extends?: string;
        include?: string[];
        compilerOptions: Record<string, unknown>;
        files: string[];
      }
    >();
    const seen: Array<{ args: string[]; cwd: string }> = [];
    const res = await runScipTypescriptPerProject(dir, scipDir, [dir, buildIcons, configured], {
      concurrency: 1,
      spawn: async (args, cwd) => {
        seen.push({ args, cwd });
        const projectArg = args[args.length - 1];
        if (projectArg.endsWith('.tsconfig.json')) {
          configs.set(projectArg, JSON.parse(readFileSync(projectArg, 'utf8')));
        }
        writeFileSync(outputOf(args), 'INDEX');
        return { spawned: true, error: '', stdout: '' };
      },
    });

    expect(res.ok).toBe(true);
    expect(res.projectOutcomes?.map((outcome) => outcome.project)).toEqual([
      '.',
      'packages/build-icons',
      'packages/configured',
    ]);
    expect(seen.every(({ cwd }) => cwd === dir)).toBe(true);
    expect(seen.flatMap(({ args }) => args)).not.toContain('--infer-tsconfig');
    expect(seen.find(({ args }) => args.at(-1) === configured)?.args.at(-1)).toBe(configured);

    const synthetic = [...configs.entries()];
    expect(synthetic).toHaveLength(2);
    expect(synthetic.every(([path]) => path.startsWith(scipDir))).toBe(true);
    expect(synthetic.every(([, config]) => config.compilerOptions.allowJs === true)).toBe(true);
    expect(synthetic.map(([, config]) => config.files[0]).sort()).toEqual(
      [join(dir, 'release.ts'), join(buildIcons, 'index.mjs')].sort(),
    );
    const rootSynthetic = synthetic.find(([, config]) => config.files.includes(join(dir, 'release.ts')))?.[1];
    expect(rootSynthetic).toEqual({
      extends: join(dir, 'tsconfig.json'),
      compilerOptions: { allowJs: true, checkJs: false, noEmit: true },
      files: [join(dir, 'release.ts')],
      include: [],
    });
    const memberSynthetic = synthetic.find(([, config]) => config.files.includes(join(buildIcons, 'index.mjs')))?.[1];
    expect(memberSynthetic?.extends).toBeUndefined();
    expect(memberSynthetic?.include).toBeUndefined();
    expect(memberSynthetic?.compilerOptions).toMatchObject({
      allowJs: true,
      module: 'nodenext',
      moduleResolution: 'nodenext',
      jsx: 'preserve',
    });
    expect(synthetic.every(([path]) => !existsSync(path))).toBe(true);
    expect(readFileSync(join(dir, 'tsconfig.json'), 'utf8')).toBe(umbrellaConfig);
    expect(existsSync(join(buildIcons, 'tsconfig.json'))).toBe(false);
  });

  it('keeps every other project when one fails, and names the failure in partialReason', async () => {
    const projects = [join(dir, 'apps/www'), join(dir, 'apps/studio'), join(dir, 'packages/ui')];
    const res = await runScipTypescriptPerProject(dir, scipDir, projects, {
      concurrency: 2,
      spawn: fakeSpawn((p) => (p.endsWith('studio') ? 'fail' : 'ok')),
    });
    expect(res.ok).toBe(true);
    expect(res.scipPaths).toHaveLength(2);
    expect(res.partialReason).toMatch(/apps\/studio/);
    expect(res.partialReason).toMatch(/heap out of memory/);
    expect(res.partialReason).not.toMatch(/apps\/www/);
    expect(res.projectOutcomes).toEqual([
      expect.objectContaining({ project: 'apps/www', ok: true }),
      expect.objectContaining({ project: 'apps/studio', ok: false }),
      expect.objectContaining({ project: 'packages/ui', ok: true }),
    ]);
    // The crashed child's half-written index is dropped: one truncated file would fail protobuf
    // decode for the WHOLE merge, defeating the isolation.
    expect(existsSync(projectIndexPath(scipDir, dir, join(dir, 'apps/studio')))).toBe(false);
  });

  it('treats a project with no input files as empty, not failed', async () => {
    const projects = [join(dir, 'packages/config'), join(dir, 'packages/ui')];
    const res = await runScipTypescriptPerProject(dir, scipDir, projects, {
      spawn: fakeSpawn((p) => (p.endsWith('config') ? 'empty' : 'ok')),
    });
    expect(res.ok).toBe(true);
    expect(res.partialReason).toBeUndefined();
    expect(res.projectOutcomes?.[0]).toEqual({ project: 'packages/config', ok: true, empty: true });
    expect(res.scipPaths).toEqual([projectIndexPath(scipDir, dir, join(dir, 'packages/ui'))]);
  });

  it('degrades (no index at all) only when every project failed', async () => {
    const res = await runScipTypescriptPerProject(dir, scipDir, [join(dir, 'a'), join(dir, 'b')], {
      spawn: fakeSpawn(() => 'fail'),
    });
    expect(res.ok).toBe(false);
    expect(res.scipPaths).toBeUndefined();
    expect(res.degradeReason).toMatch(/no index for any of the 2 enumerated projects/);
  });

  it('never exceeds the pool size (each child is a full tsc-scale process)', async () => {
    const projects = Array.from({ length: 7 }, (_, i) => join(dir, `p${i}`));
    let inFlight = 0;
    let peak = 0;
    const res = await runScipTypescriptPerProject(dir, scipDir, projects, {
      concurrency: 3,
      spawn: async (args, cwd) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setImmediate(r));
        inFlight--;
        return fakeSpawn(() => 'ok')(args, cwd);
      },
    });
    expect(peak).toBe(3);
    expect(res.scipPaths).toHaveLength(7);
  });

  it('re-indexes on every run: a stale per-project index is removed before the child starts', async () => {
    // Repo-level cache semantics are unchanged (there is no TS source-hash cache) — what must
    // NOT happen is a previous run's file surviving a failed re-index and passing as fresh.
    const project = join(dir, 'apps/www');
    const stale = projectIndexPath(scipDir, dir, project);
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, 'STALE');
    const res = await runScipTypescriptPerProject(dir, scipDir, [project], { spawn: fakeSpawn(() => 'fail') });
    expect(res.ok).toBe(false);
    expect(existsSync(stale)).toBe(false);
  });
});

describe('projectIndexPath', () => {
  it('gives same-named projects in different dirs distinct index files', () => {
    const a = projectIndexPath('/out', '/repo', '/repo/apps/ui');
    const b = projectIndexPath('/out', '/repo', '/repo/packages/ui');
    expect(a).not.toBe(b);
    expect(a).toMatch(/scip-projects\/ui-[0-9a-f]{12}\.scip$/);
  });
  it('is stable across runs and names the root project', () => {
    expect(projectIndexPath('/out', '/repo', '/repo')).toBe(projectIndexPath('/out', '/repo', '/repo'));
    expect(projectIndexPath('/out', '/repo', '/repo')).toMatch(/scip-projects\/root-[0-9a-f]{12}\.scip$/);
  });
});

describe('summarizeIndexerFailure', () => {
  it('names the V8 heap ceiling for an OOM instead of echoing the argv', () => {
    const err = Object.assign(
      new Error(
        'Command failed: scip-typescript index --output /very/long/tmp/path/root-3a52ce780950.scip /repo/apps/www\n' +
          'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory',
      ),
      { signal: 'SIGABRT', status: 134 },
    );
    const summary = summarizeIndexerFailure(err);
    expect(summary).toMatch(/out of memory/);
    expect(summary).toMatch(/COREDOC_SCIP_MAX_OLD_SPACE_MB/);
    // The argv is noise, and truncating it downstream used to read as a mangled project path.
    expect(summary).not.toMatch(/--output/);
  });

  it("names the actual ceiling: the per-project default, or Node's own for the combined run", () => {
    const oom = new Error('Command failed: x\nFATAL ERROR: JavaScript heap out of memory');
    expect(summarizeIndexerFailure(oom, PER_PROJECT_HEAP_MB)).toMatch(
      new RegExp(`${PER_PROJECT_HEAP_MB} MB by default`),
    );
    expect(summarizeIndexerFailure(oom)).toMatch(/Node's default/);
  });

  it('reports a timeout as a timeout', () => {
    expect(
      summarizeIndexerFailure(Object.assign(new Error('Command failed: x'), { signal: 'SIGTERM', code: 'ETIMEDOUT' })),
    ).toMatch(/timed out after \d+ minutes/);
  });

  it('classifies real async Node errors for timeout, external termination and maxBuffer', async () => {
    const run = promisify(execFile);
    const timeout = await run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 50 }).catch(
      (error: unknown) => error,
    );
    expect(summarizeIndexerFailure(timeout)).toContain('timed out');
    const terminated = await run(process.execPath, ['-e', "process.kill(process.pid, 'SIGTERM')"]).catch(
      (error: unknown) => error,
    );
    expect(summarizeIndexerFailure(terminated)).not.toContain('timed out');
    const overflow = await run(process.execPath, ['-e', "console.log('x'.repeat(1000))"], { maxBuffer: 10 }).catch(
      (error: unknown) => error,
    );
    expect(summarizeIndexerFailure(overflow)).not.toContain('timed out');
  });

  it('recognizes asynchronous execFile deadlines without confusing output overflow', () => {
    expect(
      summarizeIndexerFailure(
        Object.assign(new Error('Command failed'), {
          code: null,
          signal: 'SIGTERM',
          killed: true,
        }),
      ),
    ).toContain('timed out after 10 minutes');
    expect(
      summarizeIndexerFailure(
        Object.assign(new Error('stdout maxBuffer length exceeded'), {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          signal: 'SIGTERM',
          killed: true,
        }),
      ),
    ).not.toContain('timed out');
  });

  it('does not claim a deadline elapsed when a child receives SIGTERM', () => {
    const summary = summarizeIndexerFailure(Object.assign(new Error('Command failed: x'), { signal: 'SIGTERM' }));
    expect(summary).toContain('signal SIGTERM');
    expect(summary).not.toContain('timed out');
  });

  it('keeps the stderr tail for any other failure, without the command line', () => {
    const err = Object.assign(new Error('Command failed: scip-typescript index /repo\nerror: TS5083 cannot read'), {
      code: 1,
    });
    const summary = summarizeIndexerFailure(err);
    expect(summary).toMatch(/TS5083/);
    expect(summary).not.toMatch(/scip-typescript index/);
  });
});

describe('per-project heap default', () => {
  it('gives a per-project child headroom the combined invocation never gets', () => {
    // Measured: posthog's frontend project OOMs at Node's ~4 GB default and indexes in ~72 s at
    // 8 GB. Safe here (unlike the combined run) because a child that still dies costs one project.
    expect(scipChildEnv({}, PER_PROJECT_HEAP_MB).NODE_OPTIONS).toBe(`--max-old-space-size=${PER_PROJECT_HEAP_MB}`);
    // Unchanged for the combined workspace path: Node's own default.
    expect(scipChildEnv({}).NODE_OPTIONS).toBeUndefined();
  });

  it('still lets an operator override win', () => {
    expect(scipChildEnv({ COREDOC_SCIP_MAX_OLD_SPACE_MB: '2048' }, PER_PROJECT_HEAP_MB).NODE_OPTIONS).toBe(
      '--max-old-space-size=2048',
    );
  });
});

describe('project containment', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scip-contain-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const spawnOk: ScipAsyncSpawn = async (args) => {
    writeFileSync(args[args.indexOf('--output') + 1], 'INDEX');
    return { spawned: true, error: '', stdout: '' };
  };

  it('indexes the repo root itself as bounded `.` residue through an output-dir config', async () => {
    writeFileSync(join(dir, 'root.ts'), 'export const root = true;');
    const seen: string[] = [];
    const res = await runScipTypescriptPerProject(dir, join(dir, 'out'), [dir], {
      spawn: async (args, cwd) => {
        seen.push(args[args.length - 1]);
        return spawnOk(args, cwd);
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].startsWith(join(dir, 'out'))).toBe(true);
    expect(seen[0]).toMatch(/\.tsconfig\.json$/);
    expect(existsSync(seen[0])).toBe(false);
    expect(res.projectOutcomes).toEqual([expect.objectContaining({ project: '.', ok: true })]);
    expect(res.scipPaths).toEqual([projectIndexPath(join(dir, 'out'), dir, dir)]);
  });

  it('refuses to index a project outside the repo root, without spawning anything', async () => {
    let spawns = 0;
    const res = await runScipTypescriptPerProject(dir, join(dir, 'out'), [dirname(dir), join(dir, 'apps/www')], {
      spawn: async (args, cwd) => {
        spawns++;
        return spawnOk(args, cwd);
      },
    });
    expect(spawns).toBe(1); // only the in-repo project ran
    expect(res.projectOutcomes?.[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/not inside the repo/) });
    expect(res.ok).toBe(true);
    expect(res.partialReason).toMatch(/not inside the repo/);
  });
});

describe('planOomSplit', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scip-split-plan-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Create `segments` as a directory, optionally with a tsconfig.json and some source files. */
  const make = (segments: string, opts: { tsconfig?: boolean; files?: string[] } = {}): string => {
    const target = join(dir, segments);
    mkdirSync(target, { recursive: true });
    if (opts.tsconfig) writeFileSync(join(target, 'tsconfig.json'), '{}');
    for (const f of opts.files ?? []) writeFileSync(join(target, f), '');
    return target;
  };

  it('finds the independent nested tsconfig projects under a too-big project', () => {
    // supabase's shape: a root whose real content is N self-contained mini-apps.
    writeFileSync(join(dir, 'tsconfig.json'), '{}'); // the failing project's own tsconfig
    const clerk = make('examples/clerk', { tsconfig: true, files: ['app.ts'] });
    const todo = make('examples/todo-list/nextjs-todo-list', { tsconfig: true, files: ['page.tsx'] });
    expect(planOomSplit(dir).nestedRoots).toEqual([clerk, todo].sort());
  });

  it('splits ONE level: a tsconfig nested inside a nested project is that project’s business', () => {
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    const outer = make('examples/monorepo-example', { tsconfig: true });
    make('examples/monorepo-example/packages/inner', { tsconfig: true });
    expect(planOomSplit(dir).nestedRoots).toEqual([outer]);
  });

  it('skips dirs another workspace project already owns, node_modules, build output and dotdirs', () => {
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    const member = make('packages/ui', { tsconfig: true }); // enumerated workspace member
    make('node_modules/some-dep', { tsconfig: true });
    make('dist/generated', { tsconfig: true });
    make('.worktrees/feature-branch/examples/clerk', { tsconfig: true }); // git worktree = whole tree twice
    const real = make('examples/clerk', { tsconfig: true });
    expect(planOomSplit(dir, [dir, member]).nestedRoots).toEqual([real]);
  });

  it('counts TS/JS files under no nested tsconfig as residue, and never the covered ones', () => {
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    make('scripts', { files: ['seed.ts', 'build-icons.mts', 'notes.md'] });
    make('examples/clerk', { tsconfig: true, files: ['a.ts', 'b.ts', 'c.ts'] }); // covered by a sub-project
    writeFileSync(join(dir, 'root-level.js'), '');
    const plan = planOomSplit(dir);
    expect(plan.nestedRoots).toHaveLength(1);
    expect(plan.residueFiles).toBe(3); // seed.ts + build-icons.mts + root-level.js, not the .md, not the 3 covered
  });

  it('reports nothing to split for a project that is genuinely one program', () => {
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    make('src', { files: ['index.ts'] });
    expect(planOomSplit(dir)).toEqual({ nestedRoots: [], residueFiles: 1 });
  });
});

describe('OOM split retry', () => {
  let dir: string;
  let projectDir: string;
  let scipDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scip-split-'));
    projectDir = join(dir, 'apps/umbrella');
    scipDir = join(dir, 'out');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(scipDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A repo root that is really two nested example apps plus two loose scripts. */
  const buildSplittableRoot = (): { clerk: string; todo: string } => {
    writeFileSync(join(projectDir, 'tsconfig.json'), '{}');
    for (const p of ['examples/clerk', 'examples/todo-list']) {
      mkdirSync(join(projectDir, p), { recursive: true });
      writeFileSync(join(projectDir, p, 'tsconfig.json'), '{}');
    }
    mkdirSync(join(projectDir, 'scripts'), { recursive: true });
    for (const f of ['seed.ts', 'release.ts']) writeFileSync(join(projectDir, 'scripts', f), '');
    return { clerk: join(projectDir, 'examples/clerk'), todo: join(projectDir, 'examples/todo-list') };
  };

  /** Fails the given project dirs with an OOM, indexes everything else. */
  const spawnOomFor = (oomDirs: string[]): ScipAsyncSpawn => {
    const oom = new Set(oomDirs);
    return async (args) => {
      const project = args[args.length - 1];
      const out = args[args.indexOf('--output') + 1];
      if (oom.has(project)) {
        return {
          spawned: true,
          error: summarizeIndexerFailure(new Error('JavaScript heap out of memory')),
          stdout: '',
        };
      }
      writeFileSync(out, 'INDEX');
      return { spawned: true, error: '', stdout: '' };
    };
  };

  it('re-indexes an OOMed project as its nested projects and reports one split line', async () => {
    const { clerk, todo } = buildSplittableRoot();
    const res = await runScipTypescriptPerProject(dir, scipDir, [projectDir], {
      spawn: spawnOomFor([projectDir]),
    });
    expect(res.ok).toBe(true);
    expect(res.scipPaths).toEqual([clerk, todo].map((p) => projectIndexPath(scipDir, dir, p)));
    // One line, naming the split and the accepted residue — not a whole-project OOM blackout.
    expect(res.partialReason).toBe(
      'apps/umbrella OOM → split into 2 nested project(s), 2 residue file(s) unindexed (no tsconfig)',
    );
    expect(res.projectOutcomes).toEqual([
      expect.objectContaining({ project: 'apps/umbrella', ok: true, split: { subProjects: 2, residueFiles: 2 } }),
      expect.objectContaining({ project: 'apps/umbrella/examples/clerk', ok: true, parent: 'apps/umbrella' }),
      expect.objectContaining({ project: 'apps/umbrella/examples/todo-list', ok: true, parent: 'apps/umbrella' }),
    ]);
  });

  it('never re-indexes the OOMed directory itself (that is what ran out of memory)', async () => {
    buildSplittableRoot();
    const spawned: string[] = [];
    await runScipTypescriptPerProject(dir, scipDir, [projectDir], {
      spawn: async (args, cwd) => {
        spawned.push(args[args.length - 1]);
        return spawnOomFor([projectDir])(args, cwd);
      },
    });
    expect(spawned.filter((p) => p === projectDir)).toHaveLength(1); // the original attempt, never a retry
  });

  it('bounds splitting to ONE level: a sub-project that OOMs is reported failed, not split again', async () => {
    const { clerk, todo } = buildSplittableRoot();
    // clerk is itself a mini-monorepo — a second level exists, and must be left alone.
    mkdirSync(join(clerk, 'packages/inner'), { recursive: true });
    writeFileSync(join(clerk, 'packages/inner/tsconfig.json'), '{}');
    const res = await runScipTypescriptPerProject(dir, scipDir, [projectDir], {
      spawn: spawnOomFor([projectDir, clerk]),
    });
    expect(res.scipPaths).toEqual([projectIndexPath(scipDir, dir, todo)]);
    expect(res.projectOutcomes?.map((o) => [o.project, o.ok])).toEqual([
      ['apps/umbrella', true],
      ['apps/umbrella/examples/clerk', false],
      ['apps/umbrella/examples/todo-list', true],
    ]);
    expect(res.partialReason).toMatch(/apps\/umbrella\/examples\/clerk \[out of memory:/);
    expect(res.partialReason).toMatch(/split into 2 nested project\(s\)/);
  });

  it('does NOT split a non-OOM failure — splitting cannot fix a broken tsconfig or a timeout', async () => {
    buildSplittableRoot();
    const spawned: string[] = [];
    const clerk = join(projectDir, 'examples/clerk');
    const res = await runScipTypescriptPerProject(dir, scipDir, [projectDir, clerk], {
      spawn: async (args) => {
        const project = args[args.length - 1];
        spawned.push(project);
        if (project === projectDir) {
          return {
            spawned: true,
            error: summarizeIndexerFailure(new Error('Command failed: x\nerror TS5083')),
            stdout: '',
          };
        }
        writeFileSync(args[args.indexOf('--output') + 1], 'INDEX');
        return { spawned: true, error: '', stdout: '' };
      },
    });
    expect(spawned).toEqual([projectDir, clerk]); // no retry pass at all
    expect(res.projectOutcomes?.[0]).toMatchObject({ project: 'apps/umbrella', ok: false });
    expect(res.partialReason).toMatch(/TS5083/);
    expect(res.partialReason).not.toMatch(/split/);
  });

  it('keeps the honest OOM failure when the project has nothing to split into', async () => {
    writeFileSync(join(projectDir, 'tsconfig.json'), '{}');
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/index.ts'), '');
    const res = await runScipTypescriptPerProject(dir, scipDir, [projectDir, join(dir, 'other')], {
      spawn: spawnOomFor([projectDir]),
    });
    expect(res.projectOutcomes?.[0]).toMatchObject({ project: 'apps/umbrella', ok: false });
    expect(res.projectOutcomes?.[0]).not.toHaveProperty('split');
    expect(res.partialReason).toMatch(/out of memory:/);
  });
});
