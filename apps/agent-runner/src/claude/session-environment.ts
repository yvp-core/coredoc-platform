/**
 * Claude Code's environment, built explicitly rather than inherited: it keeps
 * the bot's token and the runner token out of `env` output, transcripts and
 * commits. Hygiene, not a boundary — everything in the pod runs as one user.
 */
import type { TurnPaths } from './turn-paths.js';

/** Host variables passed through when set: locale, proxies and CA bundles. */
const PASSTHROUGH = [
  'LANG',
  'LC_ALL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
];

export interface SessionEnvironmentInput {
  hostEnv: NodeJS.ProcessEnv;
  paths: TurnPaths;
  sessionId: string;
  modelApiKey: string;
  modelBaseUrl?: string;
  /** Long enough for the plugin to suspend its run at session end. */
  sessionEndHookTimeoutMs: number;
}

export function sessionEnvironment(input: SessionEnvironmentInput): Record<string, string> {
  const env: Record<string, string> = {
    PATH: input.hostEnv.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: input.paths.home,
    TMPDIR: input.paths.tmp,
    LANG: 'C.UTF-8',
    CLAUDE_CONFIG_DIR: input.paths.claudeConfig,
    ANTHROPIC_API_KEY: input.modelApiKey,
    // Opt-outs: non-essential traffic, telemetry, error reporting, auto-update, Claude.ai connectors.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    // Tool search off, so AskUserQuestion and the run-control tools need no search step.
    ENABLE_TOOL_SEARCH: 'false',
    CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: String(input.sessionEndHookTimeoutMs),
    // The plugin: its state home (archived), hosted mode, and the session id so resumed turns stay attributed.
    COREDOC_WORKFLOWS_STATE_HOME: input.paths.pluginStateHome,
    COREDOC_WORKFLOWS_HOSTED: '1',
    COREDOC_WORKFLOWS_SESSION_ID: input.sessionId,
  };
  for (const name of PASSTHROUGH) {
    const value = input.hostEnv[name];
    if (value) env[name] = value;
  }
  if (input.modelBaseUrl) env.ANTHROPIC_BASE_URL = input.modelBaseUrl;
  return env;
}
