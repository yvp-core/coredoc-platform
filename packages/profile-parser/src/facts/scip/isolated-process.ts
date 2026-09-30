import { systemToolPath } from './system-tools.js';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function canonical(path: string): string {
  const absolute = resolve(path);
  return existsSync(absolute) ? realpathSync(absolute) : join(canonical(dirname(absolute)), basename(absolute));
}

export function outsideSource(repoRoot: string, path: string): string {
  const root = realpathSync(repoRoot);
  const destination = canonical(path);
  const rel = relative(root, destination);
  const reverse = relative(destination, root);
  if (
    !rel ||
    (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)) ||
    (!reverse.startsWith(`..${sep}`) && reverse !== '..' && !isAbsolute(reverse))
  )
    throw new Error('Analysis tool state and indexing output must be outside the source repository.');
  return destination;
}

export interface IsolatedProcessOptions {
  label: string;
  macPolicy?: string[];
  cwd: string;
  writeRoots: string[];
  readRoots: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  sourceRoot?: string;
  /** Selected repository-relative inputs exposed at their original paths, read-only. */
  sourceFiles?: string[];
  failOnOutput?: RegExp;
  signal?: AbortSignal;
  onLog?: (text: string) => void;
  allowNetwork?: boolean;
}

function quoted(path: string, resolveLinks = true): string {
  if (/[\0\r\n]/.test(path)) throw new Error('Invalid analysis sandbox path.');
  return JSON.stringify(resolveLinks ? canonical(path) : resolve(path));
}

