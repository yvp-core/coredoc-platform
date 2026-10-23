import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { TurnAssignment } from '@coredoc/core/agent-runner';
import type { Git } from './git.js';
import { assertBranchName, cloneDirName } from './turn-git.js';

type BranchScan = NonNullable<TurnAssignment['branchScan']>;

/**
 * The scope phase's `read_repo`: a shallow, single-branch clone of an eligible repository under
 * `<workDir>/read`. Nothing from the scope phase is pushed. Throws with the reason the agent sees.
 */
export function repositoryReader(git: Git, scan: BranchScan, workDir: string) {
  // A key counts toward the cap once its read starts, so parallel calls cannot pass it or share a directory.
  const reserved = new Set<string>();
  const inFlight = new Set<string>();

  return async (key: string, branch?: string): Promise<string> => {
    const repository = scan.repositories.find((candidate) => candidate.key === key);
    if (!repository) throw new Error(`${key} is not a repository this run may read.`);
    if (inFlight.has(key)) throw new Error(`${key} is being read already; wait for that read.`);
    if (!reserved.has(key) && reserved.size >= scan.maxReads) {
      throw new Error(`A scope turn reads at most ${scan.maxReads} repositories.`);
    }
    const isNew = !reserved.has(key);
    reserved.add(key);
    inFlight.add(key);
    try {
      if (branch) await assertBranchName(git, branch, key);
      const dir = join(workDir, 'read', cloneDirName(key));
      await rm(dir, { recursive: true, force: true });
      const cloned = await git.run(
        [
          'clone',
          '--depth',
          '1',
          '--single-branch',
          '--no-recurse-submodules',
          '--quiet',
          ...(branch ? ['--branch', branch] : []),
          '--',
          repository.cloneUrl,
          dir,
        ],
        { cwd: workDir, authUrl: repository.cloneUrl, allowFailure: true },
      );
      if (cloned.code !== 0) {
        throw new Error(
          `Could not read ${key}${branch ? ` at ${branch}` : ''}: ${cloned.stderr.trim().split('\n').at(-1)}`,
        );
      }
      return dir;
    } catch (error) {
      // A failed first read does not use up the cap.
      if (isNew) reserved.delete(key);
      throw error;
    } finally {
      inFlight.delete(key);
    }
  };
}
