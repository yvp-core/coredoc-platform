import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentWorkspaceFault,
  assertAccessModeSupported,
  buildAccessModeMcpEnv,
  createAccessWorkspace,
  planAccessWorkspaceSpecs,
  resolveAccessMode,
} from './access-workspace.js';
import { AccessMode, AgentProvider, type Target } from './types.js';
import { baseSystemPromptFor, cleanupRunResources } from './run.js';

const cleanupRoots: string[] = [];

function targetAt(path: string, gitSha: string): Target {
  return {
    name: 'sample',
    path,
    baseBranch: 'main',
    repoKey: 'sample-key',
    gitSha,
    cases: {} as Target['cases'],
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo(): { repo: string; pinned: string } {
  const repo = mkdtempSync(join(tmpdir(), 'evals-repo-'));
  cleanupRoots.push(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'source.ts'), 'export const truth = 1;\n');
  symlinkSync('source.ts', join(repo, 'source-link.ts'));
  git(repo, 'add', 'source.ts', 'source-link.ts');
  git(repo, 'commit', '-m', 'init');
  return { repo, pinned: git(repo, 'rev-parse', 'HEAD') };
}

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('access mode', () => {
  it('settles every workspace cleanup before failing and always stops the sleep guard', async () => {
    const failure = new Error('cleanup failed');
    let finishSlowCleanup: (() => void) | undefined;
    const slowCleanup = new Promise<void>((resolve) => {
      finishSlowCleanup = resolve;
    });
    const failed = vi.fn(async () => {
      throw failure;
    });
    const slow = vi.fn(() => slowCleanup);
    const sleepGuard = { kill: vi.fn() };

    const outcome = cleanupRunResources(
      [{ cleanup: failed }, { cleanup: slow }],
      sleepGuard,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(failed).toHaveBeenCalledOnce();
    expect(slow).toHaveBeenCalledOnce();
    expect(sleepGuard.kill).not.toHaveBeenCalled();

    finishSlowCleanup?.();

    expect(await outcome).toBe(failure);
    expect(sleepGuard.kill).toHaveBeenCalledOnce();
  });

  it('plans one workspace per target for preflight and one per target-arm for execution', () => {
    const first = targetAt('/repos/first', 'a'.repeat(40));
    const second = { ...targetAt('/repos/second', 'b'.repeat(40)), name: 'second' };
    const arms = ['withMcp', 'mcpOnly', 'withoutMcp'] as const;

    expect(planAccessWorkspaceSpecs([first, second], arms, true)).toEqual([
      { target: first, arm: 'withMcp' },
      { target: second, arm: 'withMcp' },
    ]);
    expect(planAccessWorkspaceSpecs([first, second], arms, false)).toHaveLength(6);
  });

  it('maps --no-checkout to the isolated mode and keeps worktree as the default', () => {
    expect(resolveAccessMode(true, false)).toBe(AccessMode.NoCheckout);
    expect(resolveAccessMode(false, true)).toBe(AccessMode.HistorylessSnapshot);
    expect(resolveAccessMode(false, false)).toBe(AccessMode.Worktree);
    expect(resolveAccessMode(undefined, undefined)).toBe(AccessMode.Worktree);
    expect(() => resolveAccessMode(true, true)).toThrow(/mutually exclusive/i);
  });

  it('keeps Codex no-checkout rejected while allowing Codex historyless snapshots', () => {
    expect(() => assertAccessModeSupported(AccessMode.NoCheckout, AgentProvider.Codex)).toThrow(
      '--no-checkout is only supported with --provider=claude',
    );
    expect(() =>
      assertAccessModeSupported(AccessMode.NoCheckout, AgentProvider.Claude),
    ).not.toThrow();
    expect(() =>
      assertAccessModeSupported(AccessMode.Worktree, AgentProvider.Codex),
    ).not.toThrow();
    expect(() =>
      assertAccessModeSupported(AccessMode.HistorylessSnapshot, AgentProvider.Codex),
    ).not.toThrow();
    expect(() =>
      assertAccessModeSupported(AccessMode.HistorylessSnapshot, AgentProvider.Claude),
    ).not.toThrow();
  });

  it('adds only the repo key to the no-checkout MCP environment', () => {
    const base = {
      MCP_CONFIG_PATH: '/coredoc/coredoc.config.json',
      COREDOC_SCOPE: 'project:acme',
      COREDOC_DB_BACKEND: 'ladybug',
    };
    expect(buildAccessModeMcpEnv(base, AccessMode.NoCheckout, 'acme-admin')).toEqual({
      ...base,
      COREDOC_CURRENT_REPO: 'acme-admin',
    });
    expect(buildAccessModeMcpEnv(base, AccessMode.Worktree, 'acme-admin')).toEqual(base);
    expect(buildAccessModeMcpEnv(base, AccessMode.HistorylessSnapshot, 'acme-admin')).toEqual({
      ...base,
      COREDOC_CURRENT_REPO: 'acme-admin',
    });
  });
});

describe('createAccessWorkspace', () => {
  it('materializes an exact-SHA tracked snapshot without git metadata or symlinks and rematerializes on reset', async () => {
    const { repo, pinned } = makeRepo();

    const workspace = await createAccessWorkspace({
      target: targetAt(repo, pinned),
      arm: 'withMcp',
      provider: AgentProvider.Claude,
      accessMode: AccessMode.HistorylessSnapshot,
    });

    expect(isAbsolute(workspace.agentCwd)).toBe(true);
    expect(relative(repo, workspace.agentCwd).startsWith('..')).toBe(true);
    expect(workspace.agentCwd.startsWith(`${tmpdir()}/coredoc-eval-historyless-`)).toBe(true);
    expect(workspace.agentGitSha).toBe(pinned);
    expect(readFileSync(join(workspace.agentCwd, 'source.ts'), 'utf8')).toBe(
      'export const truth = 1;\n',
    );
    expect(existsSync(join(workspace.agentCwd, '.git'))).toBe(false);
    expect(existsSync(join(workspace.agentCwd, 'source-link.ts'))).toBe(false);

    writeFileSync(join(repo, 'source.ts'), 'future source\n');
    git(repo, 'add', 'source.ts');
    git(repo, 'commit', '-m', 'future');
    expect(readFileSync(join(workspace.agentCwd, 'source.ts'), 'utf8')).toBe(
      'export const truth = 1;\n',
    );

    writeFileSync(join(workspace.agentCwd, 'source.ts'), 'tampered\n');
    symlinkSync('/tmp', join(workspace.agentCwd, 'runtime-link'));
    await workspace.reset();
    expect(readFileSync(join(workspace.agentCwd, 'source.ts'), 'utf8')).toBe(
      'export const truth = 1;\n',
    );
    expect(existsSync(join(workspace.agentCwd, 'runtime-link'))).toBe(false);
    expect(
      readdirSync(workspace.agentCwd, { recursive: true }).some((entry) =>
        lstatSync(join(workspace.agentCwd, String(entry))).isSymbolicLink(),
      ),
    ).toBe(false);

    const snapshotPath = workspace.agentCwd;
    const verifierPath = workspace.verifierPath;
    await workspace.cleanup();
    expect(existsSync(snapshotPath)).toBe(false);
    expect(existsSync(verifierPath)).toBe(false);
  });

  it('keeps no-checkout agent cwd empty while pinning hidden verifier truth to gitSha', async () => {
    const { repo, pinned } = makeRepo();

    const workspace = await createAccessWorkspace({
      target: targetAt(repo, pinned),
      arm: 'withMcp',
      provider: AgentProvider.Claude,
      accessMode: AccessMode.NoCheckout,
    });
    cleanupRoots.push(workspace.agentCwd);

    expect(isAbsolute(workspace.agentCwd)).toBe(true);
    expect(relative(repo, workspace.agentCwd).startsWith('..')).toBe(true);
    expect(workspace.agentCwd.startsWith(`${tmpdir()}/coredoc-eval-no-checkout-`)).toBe(
      true,
    );
    expect(readdirSync(workspace.agentCwd)).toEqual([]);
    expect(workspace.verifierPath).not.toBe(repo);
    expect(git(workspace.verifierPath, 'rev-parse', 'HEAD')).toBe(pinned);
    expect(() => git(workspace.verifierPath, 'symbolic-ref', '-q', 'HEAD')).toThrow();
    expect(git(workspace.verifierPath, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(workspace.verifierPath, 'source.ts'), 'utf8')).toBe(
      'export const truth = 1;\n',
    );

    writeFileSync(join(repo, 'source.ts'), 'branch moved\n');
    git(repo, 'add', 'source.ts');
    git(repo, 'commit', '-m', 'move branch');
    expect(readFileSync(join(workspace.verifierPath, 'source.ts'), 'utf8')).toBe(
      'export const truth = 1;\n',
    );

    writeFileSync(join(workspace.agentCwd, 'leak.txt'), 'must be removed');
    await workspace.reset();
    expect(readdirSync(workspace.agentCwd)).toEqual([]);
    expect(git(workspace.verifierPath, 'rev-parse', 'HEAD')).toBe(pinned);
    const isolatedPath = workspace.agentCwd;
    const verifierPath = workspace.verifierPath;
    await workspace.cleanup();
    expect(existsSync(isolatedPath)).toBe(false);
    expect(existsSync(verifierPath)).toBe(false);
    expect(existsSync(repo)).toBe(true);
  });

  it('uses separate clean detached exact-SHA worktrees for agent and verifier', async () => {
    const { repo, pinned } = makeRepo();

    const workspace = await createAccessWorkspace({
      target: targetAt(repo, pinned),
      arm: 'withoutMcp',
      provider: AgentProvider.Claude,
      accessMode: AccessMode.Worktree,
    });
    expect(workspace.verifierPath).not.toBe(workspace.agentCwd);
    expect(git(workspace.agentCwd, 'rev-parse', 'HEAD')).toBe(pinned);
    expect(git(workspace.verifierPath, 'rev-parse', 'HEAD')).toBe(pinned);
    expect(() => git(workspace.agentCwd, 'symbolic-ref', '-q', 'HEAD')).toThrow();
    expect(() => git(workspace.verifierPath, 'symbolic-ref', '-q', 'HEAD')).toThrow();
    expect(readFileSync(join(workspace.agentCwd, 'source.ts'), 'utf8')).toBe(
      'export const truth = 1;\n',
    );

    writeFileSync(join(workspace.agentCwd, 'source.ts'), 'changed\n');
    await workspace.reset();
    expect(readFileSync(join(workspace.agentCwd, 'source.ts'), 'utf8')).toBe(
      'export const truth = 1;\n',
    );
    expect(git(workspace.agentCwd, 'status', '--porcelain')).toBe('');
    expect(git(workspace.verifierPath, 'status', '--porcelain')).toBe('');

    const worktreePath = workspace.agentCwd;
    const verifierPath = workspace.verifierPath;
    await workspace.cleanup();
    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(verifierPath)).toBe(false);
  });

  // Both arms of a pair live under the same `<repo>/.worktrees` parent and run
  // concurrently (default --concurrency is unbounded). Neither arm's per-run
  // reset nor its end-of-run cleanup may disturb the sibling's checkout, or the
  // sibling's agent reads an empty cwd mid-run.
  it('keeps paired arms isolated across reset and cleanup of the sibling arm', async () => {
    const { repo, pinned } = makeRepo();
    const target = targetAt(repo, pinned);

    const [control, treatment] = await Promise.all(
      (['withoutMcp', 'withMcp'] as const).map((arm) =>
        createAccessWorkspace({
          target,
          arm,
          provider: AgentProvider.Claude,
          accessMode: AccessMode.Worktree,
        }),
      ),
    );

    expect(control!.agentCwd).not.toBe(treatment!.agentCwd);
    for (const workspace of [control!, treatment!]) {
      expect(readdirSync(workspace.agentCwd).length).toBeGreaterThan(0);
      expect(readdirSync(workspace.verifierPath).length).toBeGreaterThan(0);
    }

    await control!.reset();
    expect(agentWorkspaceFault(treatment!.agentCwd, AccessMode.Worktree)).toBeNull();

    await control!.cleanup();
    expect(existsSync(control!.agentCwd)).toBe(false);
    expect(agentWorkspaceFault(treatment!.agentCwd, AccessMode.Worktree)).toBeNull();
    expect(readFileSync(join(treatment!.agentCwd, 'source.ts'), 'utf8')).toBe(
      'export const truth = 1;\n',
    );

    await treatment!.cleanup();
  });
});

describe('baseSystemPromptFor', () => {
  // The SDK's string systemPrompt replaces the Claude Code preset, so the
  // preset's "working directory" preamble never reaches the agent. Worktree
  // runs must say it themselves or agents go looking for the repo elsewhere on
  // disk (2026-08-24 read the user's unpinned checkout; 2026-08-28 gave up).
  it('orients a worktree agent to its own checkout and forbids other copies', () => {
    const prompt = baseSystemPromptFor(AccessMode.Worktree);
    expect(prompt).toMatch(/working directory is a checkout/i);
    expect(prompt).toMatch(/do not search the wider filesystem/i);
  });

  it('keeps the isolated modes on their own prompts', () => {
    expect(baseSystemPromptFor(AccessMode.NoCheckout)).toMatch(/no repository checkout is available/i);
    expect(baseSystemPromptFor(AccessMode.HistorylessSnapshot)).toMatch(/tracked snapshot/i);
    expect(baseSystemPromptFor(AccessMode.NoCheckout)).not.toMatch(/working directory is a checkout/i);
  });
});

describe('agentWorkspaceFault', () => {
  it('faults on a missing directory in every mode', () => {
    const missing = join(tmpdir(), 'evals-agent-workspace-absent');
    expect(agentWorkspaceFault(missing, AccessMode.Worktree)).toContain('ENOENT');
    expect(agentWorkspaceFault(missing, AccessMode.NoCheckout)).toContain('ENOENT');
  });

  it('faults on an empty checkout but accepts an empty no-checkout cwd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evals-agent-workspace-'));
    cleanupRoots.push(dir);
    expect(agentWorkspaceFault(dir, AccessMode.Worktree)).toMatch(/is empty/);
    expect(agentWorkspaceFault(dir, AccessMode.HistorylessSnapshot)).toMatch(/is empty/);
    expect(agentWorkspaceFault(dir, AccessMode.NoCheckout)).toBeNull();

    writeFileSync(join(dir, 'source.ts'), 'export const truth = 1;\n');
    expect(agentWorkspaceFault(dir, AccessMode.Worktree)).toBeNull();
  });
});
