import { isolatedPlatformPrerequisite } from '../../facts/scip/system-tools.js';
import { appleToolchain } from '../../facts/scip/apple-toolchain.js';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { executableOnPath } from '../../facts/scip/executable.js';
import { outsideSource } from '../../facts/scip/isolated-process.js';

export const GO_SCIP_SETUP =
  'Install the Go SDK and run go install github.com/scip-code/scip-go/cmd/scip-go@v0.2.7, then add its bin directory to PATH. Or choose basic analysis.';
export function goScipTools(repoRoot: string) {
  const go = executableOnPath('go', repoRoot);
  const indexer = executableOnPath('scip-go', repoRoot);
  if (!go || !indexer) throw new Error('Go SDK or scip-go was not found on PATH.');
  // Explicit local toolchain selection prevents Go's automatic SDK downloads during preflight.
  const sdk = execFileSync(go, ['env', 'GOROOT'], {
    encoding: 'utf8',
    timeout: 30_000,
    cwd: '/',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: `${dirname(go)}:/usr/bin:/bin`, GOTOOLCHAIN: 'local', GOENV: 'off' },
  }).trim();
  return { go, indexer, sdk: outsideSource(repoRoot, sdk) };
}
export function goScipPrereqs(repoRoot: string): string | null {
  const gate = isolatedPlatformPrerequisite(
    'Enhanced Go analysis requires macOS or Linux with bubblewrap. Use basic analysis on this platform.',
  );
  if (gate) return gate;
  try {
    appleToolchain(repoRoot);
    goScipTools(repoRoot);
    return null;
  } catch (error) {
    return `${GO_SCIP_SETUP} ${error instanceof Error ? error.message : ''}`;
  }
}
