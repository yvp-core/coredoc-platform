import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { CSharpIndexResponse } from '@coredoc/profile-parser/csharp';
import type { Readable } from 'node:stream';
import { canonicalPath } from './canonical-path.js';
import type { WorkerMessage } from './sdk-worker-core.js';
import { createRuntimeLogFilter } from './runtime-log.js';
import { resolveMacGit } from './git-runtime.js';

export interface MacParseSandboxPolicy {
  homeDir: string;
  readPaths: string[];
  readFiles: string[];
  writePaths: string[];
  writeFiles: string[];
  temporaryDir: string;
  deniedReadPaths: string[];
}

export interface SandboxedParseEnvironmentOptions {
  sourceEnv: NodeJS.ProcessEnv;
  nodeExecutable: string;
  runtimeBinDirs: string[];
  temporaryDir: string;
  databaseUrl: string;
}

export interface SandboxedParseResultMessage {
  type: 'result';
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface ProfileScoreMessage {
  command: 'score-profile';
  profilePath: string;
  repoRoot: string;
}

export interface SandboxedParseLaunchOptions {
  repoRoot?: string;
  nodeExecutable: string;
  childScript: string;
  sourceEnv: NodeJS.ProcessEnv;
  runtimeBinDirs: string[];
  databaseUrl: string;
  homeDir: string;
  readPaths: string[];
  readFiles: string[];
  writePaths: string[];
  writeFiles: string[];
  deniedReadPaths: string[];
  message: WorkerMessage | ProfileScoreMessage;
  prepareCSharpIndex?: (request: unknown) => Promise<CSharpIndexResponse>;
  prepareOptionalIndex?: (request: unknown) => Promise<CSharpIndexResponse>;
  onLog: (text: string) => void;
  onResult: (message: SandboxedParseResultMessage) => void;
  onError: (error: Error) => void;
  onClose: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface SandboxedParseHandle {
  terminate(): void;
}

export function resolveSandboxExecutable(executable: string, sourceEnv: NodeJS.ProcessEnv): string {
  const candidates = path.isAbsolute(executable)
    ? [executable]
    : (sourceEnv.PATH ?? '')
        .split(path.delimiter)
        .filter(Boolean)
        .map((entry) => path.join(entry, executable));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      const canonical = canonicalPath(candidate);
      if (canonical) return canonical;
    } catch {
      // Continue to the next PATH entry.
    }
  }
  throw new Error(`Cannot resolve the parse runtime executable "${executable}".`);
}

function canonicalPolicyPath(candidate: string): string {
  const resolved = canonicalPath(candidate);
  if (!resolved) {
    throw new Error(`Cannot establish a canonical parse-sandbox path for ${candidate}`);
  }
  return resolved;
}

function uniqueCanonicalPaths(paths: string[]): string[] {
  return [...new Set(paths.map(canonicalPolicyPath))];
}

function sandboxString(value: string): string {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error('Parse-sandbox paths cannot contain NUL or newline characters.');
  }
  return JSON.stringify(value);
}

function subpathRule(effect: 'allow' | 'deny', operation: 'file-read*' | 'file-write*', value: string): string {
  return `(${effect} ${operation} (subpath ${sandboxString(value)}))`;
}

function literalRule(effect: 'allow' | 'deny', operation: 'file-read*' | 'file-write*', value: string): string {
  return `(${effect} ${operation} (literal ${sandboxString(value)}))`;
}

/**
 * Build the macOS Seatbelt policy for importing and executing a generated extraction profile.
 *
 * Node and native parser dependencies need broad access to signed system runtime files, so the
 * policy starts with file reads enabled, removes user-controlled storage, and then carves back
 * only the canonical repository/runtime roots required by this parse. The final credential-name
 * rules win over those carve-outs, including when the repository itself contains a `.env`.
 */
