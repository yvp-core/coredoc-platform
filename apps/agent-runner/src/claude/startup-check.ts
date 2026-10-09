/**
 * The runner's start-up check: start Claude Code through the SDK with the
 * plugin, read what loaded, and stop before any model call (the prompt is a
 * stream that never sends a message). The runner claims nothing until it passes.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RunnerVersions } from '@coredoc/core/agent-runner';
import type { GithubApi } from '../github/github-api.js';
import type { StartupProblem, StartupReport } from '../runner.js';
import { pluginProblem } from './claude-executor.js';

/** The SDK's `query`, as the check calls it: a streaming prompt that sends nothing. */
export type StartupQueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AsyncIterable<SDKMessage>;

export interface StartupCheckOptions {
  query: StartupQueryFn;
  pluginPath: string;
  scratchRoot: string;
  versions: RunnerVersions;
  timeoutMs?: number;
}

export async function checkClaudeStartup(options: StartupCheckOptions): Promise<StartupReport> {
  const abort = new AbortController();
  await mkdir(options.scratchRoot, { recursive: true });
  const dir = await mkdtemp(join(options.scratchRoot, 'startup-'));
  await mkdir(join(dir, 'claude'), { recursive: true });
  const silent: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise((resolve) =>
          abort.signal.addEventListener('abort', () => resolve({ done: true, value: undefined })),
        ),
    }),
  };
  const timeout = setTimeout(() => abort.abort(), options.timeoutMs ?? 60_000);
  let versions: RunnerVersions = options.versions;
  let problem: StartupProblem | null = { code: 'sdk_unusable', detail: 'Claude Code sent no init message' };
  try {
    for await (const message of options.query({
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
          CLAUDE_CONFIG_DIR: join(dir, 'claude'),
          DISABLE_AUTOUPDATER: '1',
        },
      },
    })) {
      if (message.type === 'system' && message.subtype === 'init') {
        const plugin = message.plugins?.find((candidate) => candidate.version);
        versions = {
          ...versions,
          claudeCode: message.claude_code_version,
          ...(plugin?.version ? { plugin: plugin.version } : {}),
        };
        problem = pluginProblem(message, options.pluginPath);
        break;
      }
    }
  } catch (error) {
    problem = { code: 'sdk_unusable', detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
    abort.abort();
    await rm(dir, { recursive: true, force: true });
  }
  return { versions, problem };
}

/**
 * Every start-up check: Claude Code and the plugin, then the bot account,
 * which must not be an admin or maintainer of any repository it can see.
 */
export async function checkRunnerStartup(
  options: StartupCheckOptions & { github: GithubApi; githubApiUrl: string },
): Promise<StartupReport> {
  const report = await checkClaudeStartup(options);
  if (report.problem) return report;
  return { ...report, problem: await options.github.botAccountProblem(options.githubApiUrl) };
}
