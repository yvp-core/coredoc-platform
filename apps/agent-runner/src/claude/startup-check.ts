/**
 * Uses the control protocol's initialize answer: no prompt and no model call (Claude Code sends its
 * init message only after a first user message). Plugin load errors surface in each session's init.
 */
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  CORE_PLUGIN_NAME,
  type ResolvedManifest,
  RunnerStartupProblemCode,
  type RunnerVersions,
} from '@coredoc/core/agent-runner';
import type { GithubApi } from '../github/github-api.js';
import { readPluginManifest, sdkPlugins } from '../manifest.js';
import type { StartupProblem, StartupReport } from '../runner.js';

export type StartupQueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
  initializationResult(): Promise<{ commands?: Array<{ name: string }> }>;
};

export interface StartupCheckOptions {
  query: StartupQueryFn;
  manifest: ResolvedManifest;
  manifestDigest: string | null;
  scannerPluginPath: string;
  scratchRoot: string;
  versions: RunnerVersions;
  timeoutMs?: number;
}

export async function checkClaudeStartup(options: StartupCheckOptions): Promise<StartupReport> {
  const { manifest } = options;
  const scanner = await readPluginManifest(options.scannerPluginPath);
  if (!scanner) {
    return {
      versions: options.versions,
      problem: {
        code: RunnerStartupProblemCode.PluginMissing,
        detail: `No plugin manifest at ${options.scannerPluginPath}, the secret scanner's plugin.`,
      },
    };
  }
  const launcher = join(options.scannerPluginPath, 'bin', 'coredoc-workflows');
  try {
    await access(launcher, constants.X_OK);
  } catch {
    return {
      versions: options.versions,
      problem: { code: RunnerStartupProblemCode.PluginMissing, detail: `No executable secret scanner at ${launcher}.` },
    };
  }
  const plugins: Array<{ name: string; version?: string }> = [];
  for (const { path } of manifest.plugins) {
    const plugin = await readPluginManifest(path);
    if (!plugin) {
      return {
        versions: options.versions,
        problem: { code: RunnerStartupProblemCode.PluginMissing, detail: `No plugin manifest at ${path}.` },
      };
    }
    plugins.push(plugin);
  }
  const { scope, implement } = manifest.phases;
  // A phase without an entry skill follows the default prompts, which run coredoc-workflows routes.
  if (!plugins.some((plugin) => plugin.name === CORE_PLUGIN_NAME) && !(scope.entrySkill && implement.entrySkill)) {
    return {
      versions: options.versions,
      problem: {
        code: RunnerStartupProblemCode.ManifestInvalid,
        detail: `The runner manifest loads no ${CORE_PLUGIN_NAME} plugin, so every phase needs an entry skill.`,
      },
    };
  }
  const versions: RunnerVersions = {
    ...options.versions,
    ...(scanner.version ? { plugin: scanner.version } : {}),
    // Only a manifest file is reported: the defaults are what the other versions already say.
    ...(options.manifestDigest
      ? {
          manifest: {
            digest: options.manifestDigest,
            models: { scope: scope.model, implement: implement.model },
            plugins: plugins.map(({ name, version }) => ({ name, version })),
          },
        }
      : {}),
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
        plugins: sdkPlugins(manifest),
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
    problem = skillsProblem(
      (init.commands ?? []).map((command) => command.name),
      plugins,
      [scope.entrySkill, implement.entrySkill].filter((skill) => skill !== undefined),
    );
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

function skillsProblem(
  listed: string[],
  plugins: Array<{ name: string }>,
  entrySkills: string[],
): StartupProblem | null {
  const withoutSkills = plugins.find((plugin) => !listed.some((name) => name.startsWith(`${plugin.name}:`)));
  if (withoutSkills) {
    return {
      code: RunnerStartupProblemCode.PluginSkillsMissing,
      detail: `Claude Code lists no skills from the plugin ${withoutSkills.name}.`,
    };
  }
  const missingEntry = entrySkills.find((skill) => !listed.includes(skill));
  if (missingEntry) {
    return {
      code: RunnerStartupProblemCode.PluginSkillsMissing,
      detail: `Claude Code does not list the manifest entry skill ${missingEntry}.`,
    };
  }
  return null;
}

export async function checkRunnerStartup(
  options: StartupCheckOptions & { github: GithubApi; githubApiUrl: string },
): Promise<StartupReport> {
  const report = await checkClaudeStartup(options);
  if (report.problem) return report;
  return { ...report, problem: await options.github.botAccountProblem(options.githubApiUrl) };
}
