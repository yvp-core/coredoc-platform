/**
 * Uses the control protocol's initialize answer: no prompt and no model call (Claude Code sends its
 * init message only after a first user message). Plugin load errors surface in each session's init.
 */
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { RunnerStartupProblemCode, type RunnerVersions } from '@coredoc/core/agent-runner';
import type { GithubApi } from '../github/github-api.js';
import type { StartupProblem, StartupReport } from '../runner.js';

export type StartupQueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
  initializationResult(): Promise<{ commands?: Array<{ name: string }> }>;
};

export interface StartupCheckOptions {
  query: StartupQueryFn;
  pluginPath: string;
  scratchRoot: string;
  versions: RunnerVersions;
  timeoutMs?: number;
}

async function pluginManifest(pluginPath: string): Promise<{ name: string; version?: string } | null> {
  try {
    const manifest = JSON.parse(await readFile(join(pluginPath, '.claude-plugin', 'plugin.json'), 'utf8'));
    return typeof manifest?.name === 'string' ? manifest : null;
  } catch {
    return null;
  }
}

export async function checkClaudeStartup(options: StartupCheckOptions): Promise<StartupReport> {
  const manifest = await pluginManifest(options.pluginPath);
  if (!manifest) {
    return {
      versions: options.versions,
      problem: { code: RunnerStartupProblemCode.PluginMissing, detail: `No plugin manifest at ${options.pluginPath}.` },
    };
  }
  const versions: RunnerVersions = {
    ...options.versions,
    ...(manifest.version ? { plugin: manifest.version } : {}),
  };
  const timeoutMs = options.timeoutMs ?? 60_000;
  const abort = new AbortController();
  await mkdir(options.scratchRoot, { recursive: true });
  const dir = await mkdtemp(join(options.scratchRoot, 'startup-'));
  await mkdir(join(dir, 'claude'), { recursive: true });
  await mkdir(join(dir, 'tmp'), { recursive: true });
  const silent: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise((resolve) =>
          abort.signal.addEventListener('abort', () => resolve({ done: true, value: undefined })),
        ),
    }),
  };
  const timeout = setTimeout(() => abort.abort(), timeoutMs);
  let problem: StartupProblem | null;
  try {
    const session = options.query({
      prompt: silent,
      options: {
        cwd: dir,
        settingSources: [],
        plugins: [{ type: 'local', path: options.pluginPath }],
        tools: [],
        canUseTool: async () => ({ behavior: 'deny', message: 'The start-up check runs no tools.' }),
        abortController: abort,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: dir,
          // The root filesystem is read-only in the pod; Claude Code otherwise writes under /tmp.
          TMPDIR: join(dir, 'tmp'),
          CLAUDE_CONFIG_DIR: join(dir, 'claude'),
          DISABLE_AUTOUPDATER: '1',
        },
      },
    });
    // Bounded by the timeout even if the SDK's promise ignores the abort.
    const timedOut = new Promise<never>((_, reject) =>
      abort.signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true }),
    );
    const init = await Promise.race([session.initializationResult(), timedOut]);
    const skills = (init.commands ?? []).filter((command) => command.name.startsWith(`${manifest.name}:`));
    problem = skills.length
      ? null
      : {
          code: RunnerStartupProblemCode.PluginSkillsMissing,
          detail: `Claude Code lists no skills from the plugin ${manifest.name}.`,
        };
  } catch (error) {
    problem = {
      code: RunnerStartupProblemCode.SdkUnusable,
      detail: abort.signal.aborted
        ? `Claude Code did not initialise within ${Math.round(timeoutMs / 1000)} s.`
        : error instanceof Error
          ? error.message
          : String(error),
    };
  } finally {
    clearTimeout(timeout);
    abort.abort();
    await rm(dir, { recursive: true, force: true });
  }
  return { versions, problem };
}

export async function checkRunnerStartup(
  options: StartupCheckOptions & { github: GithubApi; githubApiUrl: string },
): Promise<StartupReport> {
  const report = await checkClaudeStartup(options);
  if (report.problem) return report;
  return { ...report, problem: await options.github.botAccountProblem(options.githubApiUrl) };
}