/** Restore targets are executable project input; filesystem isolation also covers their children. */
export async function runIsolatedProcess(
  command: string,
  args: string[],
  options: IsolatedProcessOptions,
): Promise<string> {
  options.signal?.throwIfAborted();
  const cwd = canonical(options.cwd);
  const writes = options.writeRoots.map(canonical);
  if (options.sourceRoot) for (const path of writes) outsideSource(options.sourceRoot, path);
  if (options.sourceRoot) for (const path of options.readRoots) outsideSource(options.sourceRoot, path);
  const reads = [...new Set([...options.readRoots.map(canonical), ...writes])];
  const source = options.sourceRoot ? canonical(options.sourceRoot) : undefined;
  const sourceFiles = (options.sourceFiles ?? []).map((file) => {
    if (!source || !file || file === '.' || isAbsolute(file) || file.split(/[\\/]/).includes('..'))
      throw new Error('Invalid read-only source path.');
    const path = join(source, file);
    // Refuse symlinks, including a checkout edit between fingerprinting and spawning.
    if (canonical(path) !== path) throw new Error(`Indexing does not follow source symbolic links: ${file}`);
    return path;
  });
  const sourceDirectories = new Set<string>();
  if (source && options.sourceFiles) {
    sourceDirectories.add(source);
    for (const file of sourceFiles) {
      for (let parent = dirname(file); parent !== source; parent = dirname(parent)) sourceDirectories.add(parent);
    }
  }
  // dyld checks both the install-name alias and its canonical target (Homebrew opt symlinks).
  const readPaths = [...new Set([...reads, ...options.readRoots.map((p) => resolve(p))])];
  // Runtimes realpath their permitted files one parent at a time. Expose only those
  // directory metadata entries, not metadata for unrelated home/source files.
  const ancestors = new Set<string>();
  for (const root of [...readPaths, ...sourceDirectories]) {
    for (let parent = dirname(root); parent !== dirname(parent); parent = dirname(parent)) ancestors.add(parent);
  }
  let executable: string;
  let arguments_: string[];
  let launcherFiles: string | undefined;
  let launcherInput: Buffer | undefined;
  if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    const policy = [
      '(version 1)',
      '(deny default)',
      '(allow process*)',
      '(allow sysctl-read)',
      // Process queries can pass either sysctl or process-info checks; both must deny other PIDs.
      '(deny sysctl-read (sysctl-name-prefix "kern.proc"))',
      '(deny process-info*)',
      '(allow process-info* (target self))',
      // exec/dyld needs access to the root directory vnode, not its descendants.
      '(allow file-read* (literal "/"))',
      // Node realpaths the public macOS aliases before opening permitted /private/... files.
      '(allow file-read* (literal "/var") (literal "/tmp") (literal "/etc"))',
      // Compilers need system runtimes, not arbitrary host data or user Mach services.
      // Trust evaluation is needed for HTTPS; other Mach-service lookups stay denied.
      ...(options.allowNetwork ? ['(allow mach-lookup (global-name "com.apple.trustd"))'] : []),
      ...[
        '/bin',
        '/sbin',
        '/usr/bin',
        '/usr/sbin',
        '/usr/lib',
        '/usr/libexec',
        '/usr/share',
        '/System/Library',
        '/System/Volumes/Preboot/Cryptexes/OS',
        '/Library/Developer/CommandLineTools',
        '/Applications/Xcode.app/Contents/Developer',
        '/private/etc/ssl',
        '/private/var/db/timezone',
      ]
        .filter(existsSync)
        .map((p) => `(allow file-read* (subpath ${quoted(p)}))`),
      ...[
        '/dev/null',
        '/dev/random',
        '/dev/urandom',
        '/private/etc/localtime',
        '/private/etc/hosts',
        '/private/etc/resolv.conf',
      ]
        .filter(existsSync)
        .map((p) => `(allow file-read* (literal ${quoted(p)}))`),
      ...readPaths.map((p) => `(allow file-read* (subpath ${quoted(p, false)}))`),
      ...[...ancestors].map((p) => `(allow file-read-metadata (literal ${quoted(p)}))`),
      ...writes.map((p) => `(allow file-write* (subpath ${quoted(p)}))`),
      '(allow file-write* (literal "/dev/null"))',
      // Dependency downloads need IP traffic, never the host's SSH/Docker Unix sockets.
      ...(options.allowNetwork
        ? [
            '(allow network-outbound (remote ip))',
            // macOS DNS uses this system socket; no other host Unix socket is permitted.
            '(allow network-outbound (literal "/private/var/run/mDNSResponder"))',
            '(deny network-outbound (remote ip "localhost:*"))',
          ]
        : []),
      ...(options.macPolicy ?? []),
      ...(options.sourceRoot ? [`(deny file-read* file-write* (subpath ${quoted(options.sourceRoot)}))`] : []),
      ...[...sourceDirectories, ...sourceFiles].map((p) => `(allow file-read* (literal ${quoted(p, false)}))`),
    ].join('\n');
    executable = '/usr/bin/sandbox-exec';
    // Large repositories exceed exec's argument limit when the policy is passed inline.
    launcherFiles = mkdtempSync(join(tmpdir(), 'coredoc-sandbox-'));
    const policyPath = join(launcherFiles, 'policy.sb');
    writeFileSync(policyPath, policy);
    arguments_ = ['-f', policyPath, command, ...args];
  } else if (process.platform === 'linux') {
    // Start empty: mounting / read-only still exposes runner credentials and sibling checkouts.
    // Bind the resolver's contents at /etc/resolv.conf, so systemd's /run symlink cannot dangle.
    // Resolve the launcher independently of the tool's intentionally restricted PATH.
    executable = systemToolPath('bwrap');
    const systemReads = [
      '/usr',
      '/bin',
      '/sbin',
      '/lib',
      '/lib64',
      '/etc/ssl',
      '/etc/ca-certificates',
      '/etc/hosts',
      '/etc/resolv.conf',
      '/etc/nsswitch.conf',
      '/etc/passwd',
      '/etc/group',
      '/etc/localtime',
      '/etc/alternatives',
      '/etc/ld.so.cache',
    ].filter(existsSync);
    const sourceMasks = new Set<string>();
    if (options.sourceRoot) {
      const source = canonical(options.sourceRoot);
      sourceMasks.add(source);
      // /bin and /lib can be independent bind aliases of /usr/bin and /usr/lib.
      for (const destination of systemReads) {
        const rel = relative(canonical(destination), source);
        if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) sourceMasks.add(join(destination, rel));
      }
    }
    arguments_ = [
      '--die-with-parent',
      '--unshare-all',
      ...(options.allowNetwork ? ['--share-net'] : []),
      '--tmpfs',
      '/',
      '--tmpfs',
      '/tmp',
      '--tmpfs',
      '/var/tmp',
      ...systemReads.flatMap((p) => ['--ro-bind', canonical(p), p]),
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      ...readPaths.filter((p) => !writes.includes(p)).flatMap((p) => ['--ro-bind', canonical(p), p]),
      ...writes.flatMap((p) => ['--bind', p, p]),
      // System binds can include the checkout (e.g. /usr/src/app). Mask it after every grant.
      ...[...sourceMasks].flatMap((p) => ['--tmpfs', p]),
      ...sourceFiles.flatMap((p) => ['--ro-bind', p, p]),
      ...[...sourceMasks].flatMap((p) => ['--remount-ro', p]),
      '--chdir',
      cwd,
    ];
    // File bind lists for a monorepo can exceed exec's argument limit too.
    launcherInput = Buffer.from(`${arguments_.join('\0')}\0`);
    arguments_ = ['--args', '0', '--', command, ...args];
  } else {
    throw new Error(
      'Enhanced analysis requires macOS sandbox-exec or Linux bubblewrap to protect the source repository.',
    );
  }
  return new Promise<string>((resolveResult, reject) => {
    const child = spawn(executable, arguments_, {
      cwd,
      env: options.env ?? { PATH: process.env.PATH, HOME: cwd, TMPDIR: cwd },
      stdio: 'pipe',
      detached: true,
    });
    child.stdin?.on('error', () => {
      /* spawn/exit handlers report launcher failures */
    });
    child.stdin?.end(launcherInput);
    let output = '';
    let timedOut = false;
    let reportedFailure = false;
    let exited = false;
    let settled = false;
    let drainTimeout: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      // After exit the PID/process group may have been reused; only pipes remain ours.
      if (!exited && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    };
    options.signal?.addEventListener('abort', kill, { once: true });
    if (options.signal?.aborted) kill();
    const collect = (chunk: Buffer) => {
      options.onLog?.(chunk.toString());
      const next = output + chunk.toString();
      if (options.failOnOutput?.test(next)) reportedFailure = true;
      output = next.slice(-128 * 1024);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timeout = setTimeout(
      () => {
        timedOut = true;
        kill();
      },
      options.timeoutMs ?? 10 * 60_000,
    );
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(drainTimeout);
      options.signal?.removeEventListener('abort', kill);
    };
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Cannot start isolated ${options.label} tooling: ${error.message}`));
    });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (options.signal?.aborted) reject(options.signal.reason);
      else if (code === 0 && !timedOut && !reportedFailure) resolveResult(output);
      else
        reject(
          new Error(
            `Isolated ${options.label} tooling ${timedOut ? 'timed out' : reportedFailure ? 'reported a build/index error' : `exited with ${code}`}: ${output.slice(-8000)}`,
          ),
        );
    };
    child.on('exit', (code) => {
      exited = true;
      clearTimeout(timeout);
      if (settled) return;
      // Tool descendants can inherit the pipes beyond their parent's lifetime.
      // Drain pending diagnostics, but do not turn that successful exit into a timeout.
      drainTimeout = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code);
      }, 1000);
    });
    child.on('close', finish);
  }).finally(() => {
    if (launcherFiles) rmSync(launcherFiles, { recursive: true, force: true });
  });
}
