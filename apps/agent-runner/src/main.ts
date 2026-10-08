#!/usr/bin/env node
/**
 * Agent runner entry point. Configuration comes from the environment only;
 * the runner holds the workspace's runner token and nothing of the server's.
 */
import { readFileSync } from 'node:fs';
import { RunnerApiClient } from './runner-api.js';
import { Runner } from './runner.js';
import { SkeletonExecutor } from './skeleton-executor.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`[agent-runner] ${name} is required`);
    process.exit(2);
  }
  return value;
}

function runnerVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version?: string;
  };
  return manifest.version ?? '0.0.0';
}

const log = (message: string) => console.log(`[agent-runner] ${message}`);
const versions = { runner: runnerVersion() };
const runner = new Runner({
  api: new RunnerApiClient({
    baseUrl: required('COREDOC_API_URL'),
    workspaceId: required('COREDOC_WORKSPACE_ID'),
    token: required('COREDOC_RUNNER_TOKEN'),
  }),
  executor: new SkeletonExecutor(),
  versions,
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
