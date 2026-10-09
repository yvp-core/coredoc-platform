/**
 * Git work of an implement turn, all in the runner with the bot's token:
 * clone and branch before the session; after it, stage, scan, commit and push
 * fast-forward to the run branch. Nothing is pushed while any clone's scan
 * blocks.
 */
import { copyFile, lstat, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type AssignedRepository, MAX_WORKFLOW_DIFF_BYTES, type RepositoryReport } from '@coredoc/core/agent-runner';
import { defaultRetryDelay, GITHUB_ATTEMPTS, type RetryDelay, sleep, TurnFailure } from '../turn-failure.js';
import { type Git, GitError } from './git.js';
import { blocksPush, describeBlock, REMOTE_MOVED_REASONS, type SecretScanner } from './secret-scan.js';
import { stageChanges } from './staging.js';

export interface Clone {
  repository: AssignedRepository;
  /** The clone's work tree, inside the turn's work directory. */
  dir: string;
  defaultBranch: string;
  /** The run branch's head on the remote when the turn started; this run's own (reserved) branch. */
  remoteRunHead: string | null;
  /** The clone's git config as the runner wrote it, restored before any git after the session. */
  configTemplate: string;
}

/** Repository-format settings of a fresh clone kept in the config template; everything else is dropped. */
const TEMPLATE_KEYS = new Set([
  'core.repositoryformatversion',
  'core.filemode',
  'core.bare',
  'core.logallrefupdates',
  'core.ignorecase',
  'core.precomposeunicode',
  'core.symlinks',
  'extensions.objectformat',
]);

function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The only config a clone has after the session: its fresh clone's format
 * settings and `origin` pointing at the assigned clone URL. No hooks path,
 * includes, URL rewrites, push URLs, helpers or http settings survive.
 */
export function configTemplate(freshConfig: string, cloneUrl: string): string {
  const sections = new Map<string, string[]>();
  for (const line of freshConfig.split('\n')) {
    const space = line.indexOf(' ');
    const key = (space < 0 ? line : line.slice(0, space)).toLowerCase();
    const value = space < 0 ? 'true' : line.slice(space + 1);
    if (!TEMPLATE_KEYS.has(key) || !/^[A-Za-z0-9._-]+$/.test(value)) continue;
    const [section, name] = key.split('.') as [string, string];
    sections.set(section, [...(sections.get(section) ?? []), `\t${name} = ${value}`]);
  }
  return [
    ...[...sections].flatMap(([section, lines]) => [`[${section}]`, ...lines]),
    '[remote "origin"]',
    `\turl = ${quoted(cloneUrl)}`,
    '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    '',
  ].join('\n');
}

export type PublishOutcome =
  | { kind: 'published'; reports: RepositoryReport[] }
  | { kind: 'blocked'; findings: string[]; reports: RepositoryReport[] }
  /** A push failed; the reports keep the heads that earlier pushes already put on the remote. */
  | { kind: 'failed'; failure: TurnFailure; reports: RepositoryReport[] };

export interface TurnGitOptions {
  git: Git;
  scanner: SecretScanner;
  issueKey: string;
  branch: string;
  /** The run's count of agent turns; a retried attempt keeps it. */
  turnNumber: number;
  /** Per-turn temp directory, outside every clone. */
  tmp: string;
  /** Records "created by this run" on the server before the first push of the run branch. */
  reserveBranch: (repository: string) => Promise<void>;
  /** True once the server said stop or the lease was lost: nothing more is pushed. */
  stopped: () => boolean;
  retryDelay?: RetryDelay;
}

/** A clone's directory name: the repository key, made safe for a path segment. */
export function cloneDirName(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_');
}

export class TurnGit {
  private readonly retryDelay: RetryDelay;

  constructor(private readonly options: TurnGitOptions) {
    this.retryDelay = options.retryDelay ?? defaultRetryDelay;
  }

