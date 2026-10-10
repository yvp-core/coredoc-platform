#!/usr/bin/env node
/** Configuration comes from the environment only; the runner holds no server credentials. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeExecutor } from './claude/claude-executor.js';
import { checkClaudeStartup, checkRunnerStartup } from './claude/startup-check.js';
import { GithubApi } from './github/github-api.js';
import { type PackageRegistry, packageRegistries } from './package-registries.js';
import { secretMasker } from './mask-secrets.js';
import { RunnerApiClient } from './runner-api.js';
import { Runner } from './runner.js';
import { RunnerStartupProblemCode } from '@coredoc/core/agent-runner';

// Local development only (set by the dev compose service): a Claude subscription token instead of an API key.
const DEV_SUBSCRIPTION =
  process.env.COREDOC_RUNNER_DEV_SUBSCRIPTION === '1' && Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim());
const REQUIRED = [
  'COREDOC_API_URL',
  'COREDOC_WORKSPACE_ID',
  'COREDOC_RUNNER_TOKEN',
  DEV_SUBSCRIPTION ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY',
  'COREDOC_GITHUB_TOKEN',
  'COREDOC_GIT_AUTHOR_EMAIL',
] as const;
const NOT_CONFIGURED_REMINDER_MS = 5 * 60_000;

/** Read only after the missing-settings wait below, so always set. */
function required(name: (typeof REQUIRED)[number]): string {
  return process.env[name]?.trim() ?? '';
}

function packageVersion(manifestPath: string): string {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string };
  return manifest.version ?? '0.0.0';
}

const require = createRequire(import.meta.url);
const sdkManifest = join(dirname(require.resolve('@anthropic-ai/claude-agent-sdk')), 'package.json');
const log = (message: string) => console.log(`[agent-runner] ${message}`);
const versions = {
  runner: packageVersion(new URL('../package.json', import.meta.url).pathname),
  sdk: packageVersion(sdkManifest),
  // The Claude Code build the SDK bundles; the start-up check asks Claude Code for nothing version-related.
  claudeCode: (JSON.parse(readFileSync(sdkManifest, 'utf8')) as { claudeCodeVersion?: string }).claudeCodeVersion,
};

const scratchRoot = process.env.COREDOC_RUNNER_SCRATCH?.trim() || '/scratch';
const pluginPath = process.env.COREDOC_WORKFLOWS_PLUGIN_PATH?.trim() || '/opt/coredoc-workflows';

const shutdown = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log(`${signal} received; stopping the current turn without pushing or completing it`);
    shutdown.abort();
  });
}

// An unenrolled runner (no token yet) waits instead of exiting, so a restart
// policy does not turn it into a crash loop. Settings are read once: a restart picks up new ones.
const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  const notConfigured = `not configured: ${missing.join(', ')} not set; claiming nothing. Create a runner token in Settings → Agent runs, set the missing variables and restart the runner.`;
  log(notConfigured);
  // Claude Code needs none of these settings, so a host that cannot run it shows up before enrolment.
  const { versions: checked, problem } = await checkClaudeStartup({ query, pluginPath, scratchRoot, versions });
  const mask = secretMasker(
    ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'COREDOC_GITHUB_TOKEN', 'COREDOC_RUNNER_TOKEN'].map((name) =>
      process.env[name]?.trim(),
    ),
  );
  log(
    problem
      ? `Claude Code check failed (${problem.code})${problem.detail ? `: ${mask(problem.detail.trim())}` : ''}`
      : `Claude Code check passed: claude code ${checked.claudeCode ?? '?'}, plugin ${checked.plugin ?? '?'}`,
  );
  const reminder = setInterval(() => log(notConfigured), NOT_CONFIGURED_REMINDER_MS);
  await new Promise((resolve) => shutdown.signal.addEventListener('abort', resolve, { once: true }));
  clearInterval(reminder);
  log('stopped');
  process.exit(0);
}

const botToken = required('COREDOC_GITHUB_TOKEN');
// A GitHub Enterprise Server's is `https://<host>/api/v3`.
const githubApiUrl = process.env.COREDOC_GITHUB_API_URL?.trim() || 'https://api.github.com';
const runnerToken = required('COREDOC_RUNNER_TOKEN');
const modelApiKey = required(DEV_SUBSCRIPTION ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY');
if (DEV_SUBSCRIPTION)
  log(
    'development mode: using a Claude subscription token instead of an API key; never use this outside local testing',
  );
let registries: PackageRegistry[] = [];
// Reported through the start-up check, so settings show it; the runner claims nothing until it is fixed.
let registryProblem: string | null = null;
try {
  registries = packageRegistries(process.env, botToken);
} catch (error) {
  registryProblem = error instanceof Error ? error.message : String(error);
}
const api = new RunnerApiClient({
  baseUrl: required('COREDOC_API_URL'),
  workspaceId: required('COREDOC_WORKSPACE_ID'),
  token: runnerToken,
});
const pollSeconds = Number(process.env.COREDOC_RUNNER_POLL_SECONDS);
const runner = new Runner({
  api,
  ...(Number.isFinite(pollSeconds) && pollSeconds >= 1 ? { idlePollMs: pollSeconds * 1000 } : {}),
  executor: new ClaudeExecutor({
    query,
    api,
    scratchRoot,
    pluginPath,
    modelApiKey,
    modelCredentialKind: DEV_SUBSCRIPTION ? 'subscription' : 'api_key',
    modelBaseUrl: process.env.ANTHROPIC_BASE_URL?.trim() || undefined,
    // A fine-grained token with the Write role only; commits use the bot's no-reply address.
    bot: {
      token: botToken,
      name: process.env.COREDOC_GIT_AUTHOR_NAME?.trim() || 'Coredoc agent',
      email: required('COREDOC_GIT_AUTHOR_EMAIL'),
    },
    hostEnv: process.env,
    packageRegistries: registries,
    log,
  }),
  versions,
  secrets: [modelApiKey, botToken, runnerToken, ...registries.map((registry) => registry.token ?? '')],
  startupCheck: async () =>
    registryProblem
      ? { versions, problem: { code: RunnerStartupProblemCode.RegistryConfigInvalid, detail: registryProblem } }
      : checkRunnerStartup({
          query,
          pluginPath,
          scratchRoot,
          versions,
          github: new GithubApi({ token: botToken }),
          githubApiUrl,
        }),
  log,
});

log(`starting runner ${versions.runner}`);
await runner.start(shutdown.signal);
log('stopped');