export function buildMacParseSandboxProfile(policy: MacParseSandboxPolicy): string {
  const homeDir = canonicalPolicyPath(policy.homeDir);
  const temporaryDir = canonicalPolicyPath(policy.temporaryDir);
  const readPaths = uniqueCanonicalPaths([...policy.readPaths, temporaryDir]);
  const readFiles = uniqueCanonicalPaths(policy.readFiles);
  const writePaths = uniqueCanonicalPaths([...policy.writePaths, temporaryDir]);
  const writeFiles = uniqueCanonicalPaths(policy.writeFiles);
  const deniedReadPaths = uniqueCanonicalPaths(policy.deniedReadPaths);

  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    // Process queries can pass either sysctl or process-info checks; both must deny other PIDs.
    '(deny sysctl-read (sysctl-name-prefix "kern.proc"))',
    '(deny process-info*)',
    '(allow process-info* (target self))',
    // Profiles use local parser runtimes only; host Mach services expose user data.
    // No service exception is needed because this process has no network access.
    '(allow file-read-metadata)',
    // System frameworks, dynamic libraries, and root-owned command-line tools remain readable.
    // User data is removed below before the per-run roots are added back.
    '(allow file-read*)',
    subpathRule('deny', 'file-read*', homeDir),
    subpathRule('deny', 'file-read*', '/Users'),
    subpathRule('deny', 'file-read*', '/Volumes'),
    subpathRule('deny', 'file-read*', '/private/tmp'),
    subpathRule('deny', 'file-read*', '/private/var/folders'),
    ...readPaths.map((value) => subpathRule('allow', 'file-read*', value)),
    ...readFiles.map((value) => literalRule('allow', 'file-read*', value)),
    ...deniedReadPaths.map((value) => literalRule('deny', 'file-read*', value)),
    // Provider/workspace credentials stay unavailable even inside an otherwise readable repo.
    '(deny file-read* (regex #".*/\\.env(\\..*)?$"))',
    '(deny file-read* (regex #".*/\\.(npmrc|netrc|git-credentials|pypirc)$"))',
    '(deny file-read* (regex #".*/\\.docker/config\\.json$"))',
    ...writePaths.map((value) => subpathRule('allow', 'file-write*', value)),
    ...writeFiles.map((value) => literalRule('allow', 'file-write*', value)),
    // Git opens /dev/null read/write even for read-only repository discovery.
    '(allow file-write* (literal "/dev/null"))',
    '(deny network*)',
  ];

  return lines.join('\n');
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

/** Build the complete environment for the sandbox child; ambient values are never spread. */
export function buildSandboxedParseEnvironment(options: SandboxedParseEnvironmentOptions): NodeJS.ProcessEnv {
  const runtimeBinDirs = [
    path.dirname(path.resolve(options.nodeExecutable)),
    ...options.runtimeBinDirs.map((entry) => path.resolve(entry)),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
  const safePath = [...new Set(runtimeBinDirs)].join(path.delimiter);
  const environment: NodeJS.ProcessEnv = {
    PATH: safePath,
    HOME: options.temporaryDir,
    TMPDIR: options.temporaryDir,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    // Always sqlite regardless of the app's graph backend: the sandboxed child only
    // writes the parsed-repo JSON plus operations rows, and operations are sqlite on
    // every backend (opsOnlyDriver). No graph repository is opened in here.
    COREDOC_DB_BACKEND: 'sqlite',
    COREDOC_SQLITE_URL: options.databaseUrl,
    COREDOC_TELEMETRY_DISABLED: '1',
  };

  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'COREDOC_RUNTIME_MODULES',
    'COREDOC_TREESITTER_WASM_DIR',
    'COREDOC_PROFILE_SCHEMA_DIR',
    'COREDOC_DESKTOP_E2E',
    'ALLOW_SOURCES_IN_GRAPH',
    'ENABLE_SEMANTIC_SEARCH',
  ] as const) {
    const value = nonEmpty(options.sourceEnv[key]);
    if (value) environment[key] = value;
  }

  return environment;
}

function removeRunDirectory(runDirectory: string): void {
  const canonicalParent = canonicalPath(tmpdir());
  const canonicalRun = canonicalPath(runDirectory);
  if (
    !canonicalParent ||
    !canonicalRun ||
    path.dirname(canonicalRun) !== canonicalParent ||
    !path.basename(canonicalRun).startsWith('coredoc-profile-parse-')
  ) {
    return;
  }
  rmSync(canonicalRun, { recursive: true, force: true });
}

