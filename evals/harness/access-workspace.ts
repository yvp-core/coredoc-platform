import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, removeWorktree, resetWorktree } from './worktree.js';
import { AccessMode, AgentProvider, type Arm, type Target } from './types.js';

export interface AccessWorkspace {
  agentCwd: string;
  verifierPath: string;
  agentGitSha: string | null;
  verifierGitSha: string;
  reset(): Promise<void>;
  cleanup(): Promise<void>;
}

export function planAccessWorkspaceSpecs<T extends Target>(
  targets: readonly T[],
  arms: readonly Arm[],
  preflightOnly: boolean,
): Array<{ target: T; arm: Arm }> {
  const workspaceArms = preflightOnly ? arms.slice(0, 1) : arms;
  return targets.flatMap((target) => workspaceArms.map((arm) => ({ target, arm })));
}

export function resolveAccessMode(
  noCheckout: boolean | undefined,
  historylessSnapshot: boolean | undefined,
): AccessMode {
  if (noCheckout && historylessSnapshot) {
    throw new Error('--no-checkout and --historyless-snapshot are mutually exclusive.');
  }
  if (historylessSnapshot) return AccessMode.HistorylessSnapshot;
  return noCheckout ? AccessMode.NoCheckout : AccessMode.Worktree;
}

export function assertAccessModeSupported(
  accessMode: AccessMode,
  provider: AgentProvider,
): void {
  if (accessMode === AccessMode.NoCheckout && provider === AgentProvider.Codex) {
    throw new Error('--no-checkout is only supported with --provider=claude.');
  }
}

export function buildAccessModeMcpEnv(
  base: Record<string, string>,
  accessMode: AccessMode,
  repoKey: string,
): Record<string, string> {
  if (accessMode === AccessMode.NoCheckout) {
    return { ...base, COREDOC_CURRENT_REPO: repoKey };
  }
  if (accessMode === AccessMode.HistorylessSnapshot) {
    return { ...base, COREDOC_CURRENT_REPO: repoKey };
  }
  return base;
}

/**
 * Dispatch precondition for an agent's cwd, evaluated at spawn time.
 *
 * A workspace fault must surface as `infrastructure_error`, never as a graded
 * answer: two paid runs (2026-08-24 and 2026-08-28) were
 * scored on answers whose content was "I could not find the repository", which
 * silently drags one arm's mean down for a reason that has nothing to do with
 * the treatment. No-checkout is the single mode whose cwd is legitimately
 * empty — there the emptiness *is* the treatment.
 *
 * Returns the fault description, or null when the workspace is usable.
 */
export function agentWorkspaceFault(cwd: string, accessMode?: AccessMode): string | null {
  let entries: string[];
  try {
    entries = readdirSync(cwd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    return `agent workspace ${cwd} is not a readable directory (${code})`;
  }
  if (accessMode === AccessMode.NoCheckout) return null;
  if (entries.length === 0) {
    return `agent workspace ${cwd} is empty; expected a materialized checkout`;
  }
  return null;
}

function clearDirectory(path: string): void {
  for (const entry of readdirSync(path)) {
    rmSync(join(path, entry), { recursive: true, force: true });
  }
}

function removeSymlinks(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const absolute = join(path, entry.name);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      rmSync(absolute, { force: true });
    } else if (stat.isDirectory()) {
      removeSymlinks(absolute);
    }
  }
}

function assertHistorylessTree(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const absolute = join(path, entry.name);
    if (entry.name === '.git') {
      throw new Error(`Historyless snapshot unexpectedly contains git metadata: ${absolute}`);
    }
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      throw new Error(`Historyless snapshot unexpectedly contains a symbolic link: ${absolute}`);
    }
    if (stat.isDirectory()) assertHistorylessTree(absolute);
  }
}

export function materializeHistorylessSnapshot(opts: {
  repoPath: string;
  revision: string;
  destination: string;
}): void {
  clearDirectory(opts.destination);
  const archivePath = join(opts.destination, '.coredoc-historyless-snapshot.tar');
  try {
    execFileSync('git', [
      '-C',
      opts.repoPath,
      'archive',
      '--format=tar',
      '--output',
      archivePath,
      opts.revision,
    ]);
    execFileSync('tar', ['-xf', archivePath, '-C', opts.destination]);
  } finally {
    rmSync(archivePath, { force: true });
  }
  removeSymlinks(opts.destination);
  assertHistorylessTree(opts.destination);
}

export async function createAccessWorkspace(opts: {
  target: Target;
  arm: Arm;
  provider: AgentProvider;
  accessMode: AccessMode;
}): Promise<AccessWorkspace> {
  const { target, arm, provider, accessMode } = opts;
  assertAccessModeSupported(accessMode, provider);
  const revision = target.gitSha;
  if (!revision) {
    throw new Error(`Target "${target.name}" is runnable but has no required gitSha.`);
  }

  const verifierPath = join(
    target.path,
    '.worktrees',
    `eval-${provider}-${target.name}-${arm}-verifier`,
  );
  const verifierGitSha = await createWorktree({
    repoPath: target.path,
    worktreePath: verifierPath,
    revision,
  });

  if (accessMode === AccessMode.NoCheckout) {
    const agentCwd = mkdtempSync(join(tmpdir(), 'coredoc-eval-no-checkout-'));
    return {
      agentCwd,
      verifierPath,
      agentGitSha: null,
      verifierGitSha,
      async reset() {
        for (const entry of readdirSync(agentCwd)) {
          rmSync(join(agentCwd, entry), { recursive: true, force: true });
        }
        await resetWorktree({ repoPath: target.path, worktreePath: verifierPath, revision });
      },
      async cleanup() {
        rmSync(agentCwd, { recursive: true, force: true });
        await removeWorktree({ repoPath: target.path, worktreePath: verifierPath });
      },
    };
  }

  if (accessMode === AccessMode.HistorylessSnapshot) {
    const agentCwd = mkdtempSync(join(tmpdir(), 'coredoc-eval-historyless-'));
    try {
      materializeHistorylessSnapshot({
        repoPath: target.path,
        revision,
        destination: agentCwd,
      });
      return {
        agentCwd,
        verifierPath,
        agentGitSha: revision,
        verifierGitSha,
        async reset() {
          materializeHistorylessSnapshot({
            repoPath: target.path,
            revision,
            destination: agentCwd,
          });
          await resetWorktree({ repoPath: target.path, worktreePath: verifierPath, revision });
        },
        async cleanup() {
          rmSync(agentCwd, { recursive: true, force: true });
          await removeWorktree({ repoPath: target.path, worktreePath: verifierPath });
        },
      };
    } catch (error) {
      rmSync(agentCwd, { recursive: true, force: true });
      await removeWorktree({ repoPath: target.path, worktreePath: verifierPath });
      throw error;
    }
  }

  const worktreePath = join(
    target.path,
    '.worktrees',
    `eval-${provider}-${target.name}-${arm}-agent`,
  );
  try {
    const agentGitSha = await createWorktree({ repoPath: target.path, worktreePath, revision });
    return {
      agentCwd: worktreePath,
      verifierPath,
      agentGitSha,
      verifierGitSha,
      async reset() {
        await resetWorktree({ repoPath: target.path, worktreePath, revision });
        await resetWorktree({ repoPath: target.path, worktreePath: verifierPath, revision });
      },
      async cleanup() {
        await removeWorktree({ repoPath: target.path, worktreePath });
        await removeWorktree({ repoPath: target.path, worktreePath: verifierPath });
      },
    };
  } catch (error) {
    await removeWorktree({ repoPath: target.path, worktreePath: verifierPath });
    throw error;
  }
}
