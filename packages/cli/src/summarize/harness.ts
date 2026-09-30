/**
 * CLI-side harness selection for `coredoc summarize`.
 *
 * The desktop Settings screen persists the selected local harness as
 * COREDOC_HARNESS_PROVIDER / COREDOC_HARNESS_AUTH_MODE (plus per-provider API tokens) in the same
 * `.env` files the CLI loads at startup. This module honors that contract for direct CLI runs:
 * it resolves the selected harness from the environment and builds the subprocess env the same
 * way the desktop main process does (apps/desktop/src/main/harness-settings.ts — keep the
 * credential-key list below in sync with its CREDENTIAL_ENV_KEYS).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SummarizeHarness } from './text-generator.js';

export enum HarnessAuthMode {
  Subscription = 'subscription',
  ApiToken = 'api-token',
}

export interface HarnessSelection {
  harness: SummarizeHarness;
  authMode: HarnessAuthMode;
  /** Absolute path to the system Codex executable (codex harness only). */
  codexCliPath?: string;
  /**
   * Environment for the harness subprocess: ambient provider credentials removed so the selected
   * auth mode really decides authentication, with the configured token injected in api-token mode.
   */
  sdkEnv: NodeJS.ProcessEnv;
}

const PROVIDER_ENV_KEY = 'COREDOC_HARNESS_PROVIDER';
const AUTH_MODE_ENV_KEY = 'COREDOC_HARNESS_AUTH_MODE';
const CLAUDE_TOKEN_ENV_KEY = 'COREDOC_CLAUDE_API_TOKEN';
const CODEX_TOKEN_ENV_KEY = 'COREDOC_CODEX_API_TOKEN';

const CREDENTIAL_ENV_KEYS = new Set([
  'CLAUDE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
  'CODEX_HOME',
  CLAUDE_TOKEN_ENV_KEY,
  CODEX_TOKEN_ENV_KEY,
]);

function parseAuthMode(raw: string): HarnessAuthMode {
  if (raw === HarnessAuthMode.Subscription) return HarnessAuthMode.Subscription;
  if (raw === HarnessAuthMode.ApiToken) return HarnessAuthMode.ApiToken;
  throw new Error(
    `${AUTH_MODE_ENV_KEY} must be "${HarnessAuthMode.Subscription}" or "${HarnessAuthMode.ApiToken}", got "${raw}".`,
  );
}

/** Locate the `codex` binary via PATH, mirroring how a shell would resolve it. */
export function findCodexExecutable(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const binary = platform === 'win32' ? 'codex.exe' : 'codex';
  for (const directory of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(directory, binary);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      if (platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not present or not executable in this PATH entry — keep looking.
    }
  }
  return null;
}

/**
 * Resolve the summarize harness selected via environment variables.
 *
 * Returns undefined when COREDOC_HARNESS_PROVIDER is unset, preserving the CLI's historical
 * Claude Code default untouched. Any invalid value, missing api-token credential, or missing
 * Codex executable throws instead of silently falling back.
 */
export function resolveSummarizeHarness(env: NodeJS.ProcessEnv): HarnessSelection | undefined {
  const rawProvider = env[PROVIDER_ENV_KEY]?.trim();
  if (!rawProvider) return undefined;
  if (rawProvider !== 'claude-code' && rawProvider !== 'codex') {
    throw new Error(`${PROVIDER_ENV_KEY} must be "claude-code" or "codex", got "${rawProvider}".`);
  }

  const rawAuthMode = env[AUTH_MODE_ENV_KEY]?.trim();
  const authMode = rawAuthMode ? parseAuthMode(rawAuthMode) : HarnessAuthMode.Subscription;

  const sdkEnv: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(sdkEnv)) {
    if (CREDENTIAL_ENV_KEYS.has(key.toUpperCase())) delete sdkEnv[key];
  }

  if (authMode === HarnessAuthMode.ApiToken) {
    const tokenKey = rawProvider === 'codex' ? CODEX_TOKEN_ENV_KEY : CLAUDE_TOKEN_ENV_KEY;
    const token = env[tokenKey]?.trim();
    if (!token) {
      throw new Error(`${AUTH_MODE_ENV_KEY}="${HarnessAuthMode.ApiToken}" requires ${tokenKey} to be set.`);
    }
    if (rawProvider === 'codex') sdkEnv.CODEX_API_KEY = token;
    else sdkEnv.ANTHROPIC_API_KEY = token;
  }

  if (rawProvider === 'codex') {
    const codexCliPath = findCodexExecutable(env);
    if (!codexCliPath) {
      throw new Error(
        `${PROVIDER_ENV_KEY}="codex" is set, but no \`codex\` executable was found on PATH. ` +
          'Install the Codex CLI or unset the variable.',
      );
    }
    return { harness: 'codex', authMode, codexCliPath, sdkEnv };
  }
  return { harness: 'claude-code', authMode, sdkEnv };
}
