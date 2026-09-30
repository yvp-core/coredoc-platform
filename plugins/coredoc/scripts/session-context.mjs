#!/usr/bin/env node
// Stamps session→work-item join keys onto the coredoc agent_sessions row:
// SessionStart → {repoKey, branch, issueKey (Jira key parsed from branch name), headShaStart};
// SessionEnd → {headShaEnd};
// PostToolUse(Bash) after `gh pr create` → {prNumber}.
// Fail-open: missing telemetry env, non-git cwd, or any error → silent exit 0.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ISSUE_KEY_RE = /([A-Za-z][A-Za-z0-9]{1,9}-\d+)/;

export function telemetryTargetFromEnv(env) {
  const captureEndpoint = env.COREDOC_CAPTURE_ENDPOINT ?? '';
  const captureHeaders = env.COREDOC_CAPTURE_HEADERS ?? '';
  const captureMatch = captureEndpoint.match(/^(.*)\/workspaces\/([^/]+)\/capture\/v1\/events$/);
  const relayEndpoint = env.COREDOC_NATIVE_OTLP_FORWARD_ENDPOINT ?? '';
  const relayMatch = relayEndpoint.match(/^(.*)\/workspaces\/([^/]+)\/otel\/v1\/logs$/);
  const legacyEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '';
  const otelHeaders = env.OTEL_EXPORTER_OTLP_HEADERS ?? '';
  const legacyMatch = legacyEndpoint.match(/^(.*)\/workspaces\/([^/]+)\/otel$/);
  const m = captureMatch ?? relayMatch ?? legacyMatch;
  const headers = captureMatch ? captureHeaders : otelHeaders;
  const t = headers.match(/Authorization=Bearer\s+(\S+)/);
  if (!m || !t) return null;
  return { apiBase: m[1], workspaceId: m[2], token: t[1] };
}

function telemetryTarget() {
  return telemetryTargetFromEnv(process.env);
}

async function git(cwd, ...args) {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 3000 });
    return stdout.trim();
  } catch {
    return '';
  }
}

/** Full path after the host (minus .git) — keeps nested namespaces like group/sub/repo intact. */
export function repoKeyFromOrigin(origin) {
  if (!origin) return undefined;
  let path = origin.replace(/\.git$/, '');
  // scp-style (git@host:group/sub/repo) only when there is no scheme — ssh:// URLs carry ports.
  const scp = !/^[a-z+]+:\/\//i.test(path) && path.match(/^[^@]+@[^:]+:(.+)$/);
  if (scp) {
    path = scp[1];
  } else {
    try {
      path = new URL(path).pathname.replace(/^\/+/, '');
    } catch {
      /* not a URL — keep as-is */
    }
  }
  return path || undefined;
}

async function contextFromSessionStart(evt) {
  const cwd = String(evt?.cwd ?? process.cwd());
  const branch = await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (!branch || branch === 'HEAD') return null; // not a git repo, or detached HEAD
  const origin = await git(cwd, 'config', '--get', 'remote.origin.url');
  const repoKey = repoKeyFromOrigin(origin);
  const issueKey = branch.match(ISSUE_KEY_RE)?.[1]?.toUpperCase();
  const headSha = await git(cwd, 'rev-parse', 'HEAD');
  return { repoKey, branch, issueKey, headShaStart: headSha || undefined };
}

function contextFromPostToolUse(evt) {
  const cmd = String(evt?.tool_input?.command ?? '');
  if (!/\bgh\s+pr\s+create\b/.test(cmd)) return null;
  const resp = typeof evt?.tool_response === 'string' ? evt.tool_response : JSON.stringify(evt?.tool_response ?? '');
  const pr = resp.match(/\/pull\/(\d+)/)?.[1];
  return pr ? { prNumber: Number(pr) } : null;
}

async function contextFromSessionEnd(evt) {
  const cwd = String(evt?.cwd ?? process.cwd());
  const headSha = await git(cwd, 'rev-parse', 'HEAD');
  return headSha ? { headShaEnd: headSha } : null;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const evt = JSON.parse(input || '{}');
  const sessionId = String(evt?.session_id ?? '');
  if (!sessionId) return;

  const ctx =
    evt?.hook_event_name === 'SessionStart'
      ? await contextFromSessionStart(evt)
      : evt?.hook_event_name === 'SessionEnd'
        ? await contextFromSessionEnd(evt)
        : contextFromPostToolUse(evt);
  if (!ctx) return;

  const target = telemetryTarget();
  if (!target) return; // telemetry not configured for this project

  const url = `${target.apiBase}/workspaces/${target.workspaceId}/sessions/${encodeURIComponent(sessionId)}/context`;
  if (process.env.COREDOC_CONTEXT_DRY_RUN === '1') {
    process.stderr.write(`coredoc session-context dry-run: POST ${url} ${JSON.stringify(ctx)}\n`);
    return;
  }
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${target.token}` },
    body: JSON.stringify(ctx),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => {
    /* fail-open */
  });
}
