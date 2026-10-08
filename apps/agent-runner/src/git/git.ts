/**
 * The runner's own git, run after the agent's session has exited. It gets an
 * explicit environment, and the bot's token reaches network commands only, as
 * a per-command HTTP authorization header scoped to the assigned clone URL and
 * passed in the environment: never in a remote URL, a config file or the
 * process arguments.
 */
import { spawn } from 'node:child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunOptions {
  cwd: string;
  /** Adds the bot's credentials, scoped to this URL; for clone and push to that exact URL. */
  authUrl?: string;
  /** Written to stdin. */
  input?: string;
  env?: Record<string, string>;
  /** Resolve with the result instead of throwing on a non-zero exit. */
  allowFailure?: boolean;
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly result: GitResult,
  ) {
    super(`git ${args[0]} exited with ${result.code}: ${result.stderr.trim().slice(0, 500)}`);
    this.name = 'GitError';
  }
}

/**
 * Code the agent could plant through repository config never runs in the
 * runner's git: no hooks, no fsmonitor, no credential helpers. The command
 * line wins over every config file. (The clone's config is also rewritten
 * from a runner-written template before any post-session git; see TurnGit.)
 */
const SAFE_CONFIG = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'credential.helper=',
  '-c',
  'protocol.ext.allow=never',
];
const TIMEOUT_MS = 10 * 60_000;

export class Git {
  constructor(
    private readonly baseEnv: Record<string, string>,
    private readonly token: string | null,
  ) {}

  /**
   * The bot's credentials for one URL, for git and for the plugin's push
   * preflight: an authorization header scoped to that URL, never global.
   */
  authEnv(url: string): Record<string, string> {
    if (!this.token) return {};
    const basic = Buffer.from(`x-access-token:${this.token}`).toString('base64');
    return {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: `http.${url}.extraHeader`,
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
      // A redirect must not carry the header to another host; a moved repository fails instead.
      GIT_CONFIG_KEY_1: 'http.followRedirects',
      GIT_CONFIG_VALUE_1: 'false',
    };
  }

  /** The environment of local commands: never the token. */
  env(extra: Record<string, string> = {}): Record<string, string> {
    return { ...this.baseEnv, ...extra };
  }

  async run(args: string[], options: GitRunOptions): Promise<GitResult> {
    const env = this.env({ ...(options.authUrl ? this.authEnv(options.authUrl) : {}), ...options.env });
    const result = await new Promise<GitResult>((resolve, reject) => {
      const child = spawn('git', [...SAFE_CONFIG, ...args], {
        cwd: options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: TIMEOUT_MS,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', reject);
      child.on('close', (code) =>
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        }),
      );
      child.stdin.end(options.input ?? '');
    });
    if (result.code !== 0 && !options.allowFailure) throw new GitError(args, result);
    return result;
  }

  async output(args: string[], cwd: string, env?: Record<string, string>): Promise<string> {
    return (await this.run(args, { cwd, env })).stdout.trim();
  }
}

/** The runner's git environment: the image's PATH, the per-turn home, no system or global config. */
export function gitEnvironment(input: {
  hostEnv: NodeJS.ProcessEnv;
  home: string;
  author: { name: string; email: string };
}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: input.hostEnv.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: input.home,
    LANG: 'C.UTF-8',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: input.author.name,
    GIT_AUTHOR_EMAIL: input.author.email,
    GIT_COMMITTER_NAME: input.author.name,
    GIT_COMMITTER_EMAIL: input.author.email,
  };
  for (const name of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'GIT_SSL_CAINFO',
  ]) {
    const value = input.hostEnv[name];
    if (value) env[name] = value;
  }
  return env;
}
