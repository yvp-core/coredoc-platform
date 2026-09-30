import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CodexExecOptions {
  executablePath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  model: string;
  prompt: string;
  timeoutMs?: number;
  readFinalResponse?: (outputPath: string) => string;
}

const MAX_STDERR_BYTES = 16_384;
const DEFAULT_TIMEOUT_MS = 60 * 60_000;

/**
 * While persistence is on (the current default), summarize runs are recorded as ordinary Codex
 * rollouts so external session viewers can render and debug them. Set
 * COREDOC_CODEX_PERSIST_SESSIONS=false to restore fully ephemeral runs. The default is planned
 * to flip to false a few releases from now — keep it in sync with the same flag in the desktop's
 * codex-app-server client.
 */
export function codexSessionPersistenceEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.COREDOC_CODEX_PERSIST_SESSIONS?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(
    `COREDOC_CODEX_PERSIST_SESSIONS must be "true" or "false", got "${env.COREDOC_CODEX_PERSIST_SESSIONS}".`,
  );
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams): void {
  if (process.platform !== 'win32' && child.pid && child.spawnargs?.[1] === 'exec') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // The child may already have exited.
    }
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

/** Run Codex non-interactively with only the minimal filesystem needed to answer a prompt. */
export function runCodexExec(options: CodexExecOptions): Promise<string> {
  const outputPath = path.join(options.env.CODEX_HOME ?? options.cwd, `summary-${randomUUID()}.txt`);
  const args = [
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--strict-config',
    '--skip-git-repo-check',
    ...(codexSessionPersistenceEnabled(options.env) ? [] : ['--ephemeral']),
    '--color',
    'never',
    '--model',
    options.model,
    '--output-last-message',
    outputPath,
    '-c',
    'project_doc_max_bytes=0',
    '-c',
    'approval_policy="never"',
    '-c',
    'default_permissions="coredoc-summarize"',
    '-c',
    'permissions={"coredoc-summarize"={filesystem={":root"="deny",":minimal"="read"},network={enabled=false}}}',
    '-c',
    'features.apps=false',
    '-c',
    'features.multi_agent=false',
    '-c',
    'features.plugins=false',
    '-c',
    'features.shell_tool=false',
    '-c',
    'features.skill_mcp_dependency_install=false',
    '-c',
    'web_search="disabled"',
    '--cd',
    options.cwd,
    '-',
  ];
  const child = spawn(options.executablePath, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    shell: false,
    windowsHide: true,
  });

  return new Promise<string>((resolve, reject) => {
    let stderr = '';
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
    };
    const timeout = setTimeout(() => {
      terminateProcessTree(child);
      finish(new Error('System Codex timed out while generating a summary.'));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timeout.unref();

    child.stdout.resume();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
    });
    child.once('error', (error) => finish(error));
    child.stdin.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const detail = stderr.trim();
        finish(
          new Error(
            `System Codex exited before producing a summary (${signal ?? code ?? 'unknown'}).${detail ? ` ${detail}` : ''}`,
          ),
        );
        return;
      }
      try {
        const response = (options.readFinalResponse ?? ((file) => fs.readFileSync(file, 'utf8')))(outputPath);
        if (!response) throw new Error('No response from model');
        settled = true;
        clearTimeout(timeout);
        resolve(response);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdin.end(options.prompt);
  });
}