  /**
   * Clones every repository (never recursively, keeping the default branch
   * and `origin/HEAD`) and checks out the run branch: this run's branch from
   * the remote when it exists there, else a new one from the default branch.
   * A run branch this run did not create fails with `branch_exists`.
   */
  async prepare(repositories: AssignedRepository[], workDir: string): Promise<Clone[]> {
    const { git, branch } = this.options;
    const clones: Clone[] = [];
    for (const repository of [...repositories].sort((a, b) => a.mergeOrder - b.mergeOrder)) {
      const dir = join(workDir, cloneDirName(repository.key));
      await this.network(`clone ${repository.key}`, async () => {
        await rm(dir, { recursive: true, force: true });
        await git.run(['clone', '--no-recurse-submodules', '--quiet', '--', repository.cloneUrl, dir], {
          cwd: workDir,
          authUrl: repository.cloneUrl,
        });
      });
      const originHead = await git.output(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], dir);
      const defaultBranch = originHead.replace(/^origin\//, '');
      const remoteRunHead =
        (
          await git.run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`], {
            cwd: dir,
            allowFailure: true,
          })
        ).stdout.trim() || null;
      if (remoteRunHead && !repository.branchCreated) {
        throw new TurnFailure(
          'branch_exists',
          `The branch ${branch} already exists in ${repository.key}, and this run did not create it.`,
        );
      }
      await git.run(
        remoteRunHead
          ? ['checkout', '--quiet', '-B', branch, `refs/remotes/origin/${branch}`]
          : ['checkout', '--quiet', '-b', branch],
        { cwd: dir },
      );
      const fresh = await git.output(['config', '--local', '--get-regexp', '^(core|extensions)\\.'], dir);
      clones.push({
        repository,
        dir,
        defaultBranch,
        remoteRunHead,
        configTemplate: configTemplate(fresh, repository.cloneUrl),
      });
    }
    return clones;
  }

  /**
   * Stages every clone under the staging rule, scans the staged change and
   * the outbound commits, commits, and only when no clone blocks, reserves
   * and pushes. A blocked attempt leaves the work trees as the agent left
   * them, with no commit, so the session can fix them and this can run again.
   */
  async publish(clones: Clone[]): Promise<PublishOutcome> {
    const { git, scanner } = this.options;
    const message = join(this.options.tmp, 'commit-message.txt');
    await writeFile(
      message,
      `wip(${this.options.issueKey}): turn ${this.options.turnNumber}\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n`,
    );
    // The session could rewrite anything under .git: restore what git reads before running any.
    for (const clone of clones) await this.restoreGitDir(clone);
    const env = git.env();
    const findings: string[] = [];
    const entries: Array<{ clone: Clone; report: RepositoryReport; before: string; committed: boolean }> = [];

    for (const clone of clones) {
      const { dir, repository } = clone;
      const stage = await stageChanges(git, dir);
      const before = await git.output(['rev-parse', 'HEAD'], dir);
      const report: RepositoryReport = {
        key: repository.key,
        pushedHead: clone.remoteRunHead,
        withheldPaths: stage.withheld,
        workflowDiff: stage.workflowPaths.length ? await this.workflowDiff(clone, stage.workflowPaths, message) : null,
        binaryPaths: [],
      };
      const entry = { clone, report, before, committed: false };
      entries.push(entry);
      if (!stage.staged) continue;

      const staged = await scanner.commit(dir, message, env);
      report.binaryPaths.push(...staged.binaryPaths);
      if (blocksPush(staged)) {
        findings.push(...describeBlock(repository.key, staged));
        continue;
      }
      await git.run(['commit', '--quiet', '--no-verify', '--file', message], { cwd: dir });
      entry.committed = true;
      const outbound = await scanner.push(
        dir,
        clone.defaultBranch,
        this.options.branch,
        git.env(git.authEnv(repository.cloneUrl)),
      );
      if (outbound.reason && REMOTE_MOVED_REASONS.has(outbound.reason)) throw this.pushRejected(repository.key);
      report.binaryPaths.push(...outbound.binaryPaths);
      if (blocksPush(outbound)) findings.push(...describeBlock(repository.key, outbound));
    }
    for (const entry of entries) entry.report.binaryPaths = [...new Set(entry.report.binaryPaths)].sort();

    if (findings.length > 0) {
      for (const { clone, before } of entries) {
        // Back to the agent's work tree: no commit, nothing staged.
        await git.run(['reset', '--quiet', '--mixed', before], { cwd: clone.dir });
      }
      return { kind: 'blocked', findings, reports: entries.map(({ report }) => report) };
    }

    const reports = entries.map(({ report }) => report);
    for (const entry of entries) {
      if (!entry.committed || this.options.stopped()) continue;
      const { clone } = entry;
      if (!clone.repository.branchCreated) {
        await this.options.reserveBranch(clone.repository.key);
        clone.repository.branchCreated = true;
      }
      try {
        await this.push(clone);
      } catch (error) {
        if (error instanceof TurnFailure) return { kind: 'failed', failure: error, reports };
        throw error;
      }
      entry.report.pushedHead = await git.output(['rev-parse', 'HEAD'], clone.dir);
    }
    return { kind: 'published', reports };
  }

  /** Reports for clones that pushed nothing this turn. */
  untouchedReports(clones: Clone[]): RepositoryReport[] {
    return clones.map((clone) => ({
      key: clone.repository.key,
      pushedHead: clone.remoteRunHead,
      withheldPaths: [],
      workflowDiff: null,
      binaryPaths: [],
    }));
  }

  /**
   * The git directory must still be the clone's own directory; its config is
   * replaced by the runner's template, and a planted common-directory pointer
   * is removed. Hooks never run anyway (see Git).
   */
  private async restoreGitDir(clone: Clone): Promise<void> {
    const gitDir = join(clone.dir, '.git');
    const stat = await lstat(gitDir).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new TurnFailure(
        'agent_error',
        `The session replaced the git directory of ${clone.repository.key}, so nothing was pushed.`,
      );
    }
    await rm(join(gitDir, 'commondir'), { force: true, recursive: true });
    await rm(join(gitDir, 'config'), { force: true, recursive: true });
    await writeFile(join(gitDir, 'config'), clone.configTemplate, { flag: 'wx' });
  }

  /** Fast-forward only, to the assigned clone URL itself; a rejection means someone else pushed to the run branch. */
  private async push(clone: Clone): Promise<void> {
    const { git, branch } = this.options;
    const url = clone.repository.cloneUrl;
    await this.network(`push ${clone.repository.key}`, async () => {
      const result = await git.run(['push', '--porcelain', '--no-verify', url, `HEAD:refs/heads/${branch}`], {
        cwd: clone.dir,
        authUrl: url,
        allowFailure: true,
      });
      if (result.code === 0) return;
      const output = `${result.stdout}\n${result.stderr}`;
      if (/\[remote rejected\]/.test(output)) {
        throw new TurnFailure(
          'github_error',
          `GitHub refused the push to ${branch} in ${clone.repository.key}: ${remoteReason(output)}`,
        );
      }
      if (/\[rejected\]|non-fast-forward|fetch first/.test(output)) throw this.pushRejected(clone.repository.key);
      throw new GitError(['push'], result);
    });
  }

  private pushRejected(repository: string): TurnFailure {
    return new TurnFailure(
      'push_rejected',
      `Someone else pushed to ${this.options.branch} in ${repository} during the turn, so the turn's commit was not pushed.`,
    );
  }

  /**
   * The workflow files' diff, staged into a scratch index so the real one is
   * untouched, and offered to a person only when it passes the same secret
   * scan and fits the cap.
   */
  private async workflowDiff(
    clone: Clone,
    paths: string[],
    message: string,
  ): Promise<NonNullable<RepositoryReport['workflowDiff']>> {
    const { git, scanner } = this.options;
    const index = join(this.options.tmp, `workflow-index-${cloneDirName(clone.repository.key)}`);
    await copyFile(join(clone.dir, '.git', 'index'), index);
    const env = { GIT_INDEX_FILE: index };
    try {
      await git.run(['add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul'], {
        cwd: clone.dir,
        input: `${paths.join('\0')}\0`,
        env: { ...env, GIT_LITERAL_PATHSPECS: '1' },
      });
      const scan = await scanner.commit(clone.dir, message, git.env(env));
      if (blocksPush(scan)) {
        return { paths, diff: null, note: 'The secret scan flagged this diff, so only the paths are shown.' };
      }
      const diff = await git.output(
        ['diff', '--cached', '--no-color', '--no-ext-diff', '--', ...paths.map((path) => `:(literal)${path}`)],
        clone.dir,
        env,
      );
      if (Buffer.byteLength(diff, 'utf8') > MAX_WORKFLOW_DIFF_BYTES) {
        return { paths, diff: null, note: 'The diff is larger than 64 KiB, so only the paths are shown.' };
      }
      return { paths, diff, note: null };
    } finally {
      await rm(index, { force: true });
    }
  }

  /** Network git retries in process; a TurnFailure (a rejection) is final. */
  private async network(what: string, call: () => Promise<void>): Promise<void> {
    let last = '';
    for (let attempt = 1; attempt <= GITHUB_ATTEMPTS; attempt += 1) {
      try {
        await call();
        return;
      } catch (error) {
        if (error instanceof TurnFailure) throw error;
        last = error instanceof Error ? error.message : String(error);
        if (attempt < GITHUB_ATTEMPTS) await sleep(this.retryDelay(attempt, null));
      }
    }
    throw new TurnFailure('github_error', `git ${what} kept failing: ${last}`);
  }
}

function remoteReason(output: string): string {
  return /\[remote rejected\][^\n]*/.exec(output)?.[0].slice(0, 300) ?? 'remote rejected';
}
