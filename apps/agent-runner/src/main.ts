#!/usr/bin/env node
/**
 * Agent runner entry point. Configuration comes from the environment only;
 * the runner holds the customer's model key, the workspace's runner token and
 * (from ticket 06) the bot's GitHub token, and nothing of the server's.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeExecutor } from './claude/claude-executor.js';
import { checkClaudeStartup } from './claude/startup-check.js';
import { RunnerApiClient } from './runner-api.js';
import { Runner } from './runner.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`[agent-runner] ${name} is required`);
    process.exit(2);
  }
  return value;
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
};

const scratchRoot = process.env.COREDOC_RUNNER_SCRATCH?.trim() || '/scratch';
const pluginPath = process.env.COREDOC_WORKFLOWS_PLUGIN_PATH?.trim() || '/opt/coredoc-workflows';
const api = new RunnerApiClient({
  baseUrl: required('COREDOC_API_URL'),
  workspaceId: required('COREDOC_WORKSPACE_ID'),
  token: required('COREDOC_RUNNER_TOKEN'),
});
const runner = new Runner({
  api,
  executor: new ClaudeExecutor({
    query,
    api,
    scratchRoot,
    pluginPath,
    modelApiKey: required('ANTHROPIC_API_KEY'),
    modelBaseUrl: process.env.ANTHROPIC_BASE_URL?.trim() || undefined,
    hostEnv: process.env,
    log,
  }),
  versions,
  startupCheck: () => checkClaudeStartup({ query, pluginPath, scratchRoot, versions }),
  log,
});

const shutdown = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log(`${signal} received; stopping after the current turn`);
    shutdown.abort();
  });
}

log(`starting runner ${versions.runner}`);
await runner.start(shutdown.signal);
log('stopped');
