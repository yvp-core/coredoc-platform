#!/usr/bin/env node
/** Configuration comes from the environment only; the runner holds no server credentials. */
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeExecutor, heldOpen } from './claude/claude-executor.js';
import { checkClaudeStartup, checkRunnerStartup } from './claude/startup-check.js';
import { type PlanUsage, parseSubscriptionKeys, planUsageOf, SubscriptionKeys } from './claude/subscription-keys.js';
import { GithubApi } from './github/github-api.js';
import { type LoadedManifest, loadManifest } from './manifest.js';
import { type PackageRegistry, packageRegistries } from './package-registries.js';
import { secretMasker } from './mask-secrets.js';
import { RunnerApiClient } from './runner-api.js';
import { Runner, type StartupProblem, type StartupReport } from './runner.js';
import { RunnerStartupProblemCode, resolveManifest } from '@coredoc/core/agent-runner';

// Local development only (set by the dev compose service): Claude subscription tokens instead of an API key,
// one token or several as `label:token,label:token`.
const SUBSCRIPTION_TOKENS =
  process.env.CLAUDE_CODE_OAUTH_TOKENS?.trim() || process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || '';
const PLAN_USAGE_READ_TIMEOUT_MS = 30_000;
const PLAN_USAGE_REFRESH_MS = 10 * 60_000;
const DEV_SUBSCRIPTION = process.env.COREDOC_RUNNER_DEV_SUBSCRIPTION === '1' && SUBSCRIPTION_TOKENS !== '';
const REQUIRED = [
  'COREDOC_API_URL',
  'COREDOC_WORKSPACE_ID',
  'COREDOC_RUNNER_TOKEN',
  'COREDOC_GITHUB_TOKEN',
  'COREDOC_GIT_AUTHOR_EMAIL',
  ...(DEV_SUBSCRIPTION ? [] : (['ANTHROPIC_API_KEY'] as const)),
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
// Like the registries: reported through the start-up check, and the runner claims nothing until it is fixed.
let loaded: LoadedManifest = { manifest: resolveManifest(undefined, pluginPath), digest: null, secrets: [] };
let manifestProblem: StartupProblem | null = null;
try {
  loaded = await loadManifest(process.env, pluginPath);
} catch (error) {
  manifestProblem = {
    code: RunnerStartupProblemCode.ManifestInvalid,
    detail: error instanceof Error ? error.message : String(error),
  };
}
const claudeCheck = {
  query,
  manifest: loaded.manifest,
  manifestDigest: loaded.digest,
  scannerPluginPath: pluginPath,
  scratchRoot,
  versions,
};

const shutdown = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log(`${signal} received; winding the current turn down to a checkpoint, then exiting`);
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
  const { versions: checked, problem }: StartupReport = manifestProblem
    ? { versions, problem: manifestProblem }
    : await checkClaudeStartup(claudeCheck);
  const mask = secretMasker([
    ...['ANTHROPIC_API_KEY', 'COREDOC_GITHUB_TOKEN', 'COREDOC_RUNNER_TOKEN'].map((name) => process.env[name]?.trim()),
    // Each entry's token, with or without a label before it.
    ...SUBSCRIPTION_TOKENS.split(',').map((entry) => entry.slice(entry.indexOf(':') + 1).trim()),
  ]);
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
const subscriptionTokens = DEV_SUBSCRIPTION ? parseSubscriptionKeys(SUBSCRIPTION_TOKENS) : [];
const subscriptionKeys = DEV_SUBSCRIPTION ? new SubscriptionKeys(subscriptionTokens) : undefined;
const modelApiKey = DEV_SUBSCRIPTION ? '' : required('ANTHROPIC_API_KEY');
if (DEV_SUBSCRIPTION)
  log(
    `development mode: using ${subscriptionTokens.length} Claude subscription token(s) (${subscriptionTokens.map((key) => key.label).join(', ')}) instead of an API key; never use this outside local testing`,
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
  once: process.env.COREDOC_RUNNER_ONCE === '1',
  executor: new ClaudeExecutor({
    query: ({ prompt, open, options }) => {
      const session = query({ prompt: heldOpen(prompt, open), options });
      return Object.assign(session, {
        planUsage: async () =>
          planUsageOf(await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })),
      });
    },
    api,
    scratchRoot,
    manifest: loaded.manifest,
    scannerPluginPath: pluginPath,
    modelApiKey,
    modelCredentialKind: DEV_SUBSCRIPTION ? 'subscription' : 'api_key',
    subscriptionKeys,
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
  subscriptionKeys: subscriptionKeys && (() => subscriptionKeys.report()),
  secrets: [
    modelApiKey,
    ...subscriptionTokens.map((key) => key.token),
    botToken,
    runnerToken,
    ...registries.map((registry) => registry.token ?? ''),
    ...loaded.secrets,
  ],
  startupCheck: async () =>
    manifestProblem
      ? { versions, problem: manifestProblem }
      : registryProblem
        ? { versions, problem: { code: RunnerStartupProblemCode.RegistryConfigInvalid, detail: registryProblem } }
        : checkRunnerStartup({ ...claudeCheck, github: new GithubApi({ token: botToken }), githubApiUrl }),
  log,
});

/** A session given no input makes no model request; it is open only long enough to answer `/usage`. */
async function readPlanUsage(token: string): Promise<PlanUsage | null> {
  const abort = new AbortController();
  const aborted = new Promise<null>((resolve) =>
    abort.signal.addEventListener('abort', () => resolve(null), { once: true }),
  );
  const timeout = setTimeout(() => abort.abort(), PLAN_USAGE_READ_TIMEOUT_MS);
  await mkdir(scratchRoot, { recursive: true });
  const dir = await mkdtemp(join(scratchRoot, 'usage-'));
  try {
    const session = query({
      prompt: {
        [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: await aborted }) }),
      },
      options: {
        cwd: dir,
        settingSources: [],
        tools: [],
        abortController: abort,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: dir,
          TMPDIR: dir,
          CLAUDE_CONFIG_DIR: dir,
          DISABLE_AUTOUPDATER: '1',
          CLAUDE_CODE_OAUTH_TOKEN: token,
        },
      },
    });
    const usage = await Promise.race([
      session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      aborted,
    ]);
    if (!usage) throw new Error('timed out');
    return planUsageOf(usage);
  } finally {
    clearTimeout(timeout);
    abort.abort();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Every key, so settings show the ones no turn has used yet. */
async function refreshPlanUsage(keys: SubscriptionKeys): Promise<void> {
  for (const { label, token } of subscriptionTokens) {
    try {
      const usage = await readPlanUsage(token);
      if (usage) keys.recordUsage(label, usage);
      else log(`subscription key ${label}: Claude Code reports no plan usage for it`);
    } catch (error) {
      log(`subscription key ${label}: could not read its usage: ${error instanceof Error ? error.message : error}`);
    }
  }
}

log(`starting runner ${versions.runner}`);
if (subscriptionKeys) {
  void refreshPlanUsage(subscriptionKeys);
  setInterval(() => void refreshPlanUsage(subscriptionKeys), PLAN_USAGE_REFRESH_MS).unref();
}
await runner.start(shutdown.signal);
log('stopped');
// A one-turn runner is a Job: an idle SDK or HTTP handle must not keep it from completing.
process.exit(0);
