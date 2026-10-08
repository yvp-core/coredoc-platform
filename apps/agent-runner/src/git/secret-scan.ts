/**
 * The plugin's secret preflight, called by the host on one clone with an
 * explicit git directory (plugin contract item 7). `commit` scans the staged
 * change and the message; `push` scans the outbound commits and needs the
 * bot's credentials in the environment for its live read of the remote.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

export interface ScanFinding {
  id: string;
  path?: string | null;
  line?: number | null;
}

export interface ScanVerdict {
  verdict: string;
  reason: string | null;
  findings: ScanFinding[];
  binaryPaths: string[];
}

/** Push preflight reasons that mean the remote branch moved under the run: someone else pushed. */
export const REMOTE_MOVED_REASONS: ReadonlySet<string> = new Set(['non-fast-forward-push', 'remote-head-needs-fetch']);

const TIMEOUT_MS = 2 * 60_000;

/** Blocked, or needs-action with credential findings; a binary-only review is listed for a person instead. */
export function blocksPush(verdict: ScanVerdict): boolean {
  return verdict.verdict === 'blocked' || (verdict.verdict === 'needs-action' && verdict.findings.length > 0);
}

/** The blocked paths and rule ids, never the content. */
export function describeBlock(repository: string, verdict: ScanVerdict): string[] {
  if (verdict.findings.length === 0) return [`${repository}: ${verdict.reason ?? 'blocked by the secret scan'}`];
  return verdict.findings.map(
    (finding) =>
      `${repository}: ${finding.path ?? '(commit message)'}${finding.line ? `:${finding.line}` : ''} (${finding.id})`,
  );
}

export class SecretScanner {
  constructor(private readonly pluginPath: string) {}

  commit(dir: string, messageFile: string, env: Record<string, string>): Promise<ScanVerdict> {
    return this.preflight(dir, ['--operation', 'commit', '--message-file', messageFile], env);
  }

  push(dir: string, base: string, branch: string, env: Record<string, string>): Promise<ScanVerdict> {
    return this.preflight(dir, ['--operation', 'push', '--base', base, '--expected-branch', branch], env);
  }

  private async preflight(dir: string, args: string[], env: Record<string, string>): Promise<ScanVerdict> {
    const launcher = join(this.pluginPath, 'bin', 'coredoc-workflows');
    const stdout = await new Promise<string>((resolve) => {
      const child = spawn(launcher, ['git-delivery-preflight', ...args], {
        cwd: dir,
        env: { ...env, GIT_DIR: join(dir, '.git'), GIT_WORK_TREE: dir },
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: TIMEOUT_MS,
      });
      const chunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.on('error', () => resolve(''));
      child.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    return parseVerdict(stdout);
  }
}

/** The last JSON line; anything unreadable blocks, because an unscanned change is never pushed. */
function parseVerdict(stdout: string): ScanVerdict {
  const line = stdout.trim().split('\n').at(-1) ?? '';
  try {
    const parsed = JSON.parse(line) as {
      verdict?: unknown;
      reason?: unknown;
      scan?: { findings?: unknown; binaryPaths?: unknown };
    };
    if (typeof parsed.verdict !== 'string') throw new Error('no verdict');
    const findings = Array.isArray(parsed.scan?.findings) ? (parsed.scan.findings as ScanFinding[]) : [];
    const binaryPaths = Array.isArray(parsed.scan?.binaryPaths)
      ? (parsed.scan.binaryPaths as unknown[]).filter((path): path is string => typeof path === 'string')
      : [];
    return {
      verdict: parsed.verdict,
      reason: typeof parsed.reason === 'string' ? parsed.reason : null,
      findings: findings.map((finding) => ({
        id: String(finding.id ?? 'secret'),
        path: typeof finding.path === 'string' ? finding.path : null,
        line: typeof finding.line === 'number' ? finding.line : null,
      })),
      binaryPaths,
    };
  } catch {
    return { verdict: 'blocked', reason: 'preflight-output-unreadable', findings: [], binaryPaths: [] };
  }
}
