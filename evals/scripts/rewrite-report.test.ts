import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRunManifest, resolveReportMetadata } from './rewrite-report.js';

const temporaryDirectories: string[] = [];

function temporaryRunDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'coredoc-rewrite-report-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('resolveReportMetadata', () => {
  it('uses run-manifest provenance for target, graph, cohort, models, and harness', () => {
    const runDir = temporaryRunDir();
    writeFileSync(
      join(runDir, 'run-manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        cohortId: 'cohort-123',
        harness: { head: 'harness-sha', dirtyFingerprint: 'dirty' },
        targets: [
          { repoKey: 'zeta', actualVerifierGitSha: 'target-z' },
          { repoKey: 'alpha', actualVerifierGitSha: 'target-a' },
        ],
        graph: {
          backend: 'sqlite',
          repositories: [
            { repoKey: 'zeta', parsedGitSha: 'graph-z' },
            { repoKey: 'alpha', parsedGitSha: 'graph-a' },
          ],
        },
        models: {
          provider: 'codex',
          agentModel: 'gpt-agent',
          judgeProvider: 'codex',
          judgeModel: 'gpt-judge',
        },
        permissionCanary: {
          config: {
            contractVersion: 1,
            queryPolicyHash: 'policy',
            sdkRuntimeHash: 'runtime',
            model: 'gpt-agent',
            maxBudgetUsd: 0.1,
            maxTurns: 12,
            timeoutMs: 120000,
            materialFingerprint: 'material',
          },
          evidence: {
            passed: true,
            materialFingerprint: 'material',
          },
        },
      }),
    );

    const metadata = resolveReportMetadata({
      runDir,
      existingReport: '**Runs:** 2; **wall-clock:** 1.5m\n',
      records: [],
    });

    expect(metadata).toEqual({
      runId: expect.stringMatching(/^coredoc-rewrite-report-test-/),
      agentModel: 'codex:gpt-agent',
      judgeModel: 'codex:gpt-judge',
      wallClockMs: 90_000,
      commit: 'harness-sha',
      provider: 'codex',
      backend: 'sqlite',
      actualTargetSha: 'alpha=target-a, zeta=target-z',
      graphParsedSha: 'alpha=graph-a, zeta=graph-z',
      cohortId: 'cohort-123',
    });
    expect(readRunManifest(runDir)?.permissionCanary).toMatchObject({
      config: { materialFingerprint: 'material' },
      evidence: { passed: true, materialFingerprint: 'material' },
    });
  });

  it('keeps legacy results readable and labels unavailable provenance explicitly', () => {
    const runDir = temporaryRunDir();
    const metadata = resolveReportMetadata({
      runDir,
      existingReport: [
        '**Models:** old-agent (agent), old-judge (judge)',
        '**Runs:** 1; **wall-clock:** 0.5m',
        '**Commit:** `old-harness`',
      ].join('\n'),
      records: [],
    });

    expect(metadata).toMatchObject({
      agentModel: 'old-agent',
      judgeModel: 'old-judge',
      wallClockMs: 30_000,
      commit: 'old-harness',
      actualTargetSha: 'unknown (legacy: no run-manifest.json)',
      graphParsedSha: 'unknown (legacy: no run-manifest.json)',
      cohortId: 'unknown (legacy: no run-manifest.json)',
    });
  });
});