function terminateProcessGroup(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

/** Launch one parse in a separate Seatbelt-confined process. */
export function spawnSandboxedParse(options: SandboxedParseLaunchOptions): SandboxedParseHandle {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) {
    throw new Error('Generated profile parsing requires the supported macOS sandbox runtime.');
  }

  const git = resolveMacGit(options.sourceEnv, options.repoRoot);
  const runDirectory = mkdtempSync(path.join(tmpdir(), 'coredoc-profile-parse-'));
  const profile = buildMacParseSandboxProfile({
    homeDir: options.homeDir,
    readPaths: [...options.readPaths, ...git.readPaths],
    readFiles: options.readFiles,
    writePaths: options.writePaths,
    writeFiles: options.writeFiles,
    temporaryDir: runDirectory,
    deniedReadPaths: options.deniedReadPaths,
  });
  const environment = buildSandboxedParseEnvironment({
    sourceEnv: options.sourceEnv,
    nodeExecutable: options.nodeExecutable,
    runtimeBinDirs: [git.directory, ...options.runtimeBinDirs],
    temporaryDir: runDirectory,
    databaseUrl: options.databaseUrl,
  });
  // The child's cwd MUST be a policy-allowed path: getcwd(3) fails with EPERM when the working
  // directory itself is denied file-read* (libuv surfaces it as "EPERM ..., uv_cwd" on the first
  // process.cwd() call). The run directory is the one root this policy always allows.
  const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, options.nodeExecutable, options.childScript], {
    cwd: runDirectory,
    env: environment,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'ipc'],
  });

  let killTimer: NodeJS.Timeout | undefined;
  let closed = false;
  const terminate = () => {
    if (killTimer || closed) return;
    terminateProcessGroup(child);
    killTimer = setTimeout(() => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, 1_000);
    killTimer.unref();
  };

  // The IPC endpoint is untrusted just like the profile. The host adapter validates
  // data and fixes all filesystem/executable roots before accepting a request.
  let requests = 0;
  let queue = Promise.resolve();
  child.on('message', (raw: unknown) => {
    const message = raw as { type?: string; id?: unknown; request?: unknown };
    if (!['csharp-index', 'optional-index'].includes(message?.type ?? '') || !Number.isSafeInteger(message.id)) return;
    const replyType = `${message.type}-result`;
    const prepare = message.type === 'optional-index' ? options.prepareOptionalIndex : options.prepareCSharpIndex;
    if (++requests > 64) {
      if (child.connected) child.send({ type: replyType, id: message.id, error: 'Too many compiler requests.' });
      options.onError(new Error('Too many compiler requests from profile sandbox.'));
      terminate();
      return;
    }
    queue = queue.then(async () => {
      if (closed || requests > 64) return;
      try {
        if (!prepare) throw new Error('Desktop compiler preparation is unavailable.');
        const result = await prepare(message.request);
        if (child.connected) child.send({ type: replyType, id: message.id, result });
      } catch (error) {
        options.onLog(`Analysis: ${error instanceof Error ? error.message : String(error)}\n`);
        if (child.connected)
          child.send({
            type: replyType,
            id: message.id,
            error:
              error instanceof Error && error.name === 'AbortError'
                ? 'Analysis cancelled.'
                : 'Compiler preparation failed. See the analysis log for details.',
            cancelled: error instanceof Error && error.name === 'AbortError',
          });
      }
    });
  });

  let protocolBuffer = '';
  const protocol = child.stdio[3] as Readable;
  protocol.setEncoding('utf8');
  protocol.on('error', (error) => {
    options.onError(error);
    terminate();
  });
  protocol.on('data', (chunk: string) => {
    protocolBuffer += chunk;
    while (true) {
      const newline = protocolBuffer.indexOf('\n');
      if (newline < 0) break;
      const frame = protocolBuffer.slice(0, newline).trim();
      protocolBuffer = protocolBuffer.slice(newline + 1);
      if (!frame) continue;
      try {
        const parsed = JSON.parse(frame) as SandboxedParseResultMessage;
        if (parsed.type !== 'result' || typeof parsed.success !== 'boolean') {
          throw new Error('unexpected protocol message');
        }
        options.onResult(parsed);
      } catch (error) {
        options.onError(
          new Error(`Invalid sandboxed parse response: ${error instanceof Error ? error.message : String(error)}`),
        );
      }
    }
  });
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => options.onLog(chunk));
  const stderrFilter = createRuntimeLogFilter();
  child.stderr?.on('data', (chunk: string) => {
    const cleaned = stderrFilter.push(chunk);
    if (cleaned) options.onLog(cleaned);
  });
  const flushStderr = (): void => {
    const remainder = stderrFilter.flush();
    if (remainder) options.onLog(remainder);
  };
  child.stderr?.on('end', flushStderr);
  child.on('error', options.onError);
  child.on('close', (code, signal) => {
    closed = true;
    if (killTimer) clearTimeout(killTimer);
    // A forcibly killed child may close without an `end` event on stderr. Flush is idempotent,
    // so this preserves a trailing real diagnostic on both graceful and hard-kill paths.
    flushStderr();
    removeRunDirectory(runDirectory);
    options.onClose(code, signal);
  });
  child.stdin?.on('error', (error) => options.onError(error));
  child.stdin?.end(JSON.stringify(options.message));

  return { terminate };
}
