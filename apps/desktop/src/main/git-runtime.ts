import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';

interface MacGitRuntime {
  directory: string;
  readPaths: string[];
}

const probeOptions = {
  encoding: 'utf8' as const,
  timeout: 5_000,
  stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
  env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
  cwd: '/',
};

function inspectGit(candidate: string, repoRoot?: string, trustedRoot?: string): MacGitRuntime | undefined {
  try {
    accessSync(candidate, constants.X_OK);
    const executable = realpathSync(candidate);
    // This Apple shim may open the developer-tools installer. Never execute it,
    // including through a symlink earlier in PATH.
    if (executable === '/usr/bin/git' || !statSync(executable).isFile()) return;
    const within = (root: string, target: string) => {
      const relative = path.relative(root, target);
      return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
    };
    if (repoRoot && within(realpathSync(repoRoot), executable)) return;
    // Startup has no repository boundary yet: only known installation roots may be probed.
    if (
      !repoRoot &&
      ![trustedRoot, '/opt/homebrew/Cellar/git', '/usr/local/Cellar/git', '/usr/local/git', '/usr/local/bin'].some(
        (root) => root && within(root, executable),
      )
    )
      return;
    const execPath = execFileSync(executable, ['--exec-path'], probeOptions).trim();
    if (!path.isAbsolute(execPath)) return;
    const directory = path.dirname(path.basename(executable) === 'git' ? executable : candidate);
    const readPaths = [directory, path.dirname(executable), execPath];
    // User-installed Git can live under the otherwise denied home directory.
    // Allow its installation's runtime directories, never the whole home/prefix.
    if (path.basename(execPath) === 'git-core' && ['lib', 'libexec'].includes(path.basename(path.dirname(execPath)))) {
      const prefix = path.dirname(path.dirname(execPath));
      readPaths.push(...['bin', 'lib', 'etc', 'share/git-core'].map((entry) => path.join(prefix, entry)));
    }
    return { directory, readPaths: [...new Set(readPaths.filter(existsSync).map((entry) => realpathSync(entry)))] };
  } catch {
    // An unusable PATH entry must not hide another installed Git.
    return;
  }
}

export function resolveMacGit(sourceEnv: NodeJS.ProcessEnv = process.env, repoRoot?: string): MacGitRuntime {
  const directories = [
    ...(sourceEnv.PATH ?? '').split(path.delimiter).filter((entry) => path.isAbsolute(entry)),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  for (const directory of new Set(directories)) {
    const runtime = inspectGit(path.join(directory, 'git'), repoRoot);
    if (runtime) return runtime;
  }

  // Query only an existing installation; xcrun and /usr/bin/git can trigger
  // Xcode setup even when an independently installed Git is already usable.
  try {
    const developerDir = execFileSync('/usr/bin/xcode-select', ['-p'], probeOptions).trim();
    if (path.isAbsolute(developerDir)) {
      const runtime = inspectGit(path.join(developerDir, 'usr/bin/git'), repoRoot, developerDir);
      if (runtime) return runtime;
    }
  } catch {
    // No selected developer tools. Git itself is the only prerequisite.
  }
  throw new Error(
    'Cannot find a working Git installation. Install Git (for example, brew install git) and restart Coredoc. Xcode command line tools are not required.',
  );
}
