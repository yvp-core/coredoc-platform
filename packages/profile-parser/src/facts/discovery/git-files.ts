import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { accessSync, constants, lstatSync, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, sep } from 'node:path';

// Repository enumeration must never execute a checkout's configured fsmonitor hook.
const NO_FSMONITOR = ['-c', 'core.fsmonitor=false'];
const GIT_PROBE: ExecFileSyncOptionsWithStringEncoding = {
  encoding: 'utf-8',
  timeout: 30_000,
  stdio: ['ignore', 'pipe', 'pipe'],
};

/** Ignore relative PATH entries and checkout executables before any host-side Git invocation. */
function installedGit(repoRoot: string): string {
  const root = realpathSync(repoRoot);
  const within = (candidate: string) => {
    const rel = relative(root, candidate);
    return !rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)) {
    const candidate = join(directory, process.platform === 'win32' ? 'git.exe' : 'git');
    try {
      const executable = realpathSync(candidate);
      if (within(candidate) || within(executable) || !statSync(executable).isFile()) continue;
      accessSync(executable, constants.X_OK);
      return executable;
    } catch {
      // A missing or unusable entry must not hide an independently installed Git.
    }
  }
  throw new Error('No installed Git executable outside the source repository was found on absolute PATH entries.');
}

/**
 * Enumerate repo-relative source paths via git: tracked (`--cached`) plus untracked-but-not-ignored
 * (`--others --exclude-standard`), so `.gitignore` (including nested) is honored automatically and a
 * user's not-yet-committed file is still seen. Returns null when `repoRoot` is not the root of a git
 * work tree (a non-git checkout, or a subdir of some unrelated parent repo) — the caller falls back
 * to the filesystem walk. `-z` is NUL-delimited so paths with spaces/unicode are exact.
 *
 * Throws when probing or enumeration fails. Null is reserved for "git has no
 * opinion here"; it must not double as "git had an opinion and we lost it", because the caller's
 * walk cannot read `.gitignore` and would silently pull ignored build output into the graph.
 */
export function gitListFiles(repoRoot: string): string[] | null {
  // Git's expected non-repository diagnostic is locale-dependent. Capture it in a stable locale
  // so an operational failure cannot silently switch discovery to an ignore-blind walk.
  const options = { ...GIT_PROBE, env: { ...process.env, LC_ALL: 'C' } };
  let top: string;
  let git: string;
  try {
    git = installedGit(repoRoot);
    top = execFileSync(git, [...NO_FSMONITOR, '-C', repoRoot, 'rev-parse', '--show-toplevel'], options).trim();
  } catch (error) {
    const failure = error as { code?: string; status?: number; signal?: string; stderr?: string | Buffer };
    if (
      !failure.code &&
      !failure.signal &&
      failure.status === 128 &&
      String(failure.stderr).startsWith('fatal: not a git repository (or any ') &&
      // Git emits that same diagnostic for a corrupt HEAD. An existing .git marker is evidence
      // of a checkout even when Git can no longer recognize it (including a broken worktree link).
      !lstatSync(join(repoRoot, '.git'), { throwIfNoEntry: false })
    )
      return null;
    throw new Error(
      `git rev-parse failed in ${repoRoot}; repository status and .gitignore rules could not be established. ` +
        'Check Git availability and repository metadata, then retry.',
      { cause: error },
    );
  }
  // git reports the realpath toplevel; compare via realpath so a symlinked root (macOS
  // `/var`→`/private/var`, or a symlinked checkout) is NOT falsely rejected into the walk.
  if (realpathSync(top) !== realpathSync(repoRoot)) return null; // repoRoot is not its own work-tree root
  try {
    // The budget is deliberately generous: `core.fsmonitor=false` gives up the daemon's speedup on
    // exactly the huge checkouts most likely to approach it, and a slow enumeration is still a
    // correct one. Bounded only so a wedged git cannot hang the parse forever.
    return execFileSync(
      git,
      [...NO_FSMONITOR, '-C', repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { ...options, timeout: 300_000, maxBuffer: 256 * 1024 * 1024 },
    )
      .split('\0')
      .filter(Boolean);
  } catch (error) {
    throw new Error(
      `git ls-files failed in ${repoRoot}, so .gitignore cannot be honored for this checkout. ` +
        'Refusing to enumerate it with an ignore-blind filesystem walk.',
      { cause: error },
    );
  }
}
